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
  createCachedResponse,
  notFoundResponse,
  noCacheResponse,
} from "./cache"
import { renderContentPage, renderBinaryPage, render404, isBinaryContent } from "./html"

const generateId = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 6)
const generateDeleteToken = customAlphabet(
  "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ",
  32
)

const DEFAULT_TTL_SECONDS = 24 * 60 * 60

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

    const id = generateId()
    const deleteToken = generateDeleteToken()
    const now = new Date()
    const contentType = body.contentType ?? "text/plain"
    const contentSize = new TextEncoder().encode(body.content).length
    const ttlSeconds = body.expiresIn && body.expiresIn > 0 ? body.expiresIn : DEFAULT_TTL_SECONDS

    const metadata: ContentMetadata = {
      id,
      deleteToken,
      contentType,
      size: contentSize,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      views: 0,
      maxViews: body.burn ? 1 : undefined,
      filename: body.filename,
      storageType: "kv",
    }

    const ctx = getExecutionContext(c)
    await runAsync(ctx, storeContent(c.env, id, body.content, metadata, ttlSeconds))

    const response: PushResponse = {
      id,
      url: `${c.env.BASE_URL}/${id}`,
      rawUrl: `${c.env.BASE_URL}/${id}/raw`,
      deleteUrl: `${c.env.BASE_URL}/api/v1/${id}`,
      deleteToken,
      expiresAt: metadata.expiresAt,
    }

    return c.json(response, 201)
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
      filename: metadata.filename,
    })
  })

  app.post("/api/v1/upload", async (c) => {
    const contentType = c.req.header("X-Content-Type") ?? "application/octet-stream"
    const filename = c.req.header("X-Filename") ?? undefined
    const expiresIn = c.req.header("X-Expires-In")
    const burn = c.req.header("X-Burn") === "true"
    const contentLength = c.req.header("Content-Length")

    if (!contentLength || parseInt(contentLength) === 0) {
      return c.json({ error: "Content-Length required" }, 400)
    }

    const size = parseInt(contentLength)
    const id = generateId()
    const deleteToken = generateDeleteToken()
    const now = new Date()
    const ttlSeconds = expiresIn && parseInt(expiresIn) > 0 ? parseInt(expiresIn) : DEFAULT_TTL_SECONDS

    const body = c.req.raw.body
    if (!body) {
      return c.json({ error: "No body provided" }, 400)
    }

    await c.env.STORAGE.put(id, body, {
      customMetadata: { contentType, filename: filename ?? "" },
    })

    const metadata: ContentMetadata = {
      id,
      deleteToken,
      contentType,
      size,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      views: 0,
      maxViews: burn ? 1 : undefined,
      filename,
      storageType: "r2",
    }

    const stored = { metadata }
    const options: KVNamespacePutOptions = { expirationTtl: ttlSeconds }
    await c.env.CONTENT.put(`content:${id}`, JSON.stringify(stored), options)

    const response: PushResponse = {
      id,
      url: `${c.env.BASE_URL}/${id}`,
      rawUrl: `${c.env.BASE_URL}/${id}/raw`,
      deleteUrl: `${c.env.BASE_URL}/api/v1/${id}`,
      deleteToken,
      expiresAt: metadata.expiresAt,
    }

    return c.json(response, 201)
  })

  app.post("/api/v1/multipart/init", async (c) => {
    const contentType = c.req.header("X-Content-Type") ?? "application/octet-stream"
    const filename = c.req.header("X-Filename") ?? undefined
    const expiresIn = c.req.header("X-Expires-In")
    const burn = c.req.header("X-Burn") === "true"

    const id = generateId()
    const deleteToken = generateDeleteToken()

    const multipartUpload = await c.env.STORAGE.createMultipartUpload(id, {
      customMetadata: { contentType, filename: filename ?? "" },
    })

    const session: MultipartUploadSession = {
      id,
      uploadId: multipartUpload.uploadId,
      deleteToken,
      contentType,
      filename,
      expiresIn: expiresIn ? parseInt(expiresIn) : undefined,
      burn,
      parts: [],
      createdAt: new Date().toISOString(),
    }

    await c.env.CONTENT.put(`multipart:${id}`, JSON.stringify(session), {
      expirationTtl: 3600,
    })

    return c.json({ id, uploadId: multipartUpload.uploadId, deleteToken })
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
    const ttlSeconds = session.expiresIn && session.expiresIn > 0 ? session.expiresIn : DEFAULT_TTL_SECONDS

    const metadata: ContentMetadata = {
      id,
      deleteToken: session.deleteToken,
      contentType: session.contentType,
      size: totalSize ? parseInt(totalSize) : 0,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      views: 0,
      maxViews: session.burn ? 1 : undefined,
      filename: session.filename,
      storageType: "r2",
    }

    const stored = { metadata }
    await c.env.CONTENT.put(`content:${id}`, JSON.stringify(stored), {
      expirationTtl: ttlSeconds,
    })

    await c.env.CONTENT.delete(`multipart:${id}`)

    const response: PushResponse = {
      id,
      url: `${c.env.BASE_URL}/${id}`,
      rawUrl: `${c.env.BASE_URL}/${id}/raw`,
      deleteUrl: `${c.env.BASE_URL}/api/v1/${id}`,
      deleteToken: session.deleteToken,
      expiresAt: metadata.expiresAt,
    }

    return c.json(response, 201)
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
