import { Hono } from "hono"
import { customAlphabet } from "nanoid"
import type { Env, PushRequest, PushResponse, ContentMetadata, MultipartUploadSession } from "./types"
import {
  storeContent,
  getContent,
  getContentStream,
  getMetadata,
  incrementViews,
  deleteContent,
  validateDeleteToken,
} from "./storage"
import {
  getExecutionContext,
  runAsync,
  getFromCacheOrFetch,
  notFoundResponse,
} from "./cache"
import { renderContentPage, renderBinaryPage, render404, isBinaryContent } from "./html"

const generateId = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 6)
const generateDeleteToken = customAlphabet(
  "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ",
  32
)

const DEFAULT_TTL_SECONDS = 24 * 60 * 60
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

function getExpirationOptions(ttlSeconds: number | null): KVNamespacePutOptions {
  if (ttlSeconds === null) {
    return {}
  }

  return { expirationTtl: ttlSeconds }
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

  const existingContent = await env.CONTENT.get(`content:${name}`)
  const existingMultipart = await env.CONTENT.get(`multipart:${name}`)
  if (existingContent || existingMultipart) {
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

export function registerRoutes(app: Hono<{ Bindings: Env }>) {
  app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }))

  app.post("/api/v1/push", async (c) => {
    let body: PushRequest
    try {
      body = await c.req.json<PushRequest>()
    } catch {
      return c.json({ error: "Invalid JSON" }, 400)
    }

    if (!body.content) {
      return c.json({ error: "Content is required" }, 400)
    }

    const resolvedId = await resolveShareId(c.env, body.name)
    if (resolvedId.error) {
      return c.json({ error: resolvedId.error }, resolvedId.status as 400 | 409)
    }

    const ttlSeconds = resolveTtlSeconds(body.expire, body.expiresIn)
    if (ttlSeconds === -1) {
      return c.json({ error: "Invalid expiry value" }, 400)
    }

    const now = new Date()
    const contentType = body.contentType ?? "text/plain"
    const contentSize = new TextEncoder().encode(body.content).length

    const metadata: ContentMetadata = {
      id: resolvedId.id,
      deleteToken: generateDeleteToken(),
      contentType,
      size: contentSize,
      createdAt: now.toISOString(),
      expiresAt: getExpiresAt(now, ttlSeconds),
      views: 0,
      maxViews: body.burn ? 1 : undefined,
      name: resolvedId.name,
      filename: body.filename,
      storageType: "kv",
      encrypted: body.encrypted,
    }

    const ctx = getExecutionContext(c)
    await runAsync(ctx, storeContent(c.env, metadata.id, body.content, metadata, ttlSeconds ?? undefined))
    return c.json(createPushResponse(c.env.BASE_URL, metadata), 201)
  })

  app.get("/:id", async (c) => {
    const id = c.req.param("id")
    const accept = c.req.header("Accept") ?? ""
    const ctx = getExecutionContext(c)

    if (accept.includes("text/html")) {
      const metadata = await getMetadata(c.env, id)
      if (!metadata) {
        return c.html(render404(), 404)
      }

      if (metadata.maxViews !== undefined) {
        await incrementViews(c.env, id)
        if (metadata.views + 1 >= metadata.maxViews) {
          runAsync(ctx, deleteContent(c.env, id))
        }
      } else {
        runAsync(ctx, incrementViews(c.env, id))
      }

      if (isBinaryContent(metadata.contentType)) {
        return c.html(renderBinaryPage(metadata, c.env.BASE_URL))
      }

      const result = await getContent(c.env, id)
      if (!result) {
        return c.html(render404(), 404)
      }

      return c.html(renderContentPage(result.content, metadata, c.env.BASE_URL))
    }

    return getFromCacheOrFetch(c.req.raw, ctx, () =>
      handleContentRequest(c.env, ctx, id)
    )
  })

  app.get("/:id/raw", async (c) => {
    const id = c.req.param("id")
    const ctx = getExecutionContext(c)

    return getFromCacheOrFetch(c.req.raw, ctx, () =>
      handleContentRequest(c.env, ctx, id)
    )
  })

  app.get("/:id/meta", async (c) => {
    const id = c.req.param("id")
    const metadata = await getMetadata(c.env, id)

    if (!metadata) {
      return c.json({ error: "Not found" }, 404)
    }

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

  app.post("/api/v1/upload", async (c) => {
    const contentType = c.req.header("X-Content-Type") ?? "application/octet-stream"
    const filename = c.req.header("X-Filename") ?? undefined
    const expire = c.req.header("X-Expire")
    const expiresIn = c.req.header("X-Expires-In")
    const burn = c.req.header("X-Burn") === "true"
    const name = c.req.header("X-Name")
    const encrypted = c.req.header("X-Encrypted") === "true"
    const contentLength = c.req.header("Content-Length")

    const size = contentLength ? Number.parseInt(contentLength, 10) : Number.NaN
    if (!Number.isFinite(size) || size <= 0) {
      return c.json({ error: "Content-Length required" }, 400)
    }

    const resolvedId = await resolveShareId(c.env, name)
    if (resolvedId.error) {
      return c.json({ error: resolvedId.error }, resolvedId.status as 400 | 409)
    }

    const ttlSeconds = resolveTtlSeconds(expire, expiresIn)
    if (ttlSeconds === -1) {
      return c.json({ error: "Invalid expiry value" }, 400)
    }

    const now = new Date()

    const body = c.req.raw.body
    if (!body) {
      return c.json({ error: "No body provided" }, 400)
    }

    await c.env.STORAGE.put(resolvedId.id, body, {
      customMetadata: { contentType, filename: filename ?? "" },
    })

    const metadata: ContentMetadata = {
      id: resolvedId.id,
      deleteToken: generateDeleteToken(),
      contentType,
      size,
      createdAt: now.toISOString(),
      expiresAt: getExpiresAt(now, ttlSeconds),
      views: 0,
      maxViews: burn ? 1 : undefined,
      name: resolvedId.name,
      filename,
      storageType: "r2",
      encrypted,
    }

    const stored = { metadata }
    await c.env.CONTENT.put(`content:${metadata.id}`, JSON.stringify(stored), getExpirationOptions(ttlSeconds))
    return c.json(createPushResponse(c.env.BASE_URL, metadata), 201)
  })

  app.post("/api/v1/multipart/init", async (c) => {
    const contentType = c.req.header("X-Content-Type") ?? "application/octet-stream"
    const filename = c.req.header("X-Filename") ?? undefined
    const expire = c.req.header("X-Expire")
    const expiresIn = c.req.header("X-Expires-In")
    const burn = c.req.header("X-Burn") === "true"
    const name = c.req.header("X-Name")
    const encrypted = c.req.header("X-Encrypted") === "true"

    const resolvedId = await resolveShareId(c.env, name)
    if (resolvedId.error) {
      return c.json({ error: resolvedId.error }, resolvedId.status as 400 | 409)
    }

    const ttlSeconds = resolveTtlSeconds(expire, expiresIn)
    if (ttlSeconds === -1) {
      return c.json({ error: "Invalid expiry value" }, 400)
    }

    const multipartUpload = await c.env.STORAGE.createMultipartUpload(resolvedId.id, {
      customMetadata: { contentType, filename: filename ?? "" },
    })

    const session: MultipartUploadSession = {
      id: resolvedId.id,
      uploadId: multipartUpload.uploadId,
      deleteToken: generateDeleteToken(),
      contentType,
      filename,
      expire: expire ?? undefined,
      expiresIn: parseLegacyTtlSeconds(expiresIn),
      burn,
      name: resolvedId.name,
      encrypted,
      parts: [],
      createdAt: new Date().toISOString(),
    }

    await c.env.CONTENT.put(`multipart:${resolvedId.id}`, JSON.stringify(session), {
      expirationTtl: 3600,
    })

    return c.json({ id: resolvedId.id, uploadId: multipartUpload.uploadId, deleteToken: session.deleteToken, expiresAt: getExpiresAt(new Date(), ttlSeconds), name: resolvedId.name })
  })

  app.put("/api/v1/multipart/:id/part/:partNumber", async (c) => {
    const id = c.req.param("id")
    const partNumber = parseInt(c.req.param("partNumber"))
    const uploadId = c.req.header("X-Upload-Id")

    if (!uploadId) {
      return c.json({ error: "X-Upload-Id header required" }, 400)
    }

    const sessionJson = await c.env.CONTENT.get(`multipart:${id}`)
    if (!sessionJson) {
      return c.json({ error: "Upload session not found" }, 404)
    }

    const session: MultipartUploadSession = JSON.parse(sessionJson)
    if (session.uploadId !== uploadId) {
      return c.json({ error: "Invalid upload ID" }, 403)
    }

    const body = c.req.raw.body
    if (!body) {
      return c.json({ error: "No body provided" }, 400)
    }

    const multipartUpload = c.env.STORAGE.resumeMultipartUpload(id, uploadId)
    const part = await multipartUpload.uploadPart(partNumber, body)

    session.parts.push({ partNumber, etag: part.etag })
    await c.env.CONTENT.put(`multipart:${id}`, JSON.stringify(session), {
      expirationTtl: 3600,
    })

    return c.json({ partNumber, etag: part.etag })
  })

  app.post("/api/v1/multipart/:id/complete", async (c) => {
    const id = c.req.param("id")
    const uploadId = c.req.header("X-Upload-Id")
    const totalSize = c.req.header("X-Total-Size")

    if (!uploadId) {
      return c.json({ error: "X-Upload-Id header required" }, 400)
    }

    const sessionJson = await c.env.CONTENT.get(`multipart:${id}`)
    if (!sessionJson) {
      return c.json({ error: "Upload session not found" }, 404)
    }

    const session: MultipartUploadSession = JSON.parse(sessionJson)
    if (session.uploadId !== uploadId) {
      return c.json({ error: "Invalid upload ID" }, 403)
    }

    const multipartUpload = c.env.STORAGE.resumeMultipartUpload(id, uploadId)
    const sortedParts = session.parts.sort((a, b) => a.partNumber - b.partNumber)

    await multipartUpload.complete(sortedParts)

    const now = new Date()
    const ttlSeconds = resolveTtlSeconds(session.expire, session.expiresIn)
    if (ttlSeconds === -1) {
      return c.json({ error: "Invalid expiry value" }, 400)
    }

    const metadata: ContentMetadata = {
      id,
      deleteToken: session.deleteToken,
      contentType: session.contentType,
      size: totalSize ? parseInt(totalSize) : 0,
      createdAt: now.toISOString(),
      expiresAt: getExpiresAt(now, ttlSeconds),
      views: 0,
      maxViews: session.burn ? 1 : undefined,
      name: session.name ?? null,
      filename: session.filename,
      storageType: "r2",
      encrypted: session.encrypted,
    }

    const stored = { metadata }
    await c.env.CONTENT.put(`content:${id}`, JSON.stringify(stored), getExpirationOptions(ttlSeconds))

    await c.env.CONTENT.delete(`multipart:${id}`)

    return c.json(createPushResponse(c.env.BASE_URL, metadata), 201)
  })

  app.delete("/api/v1/:id", async (c) => {
    const id = c.req.param("id")
    const authHeader = c.req.header("Authorization")

    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Authorization required" }, 401)
    }

    const token = authHeader.slice(7)
    const isValid = await validateDeleteToken(c.env, id, token)
    if (!isValid) {
      return c.json({ error: "Invalid token or content not found" }, 403)
    }

    const deleted = await deleteContent(c.env, id)
    if (!deleted) {
      return c.json({ error: "Failed to delete" }, 500)
    }

    return c.json({ success: true })
  })
}

async function handleContentRequest(
  env: Env,
  ctx: ExecutionContext | undefined,
  id: string
): Promise<Response> {
  const result = await getContentStream(env, id)
  if (!result) {
    return notFoundResponse()
  }

  const { metadata, body } = result

  if (metadata.maxViews !== undefined) {
    await incrementViews(env, id)
    if (metadata.views + 1 >= metadata.maxViews) {
      runAsync(ctx, deleteContent(env, id))
    }
    return new Response(body, {
      headers: {
        "Content-Type": metadata.contentType,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    })
  }

  runAsync(ctx, incrementViews(env, id))

  const expiresAt = metadata.expiresAt ? new Date(metadata.expiresAt) : new Date(Date.now() + 86400000)
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))

  return new Response(body, {
    headers: {
      "Content-Type": metadata.contentType,
      "Cache-Control": `public, max-age=${maxAge}, immutable`,
    },
  })
}
