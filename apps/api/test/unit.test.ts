import { describe, it, expect, beforeEach, vi } from "vitest"
import { app } from "../src/index"
import type { Env } from "../src/types"

type JsonResponse = Record<string, unknown>

function encodeBody(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value
}

function toReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function readBody(body: string | ReadableStream | Uint8Array): Promise<Uint8Array> {
  if (typeof body === "string" || body instanceof Uint8Array) {
    return encodeBody(body)
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (value) {
      chunks.push(value)
      total += value.length
    }
  }

  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

function createMockEnv(): Env {
  const kvStore = new Map<string, string>()
  const r2Store = new Map<string, { body: Uint8Array; customMetadata?: Record<string, string> }>()
  const multipartUploads = new Map<string, { key: string; customMetadata?: Record<string, string> }>()
  const multipartParts = new Map<string, Map<number, Uint8Array>>()

  return {
    BASE_URL: "https://test.shrd.sh",
    CONTENT: {
      get: vi.fn(async (key: string, format?: string) => {
        const value = kvStore.get(key)
        if (!value) return null
        if (format === "json") return JSON.parse(value)
        return value
      }),
      put: vi.fn(async (key: string, value: string) => {
        kvStore.set(key, value)
      }),
      delete: vi.fn(async (key: string) => {
        kvStore.delete(key)
      }),
    } as unknown as KVNamespace,
    STORAGE: {
      get: vi.fn(async (key: string) => {
        const obj = r2Store.get(key)
        if (!obj) return null
        return {
          text: async () => new TextDecoder().decode(obj.body),
          body: toReadableStream(obj.body),
          customMetadata: obj.customMetadata,
        }
      }),
      put: vi.fn(async (key: string, body: string | ReadableStream | Uint8Array, options?: { customMetadata?: Record<string, string> }) => {
        r2Store.set(key, { body: await readBody(body), customMetadata: options?.customMetadata })
      }),
      delete: vi.fn(async (key: string) => {
        r2Store.delete(key)
      }),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
      createMultipartUpload: vi.fn(async (key: string, options?: { customMetadata?: Record<string, string> }) => {
        const uploadId = `${key}-upload`
        multipartUploads.set(uploadId, { key, customMetadata: options?.customMetadata })
        multipartParts.set(uploadId, new Map())
        return { uploadId }
      }),
      resumeMultipartUpload: vi.fn((key: string, uploadId: string) => ({
        uploadPart: vi.fn(async (partNumber: number, body: string | ReadableStream | Uint8Array) => {
          const session = multipartParts.get(uploadId)
          if (!session) {
            throw new Error("Upload session not found")
          }
          session.set(partNumber, await readBody(body))
          return { etag: `${uploadId}-${partNumber}` }
        }),
        complete: vi.fn(async (parts: Array<{ partNumber: number }>) => {
          const session = multipartParts.get(uploadId)
          const upload = multipartUploads.get(uploadId)
          if (!session || !upload) {
            throw new Error("Upload session not found")
          }
          const ordered = parts.map((part) => session.get(part.partNumber) ?? new Uint8Array())
          const total = ordered.reduce((sum, chunk) => sum + chunk.length, 0)
          const merged = new Uint8Array(total)
          let offset = 0
          for (const chunk of ordered) {
            merged.set(chunk, offset)
            offset += chunk.length
          }
          r2Store.set(key, { body: merged, customMetadata: upload.customMetadata })
        }),
      })),
    } as unknown as R2Bucket,
    DB: {} as D1Database,
  }
}

describe("Health endpoint", () => {
  it("returns status ok", async () => {
    const env = createMockEnv()
    const res = await app.request("/health", {}, env)
    
    expect(res.status).toBe(200)
    const body = await res.json() as JsonResponse
    expect(body.status).toBe("ok")
    expect(body.timestamp).toBeDefined()
  })
})

describe("Push endpoint", () => {
  let env: Env

  beforeEach(() => {
    env = createMockEnv()
  })

  it("creates a share with valid content", async () => {
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello, World!" }),
    }, env)

    expect(res.status).toBe(201)
    const body = await res.json() as JsonResponse
    expect(body.id).toBeDefined()
    expect(body.id).toHaveLength(6)
    expect(body.url).toContain(body.id)
    expect(body.rawUrl).toContain(`${body.id}/raw`)
    expect(body.deleteToken).toBeDefined()
    expect(body.deleteToken).toHaveLength(32)
    expect(body.expiresAt).toBeDefined()
  })

  it("sets custom content type", async () => {
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        content: '{"key": "value"}', 
        contentType: "application/json" 
      }),
    }, env)

    expect(res.status).toBe(201)
    const body = await res.json() as JsonResponse
    expect(body.id).toBeDefined()
  })

  it("sets custom filename", async () => {
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        content: "file content", 
        filename: "test.txt" 
      }),
    }, env)

    expect(res.status).toBe(201)
    expect(env.CONTENT.put).toHaveBeenCalled()
  })

  it("respects custom expiry", async () => {
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        content: "expires soon", 
        expiresIn: 3600 
      }),
    }, env)

    expect(res.status).toBe(201)
    const body = await res.json() as JsonResponse
    expect(body.expiresAt).toBeDefined()
    
    const expiresAt = new Date(body.expiresAt as string)
    const now = new Date()
    const diffSeconds = (expiresAt.getTime() - now.getTime()) / 1000
    expect(diffSeconds).toBeGreaterThan(3500)
    expect(diffSeconds).toBeLessThan(3700)
  })

  it("accepts string expiry values", async () => {
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "string expiry",
        expire: "7d",
      }),
    }, env)

    expect(res.status).toBe(201)
    const body = await res.json() as JsonResponse
    const expiresAt = new Date(body.expiresAt as string)
    const diffSeconds = (expiresAt.getTime() - Date.now()) / 1000
    expect(diffSeconds).toBeGreaterThan(7 * 24 * 60 * 60 - 100)
  })

  it("supports never-expiring content", async () => {
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "persistent",
        expire: "never",
      }),
    }, env)

    expect(res.status).toBe(201)
    const body = await res.json() as JsonResponse
    expect(body.expiresAt).toBeNull()
    expect(env.CONTENT.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      {}
    )
  })

  it("rejects invalid expiry values", async () => {
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "bad expiry",
        expire: "tomorrow",
      }),
    }, env)

    expect(res.status).toBe(400)
    const body = await res.json() as JsonResponse
    expect(body.error).toBe("Invalid expiry value")
  })

  it("uses custom names as stable share ids", async () => {
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "named share",
        name: "release_notes",
      }),
    }, env)

    expect(res.status).toBe(201)
    const body = await res.json() as JsonResponse
    expect(body.id).toBe("release_notes")
    expect(body.name).toBe("release_notes")

    const metaRes = await app.request("/release_notes/meta", {}, env)
    const meta = await metaRes.json() as JsonResponse
    expect(meta.name).toBe("release_notes")
  })

  it("rejects duplicate custom names", async () => {
    await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "first",
        name: "deploy-log",
      }),
    }, env)

    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "second",
        name: "deploy-log",
      }),
    }, env)

    expect(res.status).toBe(409)
  })

  it("rejects reserved names", async () => {
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "reserved",
        name: "health",
      }),
    }, env)

    expect(res.status).toBe(400)
  })

  it("rejects empty content", async () => {
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    }, env)

    expect(res.status).toBe(400)
    const body = await res.json() as JsonResponse
    expect(body.error).toBe("Content is required")
  })

  it("rejects missing content field", async () => {
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, env)

    expect(res.status).toBe(400)
  })

  it("rejects invalid JSON", async () => {
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    }, env)

    expect(res.status).toBe(400)
    const body = await res.json() as JsonResponse
    expect(body.error).toBe("Invalid JSON")
  })

  it("handles unicode content", async () => {
    const content = "Hello 世界 🌍 Привет мир"
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }, env)

    expect(res.status).toBe(201)
  })
})

describe("Get content endpoints", () => {
  let env: Env
  let testId: string
  let deleteToken: string

  beforeEach(async () => {
    env = createMockEnv()
    
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Test content" }),
    }, env)
    
    const body = await res.json() as JsonResponse
    testId = body.id as string
    deleteToken = body.deleteToken as string
  })

  it("retrieves raw content", async () => {
    const res = await app.request(`/${testId}/raw`, {}, env)
    
    expect(res.status).toBe(200)
    const content = await res.text()
    expect(content).toBe("Test content")
  })

  it("retrieves content with default accept header", async () => {
    const res = await app.request(`/${testId}`, {
      headers: { "Accept": "text/plain" },
    }, env)
    
    expect(res.status).toBe(200)
    const content = await res.text()
    expect(content).toBe("Test content")
  })

  it("returns HTML page with Accept: text/html", async () => {
    const res = await app.request(`/${testId}`, {
      headers: { "Accept": "text/html" },
    }, env)
    
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const html = await res.text()
    expect(html).toContain("<!DOCTYPE html>")
    expect(html).toContain("Test content")
    expect(html).toContain("Copy Link")
  })

  it("includes product metadata on HTML share pages", async () => {
    const createRes = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "launch checklist",
        name: "release_notes",
        expire: "never",
        encrypted: true,
        burn: true,
      }),
    }, env)

    const created = await createRes.json() as JsonResponse
    const htmlRes = await app.request(`/${created.id}`, {
      headers: { "Accept": "text/html" },
    }, env)

    expect(htmlRes.status).toBe(200)
    const html = await htmlRes.text()
    expect(html).toContain("named share")
    expect(html).toContain("encrypted")
    expect(html).toContain("view once")
    expect(html).toContain("permanent")
    expect(html).toContain("never expires")
  })

  it("exposes burn metadata for the CLI and web clients", async () => {
    const createRes = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "burn flag",
        burn: true,
      }),
    }, env)

    const created = await createRes.json() as JsonResponse
    const metaRes = await app.request(`/${created.id}/meta`, {}, env)
    const meta = await metaRes.json() as JsonResponse
    expect(meta.burn).toBe(true)
  })

  it("returns 404 for non-existent content", async () => {
    const res = await app.request("/nonexistent123/raw", {}, env)
    
    expect(res.status).toBe(404)
    const body = await res.json() as JsonResponse
    expect(body.error).toBe("Not found")
  })
})

describe("Burn after read", () => {
  it("deletes burn-after-read content after the first raw request", async () => {
    const env = createMockEnv()

    const createRes = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "burn me",
        burn: true,
      }),
    }, env)

    const created = await createRes.json() as JsonResponse
    const id = created.id as string

    const firstRead = await app.request(`/${id}/raw`, {}, env)
    expect(firstRead.status).toBe(200)
    expect(await firstRead.text()).toBe("burn me")

    const secondRead = await app.request(`/${id}/raw`, {}, env)
    expect(secondRead.status).toBe(404)
  })
})

describe("Upload endpoints", () => {
  let env: Env

  beforeEach(() => {
    env = createMockEnv()
  })

  it("stores binary uploads with string expiry and custom name", async () => {
    const res = await app.request("/api/v1/upload", {
      method: "POST",
      headers: {
        "Content-Length": "4",
        "X-Content-Type": "application/octet-stream",
        "X-Filename": "blob.bin",
        "X-Expire": "1h",
        "X-Name": "binary_blob",
      },
      body: "test",
    }, env)

    expect(res.status).toBe(201)
    const body = await res.json() as JsonResponse
    expect(body.id).toBe("binary_blob")
    expect(body.name).toBe("binary_blob")

    const metaRes = await app.request("/binary_blob/meta", {}, env)
    const meta = await metaRes.json() as JsonResponse
    expect(meta.storageType).toBe("r2")
    expect(meta.filename).toBe("blob.bin")

    const rawRes = await app.request("/binary_blob/raw", {}, env)
    expect(rawRes.status).toBe(200)
    expect(await rawRes.text()).toBe("test")
  })

  it("supports never-expiring uploads", async () => {
    const res = await app.request("/api/v1/upload", {
      method: "POST",
      headers: {
        "Content-Length": "3",
        "X-Expire": "never",
      },
      body: "raw",
    }, env)

    expect(res.status).toBe(201)
    const body = await res.json() as JsonResponse
    expect(body.expiresAt).toBeNull()
  })

  it("keeps backward compatibility for legacy string expiry headers", async () => {
    const res = await app.request("/api/v1/upload", {
      method: "POST",
      headers: {
        "Content-Length": "4",
        "X-Expires-In": "7d",
      },
      body: "test",
    }, env)

    expect(res.status).toBe(201)
    const body = await res.json() as JsonResponse
    const expiresAt = new Date(body.expiresAt as string)
    const diffSeconds = (expiresAt.getTime() - Date.now()) / 1000
    expect(diffSeconds).toBeGreaterThan(7 * 24 * 60 * 60 - 100)
  })
})

describe("Multipart uploads", () => {
  let env: Env

  beforeEach(() => {
    env = createMockEnv()
  })

  it("completes multipart uploads with custom names", async () => {
    const initRes = await app.request("/api/v1/multipart/init", {
      method: "POST",
      headers: {
        "X-Content-Type": "application/octet-stream",
        "X-Filename": "archive.tar",
        "X-Expire": "7d",
        "X-Name": "archive_bundle",
      },
    }, env)

    expect(initRes.status).toBe(200)
    const init = await initRes.json() as JsonResponse
    const uploadId = init.uploadId as string

    const partRes = await app.request("/api/v1/multipart/archive_bundle/part/1", {
      method: "PUT",
      headers: {
        "X-Upload-Id": uploadId,
      },
      body: "hello",
    }, env)

    expect(partRes.status).toBe(200)

    const completeRes = await app.request("/api/v1/multipart/archive_bundle/complete", {
      method: "POST",
      headers: {
        "X-Upload-Id": uploadId,
        "X-Total-Size": "5",
      },
    }, env)

    expect(completeRes.status).toBe(201)
    const completed = await completeRes.json() as JsonResponse
    expect(completed.id).toBe("archive_bundle")

    const rawRes = await app.request("/archive_bundle/raw", {}, env)
    expect(await rawRes.text()).toBe("hello")
  })
})

describe("Metadata endpoint", () => {
  let env: Env
  let testId: string

  beforeEach(async () => {
    env = createMockEnv()
    
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        content: "Test content",
        filename: "test.txt",
        contentType: "text/plain"
      }),
    }, env)
    
    const body = await res.json() as JsonResponse
    testId = body.id as string
  })

  it("returns metadata for existing content", async () => {
    const res = await app.request(`/${testId}/meta`, {}, env)
    
    expect(res.status).toBe(200)
    const body = await res.json() as JsonResponse
    expect(body.id).toBe(testId)
    expect(body.contentType).toBe("text/plain")
    expect(body.filename).toBe("test.txt")
    expect(body.size).toBeGreaterThan(0)
    expect(body.createdAt).toBeDefined()
    expect(body.views).toBeDefined()
    expect(body.storageType).toBe("kv")
    expect(body.name).toBeNull()
  })

  it("returns 404 for non-existent content", async () => {
    const res = await app.request("/nonexistent123/meta", {}, env)
    
    expect(res.status).toBe(404)
  })
})

describe("Delete endpoint", () => {
  let env: Env
  let testId: string
  let deleteToken: string

  beforeEach(async () => {
    env = createMockEnv()
    
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Delete me" }),
    }, env)
    
    const body = await res.json() as JsonResponse
    testId = body.id as string
    deleteToken = body.deleteToken as string
  })

  it("deletes with valid token", async () => {
    const res = await app.request(`/api/v1/${testId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${deleteToken}` },
    }, env)
    
    expect(res.status).toBe(200)
    const body = await res.json() as JsonResponse
    expect(body.success).toBe(true)

    const getRes = await app.request(`/${testId}/raw`, {}, env)
    expect(getRes.status).toBe(404)
  })

  it("rejects delete without auth", async () => {
    const res = await app.request(`/api/v1/${testId}`, {
      method: "DELETE",
    }, env)
    
    expect(res.status).toBe(401)
  })

  it("rejects delete with wrong token", async () => {
    const res = await app.request(`/api/v1/${testId}`, {
      method: "DELETE",
      headers: { "Authorization": "Bearer wrongtoken" },
    }, env)
    
    expect(res.status).toBe(403)
  })

  it("rejects delete for non-existent content", async () => {
    const res = await app.request("/api/v1/nonexistent123", {
      method: "DELETE",
      headers: { "Authorization": "Bearer sometoken" },
    }, env)
    
    expect(res.status).toBe(403)
  })
})

describe("CORS", () => {
  it("includes CORS headers", async () => {
    const env = createMockEnv()
    const res = await app.request("/health", {}, env)
    
    expect(res.headers.get("access-control-allow-origin")).toBeDefined()
  })

  it("handles OPTIONS preflight", async () => {
    const env = createMockEnv()
    const res = await app.request("/api/v1/push", {
      method: "OPTIONS",
      headers: {
        "Origin": "https://example.com",
        "Access-Control-Request-Method": "POST",
      },
    }, env)
    
    expect(res.status).toBe(204)
  })
})

describe("ID generation", () => {
  it("generates unique IDs", async () => {
    const env = createMockEnv()
    const ids = new Set<string>()
    
    for (let i = 0; i < 10; i++) {
      const res = await app.request("/api/v1/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `Test ${i}` }),
      }, env)
      
      const body = await res.json() as JsonResponse
      ids.add(body.id as string)
    }
    
    expect(ids.size).toBe(10)
  })

  it("generates IDs with valid characters only", async () => {
    const env = createMockEnv()
    const validChars = /^[23456789abcdefghjkmnpqrstuvwxyz]+$/
    
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/api/v1/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `Test ${i}` }),
      }, env)
      
      const body = await res.json() as JsonResponse
      expect(body.id).toMatch(validChars)
    }
  })
})
