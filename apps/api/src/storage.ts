import type {
  CanonicalContentMetadata,
  ContentMetadata,
  Env,
  MultipartUploadSession,
  ShareKind,
  StoredContent,
} from "./types"

const KV_SIZE_LIMIT = 25 * 1024
const CANONICAL_PREFIX = "canonical:"
const LEGACY_PREFIX = "content:"
const MULTIPART_PREFIX = "multipart:"
const SESSION_TTL_SECONDS = 60 * 60

type CanonicalRow = {
  id: string
  type: ShareKind
  name: string | null
  size: number
  views: number
  burned: number
  encrypted: number
  storageKey: string
  storageType: "kv" | "r2"
  deleteToken: string
  contentType: string
  filename: string | null
  maxViews: number | null
  inlineBody: string | null
  inlineBodyEncoding: "utf8" | "base64" | null
  lastAccessedAt: string | null
  expiresAt: string | null
  createdAt: string
}

type MultipartSessionRow = {
  id: string
  uploadId: string
  resumeToken: string
  deleteToken: string
  contentType: string
  filename: string | null
  expire: string | null
  ttlSeconds: number | null
  burn: number
  name: string | null
  encrypted: number
  partSize: number
  createdAt: string
  expiresAt: string | null
}

type MultipartPartRow = {
  partNumber: number
  etag: string
  sha256: string
  size: number
}

function hasD1(env: Env): boolean {
  return typeof env.DB?.prepare === "function"
}

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  return env.CONTENT.get<T>(key, "json")
}

function inferShareKind(contentType: string): ShareKind {
  if (contentType === "application/json") {
    return "json"
  }
  if (contentType === "text/markdown") {
    return "markdown"
  }
  if (contentType.startsWith("image/")) {
    return "image"
  }
  if (contentType.startsWith("text/")) {
    return "text"
  }
  return "binary"
}

function ttlOptions(expiresAt: string | null): KVNamespacePutOptions {
  if (!expiresAt) {
    return {}
  }

  const ttl = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
  return ttl > 0 ? { expirationTtl: ttl } : {}
}

function isExpired(expiresAt: string | null | undefined): boolean {
  return typeof expiresAt === "string" && new Date(expiresAt).getTime() <= Date.now()
}

function toCanonicalMetadata(row: CanonicalRow): CanonicalContentMetadata {
  return {
    id: row.id,
    type: row.type,
    deleteToken: row.deleteToken,
    contentType: row.contentType,
    size: row.size,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    views: row.views,
    maxViews: row.maxViews ?? undefined,
    name: row.name,
    filename: row.filename ?? undefined,
    storageType: row.storageType,
    encrypted: Boolean(row.encrypted),
    burned: Boolean(row.burned),
    storageKey: row.storageKey,
    inlineBody: row.inlineBody,
    inlineBodyEncoding: row.inlineBodyEncoding,
    lastAccessedAt: row.lastAccessedAt,
  }
}

async function getCanonicalRow(env: Env, id: string): Promise<CanonicalRow | null> {
  if (hasD1(env)) {
    const row = await env.DB.prepare(
      `SELECT
        id,
        type,
        name,
        size,
        views,
        burned,
        encrypted,
        storage_key AS storageKey,
        storage_type AS storageType,
        delete_token AS deleteToken,
        content_type AS contentType,
        filename,
        max_views AS maxViews,
        inline_body AS inlineBody,
        inline_body_encoding AS inlineBodyEncoding,
        last_accessed_at AS lastAccessedAt,
        expires_at AS expiresAt,
        created_at AS createdAt
      FROM shares
      WHERE id = ?
      LIMIT 1`
    ).bind(id).first<CanonicalRow>()

    if (!row) {
      return null
    }

    if (isExpired(row.expiresAt)) {
      await deleteCanonicalShare(env, row.id, row)
      return null
    }

    return row
  }

  const stored = await getJson<StoredContent>(env, `${CANONICAL_PREFIX}${id}`)
  if (!stored?.metadata) {
    return null
  }

  if (isExpired(stored.metadata.expiresAt)) {
    await env.CONTENT.delete(`${CANONICAL_PREFIX}${id}`)
    return null
  }

  return {
    id: stored.metadata.id,
    type: inferShareKind(stored.metadata.contentType),
    name: stored.metadata.name ?? null,
    size: stored.metadata.size,
    views: stored.metadata.views,
    burned: 0,
    encrypted: stored.metadata.encrypted ? 1 : 0,
    storageKey: stored.metadata.id,
    storageType: stored.metadata.storageType,
    deleteToken: stored.metadata.deleteToken,
    contentType: stored.metadata.contentType,
    filename: stored.metadata.filename ?? null,
    maxViews: stored.metadata.maxViews ?? null,
    inlineBody: stored.content ?? null,
    inlineBodyEncoding: stored.metadata.encrypted ? "base64" : "utf8",
    lastAccessedAt: null,
    expiresAt: stored.metadata.expiresAt,
    createdAt: stored.metadata.createdAt,
  }
}

async function getLegacyStored(env: Env, id: string): Promise<StoredContent | null> {
  const stored = await getJson<StoredContent>(env, `${LEGACY_PREFIX}${id}`)
  if (!stored?.metadata) {
    return null
  }

  if (isExpired(stored.metadata.expiresAt)) {
    await deleteLegacyContent(env, id, stored)
    return null
  }

  return stored
}

async function deleteCanonicalShare(
  env: Env,
  id: string,
  row?: CanonicalRow | null
): Promise<boolean> {
  const existing = row ?? await getCanonicalRow(env, id)
  if (!existing) {
    return false
  }

  if (hasD1(env)) {
    if (existing.storageType === "r2") {
      await env.STORAGE.delete(existing.storageKey || id)
    }
    await env.DB.prepare("DELETE FROM shares WHERE id = ?").bind(id).run()
    return true
  }

  if (existing.storageType === "r2") {
    await env.STORAGE.delete(existing.storageKey || id)
  }
  await env.CONTENT.delete(`${CANONICAL_PREFIX}${id}`)
  return true
}

async function deleteLegacyContent(
  env: Env,
  id: string,
  stored?: StoredContent | null
): Promise<boolean> {
  const existing = stored ?? await getLegacyStored(env, id)
  if (!existing) {
    return false
  }

  if (existing.metadata.storageType === "r2") {
    await env.STORAGE.delete(id)
  }
  await env.CONTENT.delete(`${LEGACY_PREFIX}${id}`)
  return true
}

function buildStoredContent(
  metadata: ContentMetadata,
  content?: string
): StoredContent {
  return {
    metadata: {
      ...metadata,
      name: metadata.name ?? null,
    },
    content,
  }
}

export async function shareExists(env: Env, id: string): Promise<boolean> {
  const canonical = await getCanonicalRow(env, id)
  if (canonical) {
    return true
  }

  if (hasD1(env)) {
    const multipart = await env.DB.prepare("SELECT id FROM multipart_sessions WHERE id = ? LIMIT 1")
      .bind(id)
      .first<{ id: string }>()
    if (multipart) {
      return true
    }
  } else {
    const multipart = await env.CONTENT.get(`${MULTIPART_PREFIX}${id}`)
    if (multipart) {
      return true
    }
  }

  return Boolean(await env.CONTENT.get(`${LEGACY_PREFIX}${id}`))
}

export async function storeContent(
  env: Env,
  id: string,
  content: string,
  metadata: ContentMetadata
): Promise<void> {
  const contentSize = new TextEncoder().encode(content).length
  const storageType = contentSize <= KV_SIZE_LIMIT ? "kv" : "r2"
  metadata.storageType = storageType

  if (hasD1(env)) {
    if (storageType === "r2") {
      await env.STORAGE.put(id, content, {
        customMetadata: {
          contentType: metadata.contentType,
          filename: metadata.filename ?? "",
        },
      })
    }

    await env.DB.prepare(
      `INSERT INTO shares (
        id,
        type,
        name,
        size,
        views,
        burned,
        encrypted,
        storage_key,
        storage_type,
        delete_token,
        content_type,
        filename,
        max_views,
        inline_body,
        inline_body_encoding,
        last_accessed_at,
        expires_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      metadata.id,
      inferShareKind(metadata.contentType),
      metadata.name ?? null,
      metadata.size,
      metadata.views,
      0,
      metadata.encrypted ? 1 : 0,
      id,
      storageType,
      metadata.deleteToken,
      metadata.contentType,
      metadata.filename ?? null,
      metadata.maxViews ?? null,
      storageType === "kv" ? content : null,
      metadata.encrypted ? "base64" : "utf8",
      null,
      metadata.expiresAt,
      metadata.createdAt
    ).run()
    return
  }

  if (storageType === "r2") {
    await env.STORAGE.put(id, content, {
      customMetadata: {
        contentType: metadata.contentType,
        filename: metadata.filename ?? "",
      },
    })
    await env.CONTENT.put(
      `${CANONICAL_PREFIX}${id}`,
      JSON.stringify(buildStoredContent(metadata)),
      ttlOptions(metadata.expiresAt)
    )
    return
  }

  await env.CONTENT.put(
    `${CANONICAL_PREFIX}${id}`,
    JSON.stringify(buildStoredContent(metadata, content)),
    ttlOptions(metadata.expiresAt)
  )
}

export async function storeBlobMetadata(
  env: Env,
  metadata: ContentMetadata,
  storageKey = metadata.id
): Promise<void> {
  metadata.storageType = "r2"

  if (hasD1(env)) {
    await env.DB.prepare(
      `INSERT INTO shares (
        id,
        type,
        name,
        size,
        views,
        burned,
        encrypted,
        storage_key,
        storage_type,
        delete_token,
        content_type,
        filename,
        max_views,
        inline_body,
        inline_body_encoding,
        last_accessed_at,
        expires_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      metadata.id,
      inferShareKind(metadata.contentType),
      metadata.name ?? null,
      metadata.size,
      metadata.views,
      0,
      metadata.encrypted ? 1 : 0,
      storageKey,
      "r2",
      metadata.deleteToken,
      metadata.contentType,
      metadata.filename ?? null,
      metadata.maxViews ?? null,
      null,
      null,
      null,
      metadata.expiresAt,
      metadata.createdAt
    ).run()
    return
  }

  await env.CONTENT.put(
    `${CANONICAL_PREFIX}${metadata.id}`,
    JSON.stringify(buildStoredContent(metadata)),
    ttlOptions(metadata.expiresAt)
  )
}

export async function getContent(
  env: Env,
  id: string
): Promise<{ metadata: ContentMetadata; content: string } | null> {
  const canonical = await getCanonicalRow(env, id)
  if (canonical) {
    const metadata = toCanonicalMetadata(canonical)
    if (canonical.storageType === "kv") {
      return { metadata, content: canonical.inlineBody ?? "" }
    }

    const r2Object = await env.STORAGE.get(canonical.storageKey || id)
    if (!r2Object) {
      return null
    }

    return { metadata, content: await r2Object.text() }
  }

  const stored = await getLegacyStored(env, id)
  if (!stored) {
    return null
  }

  if (stored.metadata.storageType === "kv" && stored.content !== undefined) {
    return { metadata: stored.metadata, content: stored.content }
  }

  const r2Object = await env.STORAGE.get(id)
  if (!r2Object) {
    return null
  }

  return { metadata: stored.metadata, content: await r2Object.text() }
}

export async function getContentStream(
  env: Env,
  id: string
): Promise<{ metadata: ContentMetadata; body: ReadableStream } | null> {
  const canonical = await getCanonicalRow(env, id)
  if (canonical) {
    const metadata = toCanonicalMetadata(canonical)
    if (canonical.storageType === "kv") {
      const encoder = new TextEncoder()
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(canonical.inlineBody ?? ""))
          controller.close()
        },
      })
      return { metadata, body }
    }

    const r2Object = await env.STORAGE.get(canonical.storageKey || id)
    if (!r2Object?.body) {
      return null
    }

    return { metadata, body: r2Object.body }
  }

  const stored = await getLegacyStored(env, id)
  if (!stored) {
    return null
  }

  if (stored.metadata.storageType === "kv" && stored.content !== undefined) {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(stored.content ?? ""))
        controller.close()
      },
    })
    return { metadata: stored.metadata, body }
  }

  const r2Object = await env.STORAGE.get(id)
  if (!r2Object?.body) {
    return null
  }

  return { metadata: stored.metadata, body: r2Object.body }
}

export async function getMetadata(
  env: Env,
  id: string
): Promise<ContentMetadata | null> {
  const canonical = await getCanonicalRow(env, id)
  if (canonical) {
    return toCanonicalMetadata(canonical)
  }

  const stored = await getLegacyStored(env, id)
  return stored?.metadata ?? null
}

export async function incrementViews(
  env: Env,
  id: string
): Promise<void> {
  const canonical = await getCanonicalRow(env, id)
  if (canonical) {
    if (hasD1(env)) {
      await env.DB.prepare(
        `UPDATE shares
        SET views = views + 1, last_accessed_at = ?
        WHERE id = ?`
      ).bind(new Date().toISOString(), id).run()
      return
    }

    const stored = await getJson<StoredContent>(env, `${CANONICAL_PREFIX}${id}`)
    if (!stored?.metadata) {
      return
    }
    stored.metadata.views += 1
    await env.CONTENT.put(
      `${CANONICAL_PREFIX}${id}`,
      JSON.stringify(stored),
      ttlOptions(stored.metadata.expiresAt)
    )
    return
  }

  const stored = await getLegacyStored(env, id)
  if (!stored) {
    return
  }

  stored.metadata.views += 1
  await env.CONTENT.put(
    `${LEGACY_PREFIX}${id}`,
    JSON.stringify(stored),
    ttlOptions(stored.metadata.expiresAt)
  )
}

export async function deleteContent(env: Env, id: string): Promise<boolean> {
  const deletedCanonical = await deleteCanonicalShare(env, id)
  if (deletedCanonical) {
    return true
  }

  return deleteLegacyContent(env, id)
}

export async function validateDeleteToken(
  env: Env,
  id: string,
  token: string
): Promise<boolean> {
  const canonical = await getCanonicalRow(env, id)
  if (canonical) {
    return canonical.deleteToken === token
  }

  const metadata = await getMetadata(env, id)
  return metadata?.deleteToken === token
}

export async function createMultipartSession(
  env: Env,
  session: MultipartUploadSession
): Promise<void> {
  if (hasD1(env)) {
    await env.DB.prepare(
      `INSERT INTO multipart_sessions (
        id,
        upload_id,
        resume_token,
        delete_token,
        content_type,
        filename,
        expire,
        ttl_seconds,
        burn,
        name,
        encrypted,
        part_size,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      session.id,
      session.uploadId,
      session.resumeToken,
      session.deleteToken,
      session.contentType,
      session.filename ?? null,
      session.expire ?? null,
      session.ttlSeconds ?? null,
      session.burn ? 1 : 0,
      session.name ?? null,
      session.encrypted ? 1 : 0,
      session.partSize,
      session.createdAt,
      session.expiresAt ?? null
    ).run()
    return
  }

  await env.CONTENT.put(
    `${MULTIPART_PREFIX}${session.id}`,
    JSON.stringify(session),
    { expirationTtl: SESSION_TTL_SECONDS }
  )
}

function sessionIsStale(session: Pick<MultipartUploadSession, "createdAt">): boolean {
  return new Date(session.createdAt).getTime() + SESSION_TTL_SECONDS * 1000 <= Date.now()
}

export async function getMultipartSession(
  env: Env,
  id: string
): Promise<MultipartUploadSession | null> {
  if (hasD1(env)) {
    const session = await env.DB.prepare(
      `SELECT
        id,
        upload_id AS uploadId,
        resume_token AS resumeToken,
        delete_token AS deleteToken,
        content_type AS contentType,
        filename,
        expire,
        ttl_seconds AS ttlSeconds,
        burn,
        name,
        encrypted,
        part_size AS partSize,
        created_at AS createdAt,
        expires_at AS expiresAt
      FROM multipart_sessions
      WHERE id = ?
      LIMIT 1`
    ).bind(id).first<MultipartSessionRow>()

    if (!session) {
      return null
    }

    const normalized: MultipartUploadSession = {
      id: session.id,
      uploadId: session.uploadId,
      resumeToken: session.resumeToken,
      deleteToken: session.deleteToken,
      contentType: session.contentType,
      filename: session.filename ?? undefined,
      expire: session.expire ?? undefined,
      ttlSeconds: session.ttlSeconds,
      burn: Boolean(session.burn),
      name: session.name,
      encrypted: Boolean(session.encrypted),
      partSize: session.partSize,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      parts: [],
    }

    if (sessionIsStale(normalized)) {
      await deleteMultipartSession(env, id, session.uploadId)
      return null
    }

    const result = await env.DB.prepare(
      `SELECT
        part_number AS partNumber,
        etag,
        sha256,
        size
      FROM multipart_parts
      WHERE session_id = ?
      ORDER BY part_number ASC`
    ).bind(id).all<MultipartPartRow>()

    normalized.parts = (result.results ?? []).map((part) => ({
      partNumber: part.partNumber,
      etag: part.etag,
      sha256: part.sha256,
      size: part.size,
    }))

    return normalized
  }

  const session = await getJson<MultipartUploadSession>(env, `${MULTIPART_PREFIX}${id}`)
  if (!session) {
    return null
  }

  if (sessionIsStale(session)) {
    await env.CONTENT.delete(`${MULTIPART_PREFIX}${id}`)
    return null
  }

  return session
}

export async function saveMultipartPart(
  env: Env,
  session: MultipartUploadSession,
  part: { partNumber: number; etag: string; sha256: string; size: number }
): Promise<void> {
  if (hasD1(env)) {
    await env.DB.prepare(
      `INSERT INTO multipart_parts (session_id, part_number, etag, sha256, size)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, part_number) DO UPDATE SET
        etag = excluded.etag,
        sha256 = excluded.sha256,
        size = excluded.size`
    ).bind(session.id, part.partNumber, part.etag, part.sha256, part.size).run()
    return
  }

  const updated = {
    ...session,
    parts: [...session.parts.filter((entry) => entry.partNumber !== part.partNumber), part]
      .sort((left, right) => left.partNumber - right.partNumber),
  }
  await env.CONTENT.put(
    `${MULTIPART_PREFIX}${session.id}`,
    JSON.stringify(updated),
    { expirationTtl: SESSION_TTL_SECONDS }
  )
}

export async function deleteMultipartSession(
  env: Env,
  id: string,
  uploadId?: string
): Promise<void> {
  if (hasD1(env)) {
    const session = uploadId
      ? { uploadId }
      : await env.DB.prepare("SELECT upload_id AS uploadId FROM multipart_sessions WHERE id = ? LIMIT 1")
          .bind(id)
          .first<{ uploadId: string }>()

    try {
      if (session?.uploadId) {
        await env.STORAGE.resumeMultipartUpload(id, session.uploadId).abort()
      }
    } catch {}

    await env.DB.prepare("DELETE FROM multipart_parts WHERE session_id = ?").bind(id).run()
    await env.DB.prepare("DELETE FROM multipart_sessions WHERE id = ?").bind(id).run()
    return
  }

  await env.CONTENT.delete(`${MULTIPART_PREFIX}${id}`)
}

export async function cleanupExpiredShares(env: Env): Promise<number> {
  if (!hasD1(env)) {
    return 0
  }

  const result = await env.DB.prepare(
    `SELECT
      id,
      storage_key AS storageKey,
      storage_type AS storageType
    FROM shares
    WHERE expires_at IS NOT NULL AND expires_at <= ?`
  ).bind(new Date().toISOString()).all<Pick<CanonicalRow, "id" | "storageKey" | "storageType">>()

  let deleted = 0
  for (const row of result.results ?? []) {
    if (row.storageType === "r2") {
      await env.STORAGE.delete(row.storageKey || row.id)
    }
    await env.DB.prepare("DELETE FROM shares WHERE id = ?").bind(row.id).run()
    deleted++
  }

  return deleted
}

export async function cleanupStaleMultipartSessions(env: Env): Promise<number> {
  if (!hasD1(env)) {
    return 0
  }

  const cutoff = new Date(Date.now() - SESSION_TTL_SECONDS * 1000).toISOString()
  const result = await env.DB.prepare(
    `SELECT id, upload_id AS uploadId
    FROM multipart_sessions
    WHERE created_at <= ?`
  ).bind(cutoff).all<{ id: string; uploadId: string }>()

  let deleted = 0
  for (const row of result.results ?? []) {
    await deleteMultipartSession(env, row.id, row.uploadId)
    deleted++
  }

  return deleted
}

export async function shareExistsForStorageKey(
  env: Env,
  storageKey: string
): Promise<boolean> {
  if (hasD1(env)) {
    const row = await env.DB.prepare(
      "SELECT id FROM shares WHERE storage_key = ? LIMIT 1"
    ).bind(storageKey).first<{ id: string }>()
    if (row) {
      return true
    }
  }

  if (await env.CONTENT.get(`${CANONICAL_PREFIX}${storageKey}`)) {
    return true
  }

  return Boolean(await env.CONTENT.get(`${LEGACY_PREFIX}${storageKey}`))
}
