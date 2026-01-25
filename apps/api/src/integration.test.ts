import { describe, it, expect, afterAll } from "vitest"

const API_URL = process.env.SHRD_API_URL || "https://shrd.stoff.dev"

interface PushResponse {
  id: string
  url: string
  rawUrl: string
  deleteUrl: string
  deleteToken: string
  expiresAt?: string
}

const createdShares: { id: string; token: string }[] = []

async function push(content: string, options?: Record<string, unknown>): Promise<PushResponse> {
  const res = await fetch(`${API_URL}/api/v1/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, ...options }),
  })
  const data = await res.json() as PushResponse
  if (data.id && data.deleteToken) {
    createdShares.push({ id: data.id, token: data.deleteToken })
  }
  return data
}

afterAll(async () => {
  await Promise.all(
    createdShares.map(({ id, token }) =>
      fetch(`${API_URL}/api/v1/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {})
    )
  )
})

describe("Health", () => {
  it("returns status ok", async () => {
    const res = await fetch(`${API_URL}/health`)
    expect(res.status).toBe(200)
    const data = await res.json() as { status: string }
    expect(data.status).toBe("ok")
  })
})

describe("Push", () => {
  it("creates a share with valid content", async () => {
    const res = await fetch(`${API_URL}/api/v1/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello, World!" }),
    })
    expect(res.status).toBe(201)
    const data = await res.json() as PushResponse
    expect(data.id).toHaveLength(6)
    expect(data.deleteToken).toHaveLength(32)
    expect(data.url).toContain(data.id)
    createdShares.push({ id: data.id, token: data.deleteToken })
  })

  it("rejects empty content", async () => {
    const res = await fetch(`${API_URL}/api/v1/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    })
    expect(res.status).toBe(400)
  })

  it("rejects missing content", async () => {
    const res = await fetch(`${API_URL}/api/v1/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it("rejects invalid JSON", async () => {
    const res = await fetch(`${API_URL}/api/v1/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    })
    expect(res.status).toBe(400)
  })

  it("handles unicode content", async () => {
    const content = "Hello 世界 🌍 Привет"
    const data = await push(content)
    expect(data.id).toBeDefined()
    
    const res = await fetch(`${API_URL}/${data.id}/raw`)
    expect(await res.text()).toBe(content)
  })

  it("sets custom expiry", async () => {
    const data = await push("expires soon", { expiresIn: 3600 })
    expect(data.expiresAt).toBeDefined()
    const expiresAt = new Date(data.expiresAt!)
    const diff = (expiresAt.getTime() - Date.now()) / 1000
    expect(diff).toBeGreaterThan(3500)
    expect(diff).toBeLessThan(3700)
  })
})

describe("Get Content", () => {
  it("retrieves raw content", async () => {
    const content = "test content " + Date.now()
    const data = await push(content)
    
    const res = await fetch(`${API_URL}/${data.id}/raw`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(content)
  })

  it("returns 404 for non-existent content", async () => {
    const res = await fetch(`${API_URL}/nonexistent123/raw`)
    expect(res.status).toBe(404)
  })

  it("returns metadata with Accept: text/html", async () => {
    const data = await push("metadata test")
    
    const res = await fetch(`${API_URL}/${data.id}`, {
      headers: { Accept: "text/html" },
    })
    expect(res.status).toBe(200)
    const meta = await res.json() as Record<string, unknown>
    expect(meta.id).toBe(data.id)
    expect(meta.contentType).toBeDefined()
  })
})

describe("Metadata", () => {
  it("returns metadata for existing content", async () => {
    const data = await push("meta test", { filename: "test.txt" })
    
    const res = await fetch(`${API_URL}/${data.id}/meta`)
    expect(res.status).toBe(200)
    const meta = await res.json() as Record<string, unknown>
    expect(meta.id).toBe(data.id)
    expect(meta.filename).toBe("test.txt")
    expect(meta.size).toBeGreaterThan(0)
    expect(meta.createdAt).toBeDefined()
  })

  it("returns 404 for non-existent content", async () => {
    const res = await fetch(`${API_URL}/nonexistent123/meta`)
    expect(res.status).toBe(404)
  })
})

describe("Delete", () => {
  it("rejects delete without auth", async () => {
    const data = await push("delete test")
    const res = await fetch(`${API_URL}/api/v1/${data.id}`, { method: "DELETE" })
    expect(res.status).toBe(401)
  })

  it("rejects delete with wrong token", async () => {
    const data = await push("delete test")
    const res = await fetch(`${API_URL}/api/v1/${data.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer wrongtoken" },
    })
    expect(res.status).toBe(403)
  })

  it("deletes with correct token", async () => {
    const data = await push("delete me")
    const idx = createdShares.findIndex(s => s.id === data.id)
    if (idx !== -1) createdShares.splice(idx, 1)
    
    const res = await fetch(`${API_URL}/api/v1/${data.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${data.deleteToken}` },
    })
    expect(res.status).toBe(200)
    
    const check = await fetch(`${API_URL}/${data.id}/raw`)
    expect(check.status).toBe(404)
  })
})

describe("CORS", () => {
  it("includes CORS headers", async () => {
    const res = await fetch(`${API_URL}/health`)
    expect(res.headers.get("access-control-allow-origin")).toBeDefined()
  })

  it("handles OPTIONS preflight", async () => {
    const res = await fetch(`${API_URL}/api/v1/push`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
      },
    })
    expect([200, 204]).toContain(res.status)
  })
})

describe("Edge Cases", () => {
  it("handles very long ID gracefully", async () => {
    const longId = "a".repeat(100)
    const res = await fetch(`${API_URL}/${longId}/raw`)
    expect(res.status).toBe(404)
  })

  it("handles special characters in ID safely", async () => {
    const res = await fetch(`${API_URL}/../../../etc/passwd/raw`)
    expect([400, 404]).toContain(res.status)
  })
})

describe("Performance", () => {
  it("push responds in < 2000ms", async () => {
    const start = Date.now()
    await push("perf test")
    const duration = Date.now() - start
    expect(duration).toBeLessThan(2000)
  })

  it("get responds in < 500ms", async () => {
    const data = await push("perf test get")
    const start = Date.now()
    await fetch(`${API_URL}/${data.id}/raw`)
    const duration = Date.now() - start
    expect(duration).toBeLessThan(500)
  })

  it("health responds in < 200ms", async () => {
    const start = Date.now()
    await fetch(`${API_URL}/health`)
    const duration = Date.now() - start
    expect(duration).toBeLessThan(200)
  })
})
