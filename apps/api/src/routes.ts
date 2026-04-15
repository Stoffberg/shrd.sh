import { Hono } from "hono"
import { customAlphabet } from "nanoid"
import type { ContentMetadata, Env, MultipartUploadSession, PushRequest, PushResponse } from "./types"
import {
  createMultipartSession,
  deleteContent,
  deleteMultipartSession,
  getContent,
  getContentStream,
  getMetadata,
  getMultipartSession,
  incrementViews,
  saveMultipartPart,
  shareExists,
  storeBlobMetadata,
  storeContent,
  validateDeleteToken,
} from "./storage"
import {
  getExecutionContext,
  getFromCacheOrFetch,
  notFoundResponse,
  runAsync,
} from "./cache"
import { getServedContentType, renderBinaryPage, render404, renderContentPage, isBinaryContent } from "./html"
import {
  clearIdempotency,
  completeIdempotency,
  hashIdempotencyPayload,
  reserveIdempotency,
} from "./idempotency"
import { getContentTypeStats, getStorageStats, getSummaryStats, recordMetrics, recordUploadMetrics } from "./stats"

const generateId = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 6)
const generateDeleteToken = customAlphabet(
  "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ",
  32
)
const generateResumeToken = customAlphabet(
  "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ",
  40
)

const DEFAULT_TTL_SECONDS = 24 * 60 * 60
const MULTIPART_PART_SIZE = 50 * 1024 * 1024
const RESERVED_IDS = new Set(["api", "health"])
const CUSTOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/

function parseLegacyTtlSeconds(value?: number | string | null): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined
  }

  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined
  }

  return Math.floor(parsed)
}

function resolveTtlSeconds(expire?: string | null, expiresIn?: number | string | null): number | null {
  const trimmed = expire?.trim()
  if (trimmed) {
    if (trimmed === "never") {
      return null
    }

    const match = trimmed.match(/^(\d+)(h|d)$/)
    if (!match) {
      return -1
    }

    const value = Number.parseInt(match[1], 10)
    const unit = match[2]
    const multiplier = unit === "h" ? 60 * 60 : 24 * 60 * 60
    return value * multiplier
  }

  if (typeof expiresIn === "string") {
    const legacyDuration = expiresIn.trim()
    if (legacyDuration === "never") {
      return null
    }

    const match = legacyDuration.match(/^(\d+)(h|d)$/)
    if (match) {
      const value = Number.parseInt(match[1], 10)
      const unit = match[2]
      const multiplier = unit === "h" ? 60 * 60 : 24 * 60 * 60
      return value * multiplier
    }
  }

  const legacyTtl = parseLegacyTtlSeconds(expiresIn)
  if (legacyTtl !== undefined) {
    return legacyTtl
  }

  return DEFAULT_TTL_SECONDS
}

function getExpiresAt(now: Date, ttlSeconds: number | null): string | null {
  if (ttlSeconds === null) {
    return null
  }

  return new Date(now.getTime() + ttlSeconds * 1000).toISOString()
}

function normalizeCustomName(name?: string | null): string | null {
  const trimmed = name?.trim()
  return trimmed ? trimmed : null
}

function validateCustomName(name: string): string | null {
  if (!CUSTOM_ID_PATTERN.test(name)) {
    return "Name must be 4-64 characters and use only letters, numbers, hyphens, or underscores"
  }

  if (RESERVED_IDS.has(name.toLowerCase())) {
    return "Name is reserved"
  }

  return null
}

async function resolveShareId(env: Env, requestedName?: string | null): Promise<{
  id: string
  name: string | null
  error: string | null
  status: number
}> {
  const name = normalizeCustomName(requestedName)
  if (!name) {
    return { id: generateId(), name: null, error: null, status: 200 }
  }

  const validationError = validateCustomName(name)
  if (validationError) {
    return { id: name, name, error: validationError, status: 400 }
  }

  if (await shareExists(env, name)) {
    return { id: name, name, error: "Name already exists", status: 409 }
  }

  return { id: name, name, error: null, status: 200 }
}

function createPushResponse(baseUrl: string, metadata: ContentMetadata): PushResponse {
  return {
    id: metadata.id,
    url: `${baseUrl}/${metadata.id}`,
    rawUrl: `${baseUrl}/${metadata.id}/raw`,
    deleteUrl: `${baseUrl}/api/v1/${metadata.id}`,
    deleteToken: metadata.deleteToken,
    expiresAt: metadata.expiresAt,
    name: metadata.name ?? null,
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function recordErrorStatus(env: Env, status: number, isNotFound = false): Promise<void> {
  await recordMetrics(env, {
    errors4xx: status >= 400 && status < 500 ? 1 : 0,
    errors5xx: status >= 500 ? 1 : 0,
    notFound: isNotFound ? 1 : 0,
  })
}

async function jsonError(
  c: { env: Env; json: (body: { error: string }, status?: number) => Response },
  error: string,
  status: number
) {
  await recordErrorStatus(c.env, status, status === 404)
  return c.json({ error }, status as 400 | 401 | 403 | 404 | 409 | 500)
}

async function htmlNotFound(env: Env) {
  await recordErrorStatus(env, 404, true)
  return new Response(render404(), {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}

async function withIdempotency<T>(
  c: { env: Env; req: { header(name: string): string | undefined } },
  scope: string,
  payload: unknown,
  operation: () => Promise<{ body: T; status: number; resourceId?: string }>
): Promise<Response | { body: T; status: number; resourceId?: string }> {
  const idempotencyKey = c.req.header("X-Idempotency-Key")
  if (!idempotencyKey) {
    return operation()
  }

  const requestHash = await hashIdempotencyPayload(payload)
  const reservation = await reserveIdempotency(c.env, scope, idempotencyKey, requestHash)

  if (reservation.kind === "replay") {
    await recordMetrics(c.env, { idempotencyHits: 1 })
    return new Response(JSON.stringify(reservation.response), {
      status: reservation.status,
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Replayed": "true",
      },
    })
  }

  if (reservation.kind === "conflict") {
    await recordMetrics(c.env, { idempotencyConflicts: 1 })
    await recordErrorStatus(c.env, 409)
    return new Response(JSON.stringify({ error: "Idempotency key conflicts with a different request" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })
  }

  if (reservation.kind === "in_progress") {
    await recordErrorStatus(c.env, 409)
    return new Response(JSON.stringify({ error: "Idempotent request already in progress" }), {
      status: 409,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "2",
      },
    })
  }

  try {
    const result = await operation()
    await completeIdempotency(c.env, scope, idempotencyKey, result.body, result.status, result.resourceId)
    return result
  } catch (error) {
    await clearIdempotency(c.env, scope, idempotencyKey)
    throw error
  }
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response
}

function parseStatsWindow(value?: string | null): "24h" | "7d" | "30d" | null {
  if (!value) {
    return "24h"
  }

  if (value === "24h" || value === "7d" || value === "30d") {
    return value
  }

  return null
}

function baseMetadata(
  id: string,
  now: Date,
  contentType: string,
  size: number,
  name: string | null,
  filename: string | undefined,
  expiresAt: string | null,
  burn: boolean,
  encrypted: boolean
): ContentMetadata {
  return {
    id,
    deleteToken: generateDeleteToken(),
    contentType,
    size,
    createdAt: now.toISOString(),
    expiresAt,
    views: 0,
    maxViews: burn ? 1 : undefined,
    name,
    filename,
    storageType: size <= 25 * 1024 ? "kv" : "r2",
    encrypted,
  }
}

export function registerRoutes(app: Hono<{ Bindings: Env }>) {
  app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }))

  app.post("/api/v1/push", async (c) => {
    let body: PushRequest
    try {
      body = await c.req.json<PushRequest>()
    } catch {
      return jsonError(c, "Invalid JSON", 400)
    }

    if (!body.content) {
      return jsonError(c, "Content is required", 400)
    }

    const ttlSeconds = resolveTtlSeconds(body.expire, body.expiresIn)
    if (ttlSeconds === -1) {
      return jsonError(c, "Invalid expiry value", 400)
    }

    if (!c.req.header("X-Idempotency-Key")) {
      const resolvedId = await resolveShareId(c.env, body.name)
      if (resolvedId.error) {
        return jsonError(c, resolvedId.error, resolvedId.status)
      }

      const now = new Date()
      const contentType = body.contentType ?? "text/plain"
      const size = new TextEncoder().encode(body.content).length
      const metadata = baseMetadata(
        resolvedId.id,
        now,
        contentType,
        size,
        resolvedId.name,
        body.filename,
        getExpiresAt(now, ttlSeconds),
        Boolean(body.burn),
        Boolean(body.encrypted)
      )
      const ctx = getExecutionContext(c)
      void runAsync(ctx, (async () => {
        await storeContent(c.env, metadata.id, body.content, metadata)
        await recordUploadMetrics(c.env, metadata, "inline")
      })())
      return c.json(createPushResponse(c.env.BASE_URL, metadata), 201)
    }

    const idempotent = await withIdempotency(c, "push", body, async () => {
      const resolvedId = await resolveShareId(c.env, body.name)
      if (resolvedId.error) {
        throw new Error(`${resolvedId.status}:${resolvedId.error}`)
      }

      const now = new Date()
      const contentType = body.contentType ?? "text/plain"
      const size = new TextEncoder().encode(body.content).length
      const metadata = baseMetadata(
        resolvedId.id,
        now,
        contentType,
        size,
        resolvedId.name,
        body.filename,
        getExpiresAt(now, ttlSeconds),
        Boolean(body.burn),
        Boolean(body.encrypted)
      )

      await storeContent(c.env, metadata.id, body.content, metadata)
      await recordUploadMetrics(c.env, metadata, "inline")
      return { body: createPushResponse(c.env.BASE_URL, metadata), status: 201, resourceId: metadata.id }
    }).catch(async (error: Error) => {
      const [status, message] = error.message.split(":", 2)
      if (message) {
        return jsonError(c, message, Number(status))
      }
      throw error
    })

    if (isResponse(idempotent)) {
      return idempotent
    }

    return c.json(idempotent.body, idempotent.status as 201)
  })

  app.post("/api/v1/upload", async (c) => {
    const contentType = c.req.header("X-Content-Type") ?? "application/octet-stream"
    const filename = c.req.header("X-Filename") ?? undefined
    const expire = c.req.header("X-Expire")
    const expiresIn = c.req.header("X-Expires-In")
    const burn = c.req.header("X-Burn") === "true"
    const name = c.req.header("X-Name")
    const encrypted = c.req.header("X-Encrypted") === "true"

    const ttlSeconds = resolveTtlSeconds(expire, expiresIn)
    if (ttlSeconds === -1) {
      return jsonError(c, "Invalid expiry value", 400)
    }

    if (!c.req.header("X-Idempotency-Key")) {
      const contentLength = c.req.header("Content-Length")
      const size = contentLength ? Number.parseInt(contentLength, 10) : Number.NaN
      if (!Number.isFinite(size) || size <= 0) {
        return jsonError(c, "Content-Length required", 400)
      }

      const resolvedId = await resolveShareId(c.env, name)
      if (resolvedId.error) {
        return jsonError(c, resolvedId.error, resolvedId.status)
      }

      const bodyStream = c.req.raw.body
      if (!bodyStream) {
        return jsonError(c, "No body provided", 400)
      }

      const now = new Date()
      const metadata = baseMetadata(
        resolvedId.id,
        now,
        contentType,
        size,
        resolvedId.name,
        filename,
        getExpiresAt(now, ttlSeconds),
        burn,
        encrypted
      )
      metadata.storageType = "r2"

      const ctx = getExecutionContext(c)
      void runAsync(ctx, (async () => {
        await c.env.STORAGE.put(resolvedId.id, bodyStream, {
          customMetadata: { contentType, filename: filename ?? "" },
        })
        await storeBlobMetadata(c.env, metadata)
        await recordUploadMetrics(c.env, metadata, "direct")
      })())

      return c.json(createPushResponse(c.env.BASE_URL, metadata), 201)
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength === 0) {
      return jsonError(c, "Content-Length required", 400)
    }

    const bodyHash = await sha256Hex(bytes)
    const idempotent = await withIdempotency(c, "upload", {
      contentType,
      filename,
      expire,
      expiresIn,
      burn,
      name,
      encrypted,
      size: bytes.byteLength,
      bodyHash,
    }, async () => {
      const resolvedId = await resolveShareId(c.env, name)
      if (resolvedId.error) {
        throw new Error(`${resolvedId.status}:${resolvedId.error}`)
      }

      const now = new Date()
      await c.env.STORAGE.put(resolvedId.id, bytes, {
        customMetadata: { contentType, filename: filename ?? "" },
      })

      const metadata = baseMetadata(
        resolvedId.id,
        now,
        contentType,
        bytes.byteLength,
        resolvedId.name,
        filename,
        getExpiresAt(now, ttlSeconds),
        burn,
        encrypted
      )
      metadata.storageType = "r2"

      await storeBlobMetadata(c.env, metadata)
      await recordUploadMetrics(c.env, metadata, "direct")
      return { body: createPushResponse(c.env.BASE_URL, metadata), status: 201, resourceId: metadata.id }
    }).catch(async (error: Error) => {
      const [status, message] = error.message.split(":", 2)
      if (message) {
        return jsonError(c, message, Number(status))
      }
      throw error
    })

    if (isResponse(idempotent)) {
      return idempotent
    }

    return c.json(idempotent.body, 201)
  })

  app.post("/api/v1/multipart/init", async (c) => {
    const contentType = c.req.header("X-Content-Type") ?? "application/octet-stream"
    const filename = c.req.header("X-Filename") ?? undefined
    const expire = c.req.header("X-Expire")
    const expiresIn = c.req.header("X-Expires-In")
    const burn = c.req.header("X-Burn") === "true"
    const name = c.req.header("X-Name")
    const encrypted = c.req.header("X-Encrypted") === "true"

    const ttlSeconds = resolveTtlSeconds(expire, expiresIn)
    if (ttlSeconds === -1) {
      return jsonError(c, "Invalid expiry value", 400)
    }

    const expiresAt = getExpiresAt(new Date(), ttlSeconds)
    const idempotent = await withIdempotency(c, "multipart:init", {
      contentType,
      filename,
      expire,
      expiresIn,
      burn,
      name,
      encrypted,
      partSize: MULTIPART_PART_SIZE,
    }, async () => {
      const resolvedId = await resolveShareId(c.env, name)
      if (resolvedId.error) {
        throw new Error(`${resolvedId.status}:${resolvedId.error}`)
      }

      const multipartUpload = await c.env.STORAGE.createMultipartUpload(resolvedId.id, {
        customMetadata: { contentType, filename: filename ?? "" },
      })

      const session: MultipartUploadSession = {
        id: resolvedId.id,
        uploadId: multipartUpload.uploadId,
        resumeToken: generateResumeToken(),
        deleteToken: generateDeleteToken(),
        contentType,
        filename,
        expire: expire ?? undefined,
        ttlSeconds,
        burn,
        name: resolvedId.name,
        encrypted,
        partSize: MULTIPART_PART_SIZE,
        expiresAt,
        createdAt: new Date().toISOString(),
        parts: [],
      }

      await createMultipartSession(c.env, session)
      return {
        body: {
          id: session.id,
          uploadId: session.uploadId,
          resumeToken: session.resumeToken,
          partSize: session.partSize,
          statusUrl: `${c.env.BASE_URL}/api/v1/multipart/${session.id}/status`,
          deleteToken: session.deleteToken,
          expiresAt: session.expiresAt,
          name: session.name ?? null,
        },
        status: 200,
        resourceId: session.id,
      }
    }).catch(async (error: Error) => {
      const [status, message] = error.message.split(":", 2)
      if (message) {
        return jsonError(c, message, Number(status))
      }
      throw error
    })

    if (isResponse(idempotent)) {
      return idempotent
    }

    return c.json(idempotent.body, 200)
  })

  app.get("/api/v1/multipart/:id/status", async (c) => {
    const id = c.req.param("id")
    const uploadId = c.req.header("X-Upload-Id")
    const resumeToken = c.req.header("X-Resume-Token")

    if (!uploadId || !resumeToken) {
      return jsonError(c, "X-Upload-Id and X-Resume-Token headers required", 400)
    }

    const session = await getMultipartSession(c.env, id)
    if (!session) {
      return jsonError(c, "Upload session not found", 404)
    }

    if (session.uploadId !== uploadId || session.resumeToken !== resumeToken) {
      return jsonError(c, "Invalid upload credentials", 403)
    }

    await recordMetrics(c.env, { multipartResumes: 1 })
    return c.json({
      id: session.id,
      uploadId: session.uploadId,
      uploadedParts: session.parts,
      partSize: session.partSize,
      filename: session.filename,
      contentType: session.contentType,
      name: session.name ?? null,
      encrypted: session.encrypted ?? false,
      burn: session.burn ?? false,
      expiresAt: session.expiresAt ?? null,
      createdAt: session.createdAt,
    })
  })

  app.delete("/api/v1/multipart/:id", async (c) => {
    const id = c.req.param("id")
    const uploadId = c.req.header("X-Upload-Id")
    const resumeToken = c.req.header("X-Resume-Token")

    if (!uploadId || !resumeToken) {
      return jsonError(c, "X-Upload-Id and X-Resume-Token headers required", 400)
    }

    const session = await getMultipartSession(c.env, id)
    if (!session) {
      return jsonError(c, "Upload session not found", 404)
    }

    if (session.uploadId !== uploadId || session.resumeToken !== resumeToken) {
      return jsonError(c, "Invalid upload credentials", 403)
    }

    await deleteMultipartSession(c.env, id, uploadId)
    return c.json({ success: true })
  })

  app.put("/api/v1/multipart/:id/part/:partNumber", async (c) => {
    const id = c.req.param("id")
    const partNumber = Number.parseInt(c.req.param("partNumber"), 10)
    const uploadId = c.req.header("X-Upload-Id")
    const partSha256 = c.req.header("X-Part-SHA256")

    if (!uploadId) {
      return jsonError(c, "X-Upload-Id header required", 400)
    }

    if (!partSha256) {
      return jsonError(c, "X-Part-SHA256 header required", 400)
    }

    if (!Number.isInteger(partNumber) || partNumber <= 0) {
      return jsonError(c, "Invalid part number", 400)
    }

    const session = await getMultipartSession(c.env, id)
    if (!session) {
      return jsonError(c, "Upload session not found", 404)
    }

    if (session.uploadId !== uploadId) {
      return jsonError(c, "Invalid upload ID", 403)
    }

    const existing = session.parts.find((entry) => entry.partNumber === partNumber)
    if (existing) {
      if (existing.sha256 !== partSha256) {
        return jsonError(c, "Part already exists with a different checksum", 409)
      }
      return c.json({ partNumber, etag: existing.etag })
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength === 0) {
      return jsonError(c, "No body provided", 400)
    }

    const actualSha256 = await sha256Hex(bytes)
    if (actualSha256 !== partSha256) {
      return jsonError(c, "Part checksum mismatch", 400)
    }

    const multipartUpload = c.env.STORAGE.resumeMultipartUpload(id, uploadId)
    const part = await multipartUpload.uploadPart(partNumber, bytes)
    await saveMultipartPart(c.env, session, {
      partNumber,
      etag: part.etag,
      sha256: actualSha256,
      size: bytes.byteLength,
    })

    return c.json({ partNumber, etag: part.etag })
  })

  app.post("/api/v1/multipart/:id/complete", async (c) => {
    const id = c.req.param("id")
    const uploadId = c.req.header("X-Upload-Id")
    const totalSize = c.req.header("X-Total-Size")

    if (!uploadId) {
      return jsonError(c, "X-Upload-Id header required", 400)
    }

    const parsedSize = totalSize ? Number.parseInt(totalSize, 10) : Number.NaN
    if (!Number.isFinite(parsedSize) || parsedSize < 0) {
      return jsonError(c, "X-Total-Size header required", 400)
    }

    const idempotent = await withIdempotency(c, "multipart:complete", {
      id,
      uploadId,
      totalSize: parsedSize,
    }, async () => {
      const session = await getMultipartSession(c.env, id)
      if (!session) {
        throw new Error("404:Upload session not found")
      }

      if (session.uploadId !== uploadId) {
        throw new Error("403:Invalid upload ID")
      }

      const multipartUpload = c.env.STORAGE.resumeMultipartUpload(id, uploadId)
      const sortedParts = session.parts
        .slice()
        .sort((left, right) => left.partNumber - right.partNumber)
        .map((part) => ({ partNumber: part.partNumber, etag: part.etag }))

      await multipartUpload.complete(sortedParts)

      const now = new Date()
      const metadata = baseMetadata(
        id,
        now,
        session.contentType,
        parsedSize,
        session.name ?? null,
        session.filename,
        getExpiresAt(now, session.ttlSeconds ?? null),
        Boolean(session.burn),
        Boolean(session.encrypted)
      )
      metadata.deleteToken = session.deleteToken
      metadata.storageType = "r2"

      await storeBlobMetadata(c.env, metadata)
      await deleteMultipartSession(c.env, id, uploadId)
      await recordUploadMetrics(c.env, metadata, "multipart")
      return { body: createPushResponse(c.env.BASE_URL, metadata), status: 201, resourceId: metadata.id }
    }).catch(async (error: Error) => {
      const [status, message] = error.message.split(":", 2)
      if (message) {
        return jsonError(c, message, Number(status))
      }
      throw error
    })

    if (isResponse(idempotent)) {
      return idempotent
    }

    return c.json(idempotent.body, 201)
  })

  app.get("/api/v1/stats/summary", async (c) => {
    const window = parseStatsWindow(c.req.query("window"))
    if (!window) {
      return jsonError(c, "Invalid window", 400)
    }

    return c.json(await getSummaryStats(c.env, window))
  })

  app.get("/api/v1/stats/content-types", async (c) => {
    const window = parseStatsWindow(c.req.query("window"))
    if (!window) {
      return jsonError(c, "Invalid window", 400)
    }

    const limit = Number.parseInt(c.req.query("limit") ?? "10", 10)
    if (!Number.isInteger(limit) || limit <= 0) {
      return jsonError(c, "Invalid limit", 400)
    }

    return c.json(await getContentTypeStats(c.env, window, limit))
  })

  app.get("/api/v1/stats/storage", async (c) => {
    return c.json(await getStorageStats(c.env))
  })

  app.get("/:id", async (c) => {
    const id = c.req.param("id")
    const accept = c.req.header("Accept") ?? ""
    const ctx = getExecutionContext(c)

    if (accept.includes("text/html")) {
      const metadata = await getMetadata(c.env, id)
      if (!metadata) {
        return htmlNotFound(c.env)
      }

      await recordMetrics(c.env, { readsHtml: 1 })

      if (metadata.maxViews !== undefined) {
        await incrementViews(c.env, id)
        if (metadata.views + 1 >= metadata.maxViews) {
          runAsync(ctx, deleteContent(c.env, id))
        }
      } else {
        runAsync(ctx, incrementViews(c.env, id))
      }

      if (isBinaryContent(metadata.contentType, metadata.filename)) {
        return c.html(renderBinaryPage(metadata, c.env.BASE_URL))
      }

      const result = await getContent(c.env, id)
      if (!result) {
        return htmlNotFound(c.env)
      }

      return c.html(renderContentPage(result.content, metadata, c.env.BASE_URL))
    }

    return getFromCacheOrFetch(
      c.req.raw,
      ctx,
      () => handleContentRequest(c.env, ctx, id, "readsRaw"),
      {
        onHit: () => recordMetrics(c.env, { readsRaw: 1 }),
      }
    )
  })

  app.get("/:id/raw", async (c) => {
    const id = c.req.param("id")
    const ctx = getExecutionContext(c)

    return getFromCacheOrFetch(
      c.req.raw,
      ctx,
      () => handleContentRequest(c.env, ctx, id, "readsRaw"),
      {
        onHit: () => recordMetrics(c.env, { readsRaw: 1 }),
      }
    )
  })

  app.get("/:id/meta", async (c) => {
    const id = c.req.param("id")
    const metadata = await getMetadata(c.env, id)

    if (!metadata) {
      return jsonError(c, "Not found", 404)
    }

    await recordMetrics(c.env, { readsMeta: 1 })
    return c.json({
      id: metadata.id,
      contentType: metadata.contentType,
      size: metadata.size,
      createdAt: metadata.createdAt,
      expiresAt: metadata.expiresAt,
      views: metadata.views,
      burn: metadata.maxViews !== undefined,
      name: metadata.name ?? null,
      filename: metadata.filename,
      storageType: metadata.storageType,
      encrypted: metadata.encrypted,
    })
  })

  app.delete("/api/v1/:id", async (c) => {
    const id = c.req.param("id")
    const authHeader = c.req.header("Authorization")

    if (!authHeader?.startsWith("Bearer ")) {
      return jsonError(c, "Authorization required", 401)
    }

    const token = authHeader.slice(7)
    const isValid = await validateDeleteToken(c.env, id, token)
    if (!isValid) {
      return jsonError(c, "Invalid token or content not found", 403)
    }

    const deleted = await deleteContent(c.env, id)
    if (!deleted) {
      return jsonError(c, "Failed to delete", 500)
    }

    await recordMetrics(c.env, { deletes: 1 })
    return c.json({ success: true })
  })

}

async function handleContentRequest(
  env: Env,
  ctx: ExecutionContext | undefined,
  id: string,
  metricKey: "readsRaw"
): Promise<Response> {
  const result = await getContentStream(env, id)
  if (!result) {
    await recordErrorStatus(env, 404, true)
    return notFoundResponse()
  }

  await recordMetrics(env, { [metricKey]: 1 } as { readsRaw: number })

  const { metadata, body } = result
  const servedContentType = getServedContentType(metadata.contentType, metadata.filename)
  if (metadata.maxViews !== undefined) {
    await incrementViews(env, id)
    if (metadata.views + 1 >= metadata.maxViews) {
      runAsync(ctx, deleteContent(env, id))
    }
    return new Response(body, {
      headers: {
        "Content-Type": servedContentType,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    })
  }

  runAsync(ctx, incrementViews(env, id))

  const expiresAt = metadata.expiresAt ? new Date(metadata.expiresAt) : new Date(Date.now() + 86400000)
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))

  return new Response(body, {
    headers: {
      "Content-Type": servedContentType,
      "Cache-Control": `public, max-age=${maxAge}, immutable`,
    },
  })
}
