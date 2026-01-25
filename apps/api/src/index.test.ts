import { describe, it, expect, beforeEach, vi } from "vitest"
import { app } from "./index"
import type { Env, StoredContent } from "./types"

function createMockEnv(): Env {
  const kvStore = new Map<string, string>()
  const r2Store = new Map<string, { body: string; customMetadata?: Record<string, string> }>()

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
          text: async () => obj.body,
          customMetadata: obj.customMetadata,
        }
      }),
      put: vi.fn(async (key: string, body: string, options?: { customMetadata?: Record<string, string> }) => {
        r2Store.set(key, { body, customMetadata: options?.customMetadata })
      }),
      delete: vi.fn(async (key: string) => {
        r2Store.delete(key)
      }),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
    } as unknown as R2Bucket,
    DB: {} as D1Database,
  }
}

describe("Health endpoint", () => {
  it("returns status ok", async () => {
    const env = createMockEnv()
    const res = await app.request("/health", {}, env)
    
    expect(res.status).toBe(200)
    const body = await res.json()
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
    const body = await res.json()
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
    const body = await res.json()
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
    const body = await res.json()
    expect(body.expiresAt).toBeDefined()
    
    const expiresAt = new Date(body.expiresAt)
    const now = new Date()
    const diffSeconds = (expiresAt.getTime() - now.getTime()) / 1000
    expect(diffSeconds).toBeGreaterThan(3500)
    expect(diffSeconds).toBeLessThan(3700)
  })

  it("rejects empty content", async () => {
    const res = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    }, env)

    expect(res.status).toBe(400)
    const body = await res.json()
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
    const body = await res.json()
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
    
    const body = await res.json()
    testId = body.id
    deleteToken = body.deleteToken
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

  it("returns metadata with Accept: text/html", async () => {
    const res = await app.request(`/${testId}`, {
      headers: { "Accept": "text/html" },
    }, env)
    
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(testId)
    expect(body.contentType).toBeDefined()
  })

  it("returns 404 for non-existent content", async () => {
    const res = await app.request("/nonexistent123/raw", {}, env)
    
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe("Not found")
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
    
    const body = await res.json()
    testId = body.id
  })

  it("returns metadata for existing content", async () => {
    const res = await app.request(`/${testId}/meta`, {}, env)
    
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(testId)
    expect(body.contentType).toBe("text/plain")
    expect(body.filename).toBe("test.txt")
    expect(body.size).toBeGreaterThan(0)
    expect(body.createdAt).toBeDefined()
    expect(body.views).toBeDefined()
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
    
    const body = await res.json()
    testId = body.id
    deleteToken = body.deleteToken
  })

  it("deletes with valid token", async () => {
    const res = await app.request(`/api/v1/${testId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${deleteToken}` },
    }, env)
    
    expect(res.status).toBe(200)
    const body = await res.json()
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
      
      const body = await res.json()
      ids.add(body.id)
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
      
      const body = await res.json()
      expect(body.id).toMatch(validChars)
    }
  })
})
