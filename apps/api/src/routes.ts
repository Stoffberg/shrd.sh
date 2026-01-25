import { Hono } from "hono"
import { customAlphabet } from "nanoid"
import type { Env, PushRequest, PushResponse, ContentMetadata } from "./types"
import {
  storeContent,
  getContent,
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
import { renderContentPage, render404 } from "./html"

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
      const result = await getContent(c.env, id)
      if (!result) {
        return c.html(render404(), 404)
      }

      const { metadata, content } = result

      if (metadata.maxViews !== undefined) {
        await incrementViews(c.env, id)
        if (metadata.views + 1 >= metadata.maxViews) {
          runAsync(ctx, deleteContent(c.env, id))
        }
      } else {
        runAsync(ctx, incrementViews(c.env, id))
      }

      return c.html(renderContentPage(content, metadata, c.env.BASE_URL))
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
  const result = await getContent(env, id)
  if (!result) {
    return notFoundResponse()
  }

  const { metadata, content } = result

  if (metadata.maxViews !== undefined) {
    await incrementViews(env, id)
    if (metadata.views + 1 >= metadata.maxViews) {
      runAsync(ctx, deleteContent(env, id))
    }
    return noCacheResponse(content, metadata.contentType)
  }

  runAsync(ctx, incrementViews(env, id))
  return createCachedResponse(content, metadata.contentType, metadata.expiresAt)
}
