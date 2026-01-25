import { Hono } from "hono"
import { cors } from "hono/cors"
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

const generateId = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 6)
const generateDeleteToken = customAlphabet(
  "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ",
  32
)

const app = new Hono<{ Bindings: Env }>()

app.use("*", cors())

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

  const metadata: ContentMetadata = {
    id,
    deleteToken,
    contentType,
    size: contentSize,
    createdAt: now.toISOString(),
    views: 0,
    filename: body.filename,
    storageType: "kv",
  }

  // Default expiry: 24 hours for anonymous, can be overridden
  const DEFAULT_TTL_SECONDS = 24 * 60 * 60 // 24 hours
  const ttlSeconds = (body.expiresIn && body.expiresIn > 0) 
    ? body.expiresIn 
    : DEFAULT_TTL_SECONDS
  metadata.expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString()

  await storeContent(c.env, id, body.content, metadata, ttlSeconds)

  const baseUrl = c.env.BASE_URL
  const response: PushResponse = {
    id,
    url: `${baseUrl}/${id}`,
    rawUrl: `${baseUrl}/${id}/raw`,
    deleteUrl: `${baseUrl}/api/v1/${id}`,
    deleteToken,
    expiresAt: metadata.expiresAt,
  }

  return c.json(response, 201)
})

app.get("/:id", async (c) => {
  const id = c.req.param("id")
  const accept = c.req.header("Accept") ?? ""

  const result = await getContent(c.env, id)
  if (!result) {
    return c.json({ error: "Not found" }, 404)
  }

  await incrementViews(c.env, id)

  if (accept.includes("text/html")) {
    return c.json({
      id: result.metadata.id,
      contentType: result.metadata.contentType,
      size: result.metadata.size,
      createdAt: result.metadata.createdAt,
      expiresAt: result.metadata.expiresAt,
      views: result.metadata.views + 1,
      filename: result.metadata.filename,
    })
  }

  return c.text(result.content, 200, {
    "Content-Type": result.metadata.contentType,
  })
})

app.get("/:id/raw", async (c) => {
  const id = c.req.param("id")

  const result = await getContent(c.env, id)
  if (!result) {
    return c.json({ error: "Not found" }, 404)
  }

  await incrementViews(c.env, id)

  return c.text(result.content, 200, {
    "Content-Type": result.metadata.contentType,
  })
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

async function cleanupOrphanedR2(env: Env): Promise<{ deleted: number; checked: number }> {
  let deleted = 0
  let checked = 0
  let cursor: string | undefined

  do {
    const listed = await env.STORAGE.list({ cursor, limit: 100 })

    for (const object of listed.objects) {
      checked++
      const kvExists = await env.CONTENT.get(`content:${object.key}`)
      if (!kvExists) {
        await env.STORAGE.delete(object.key)
        deleted++
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)

  return { deleted, checked }
}

export { app }

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      cleanupOrphanedR2(env).then((result) => {
        console.log(`R2 cleanup: checked ${result.checked}, deleted ${result.deleted}`)
      })
    )
  },
}
