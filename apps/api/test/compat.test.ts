import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient } from "../../../packages/sdk/src/index"
import { EXPIRY_MS } from "../../../packages/shared/src/types"
import { app } from "../src/index"
import { createMockEnv } from "./helpers/mock-env"

type JsonBody = Record<string, unknown>

function daysFromNow(iso: string | null | undefined): number {
  expect(iso).toBeTruthy()
  return (new Date(iso!).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
}

async function json(response: Response): Promise<JsonBody> {
  return await response.json() as JsonBody
}

describe("Compatibility contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps one-year expiry aligned across shared, sdk, and api", async () => {
    expect(EXPIRY_MS["365d"]).toBe(365 * 24 * 60 * 60 * 1000)

    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body))
      expect(body.expiresIn).toBe("365d")
      return new Response(JSON.stringify({
        id: "compat",
        url: "https://test.shrd.sh/compat",
        rawUrl: "https://test.shrd.sh/compat/raw",
        deleteToken: "token",
        expiresAt: new Date(Date.now() + EXPIRY_MS["365d"]!).toISOString(),
        name: null,
      }), { status: 201 })
    }))

    const client = createClient({ baseUrl: "https://test.shrd.sh" })
    const result = await client.push("compat", { expiresIn: "365d" })
    expect(result.expiresAt).toBeTruthy()

    const env = createMockEnv()
    const created = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "default expiry" }),
    }, env)
    expect(created.status).toBe(201)
    const body = await json(created)
    expect(daysFromNow(body.expiresAt as string)).toBeGreaterThan(364)
  })

  it("keeps metadata fields required by CLI clients", async () => {
    const env = createMockEnv()
    const created = await app.request("/api/v1/upload", {
      method: "POST",
      headers: {
        "X-Content-Type": "application/octet-stream",
        "X-Filename": "payload.bin",
        "X-Name": "compat_payload",
      },
      body: "payload",
    }, env)
    expect(created.status).toBe(201)

    const meta = await app.request("/compat_payload/meta", {}, env)
    expect(meta.status).toBe(200)
    expect(await json(meta)).toMatchObject({
      id: "compat_payload",
      contentType: "application/octet-stream",
      filename: "payload.bin",
      encrypted: false,
      name: "compat_payload",
      storageType: "r2",
    })
  })

  it("keeps custom names consistent across push, direct upload, and multipart init", async () => {
    const env = createMockEnv()
    const push = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "push", name: "compat_push" }),
    }, env)
    const upload = await app.request("/api/v1/upload", {
      method: "POST",
      headers: { "X-Name": "compat_upload" },
      body: "upload",
    }, env)
    const multipart = await app.request("/api/v1/multipart/init", {
      method: "POST",
      headers: { "X-Name": "compat_multipart" },
    }, env)

    expect((await json(push)).id).toBe("compat_push")
    expect((await json(upload)).id).toBe("compat_upload")
    expect((await json(multipart)).id).toBe("compat_multipart")
  })

  it("serves share URLs as direct file downloads", async () => {
    const env = createMockEnv()
    const created = await app.request("/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "file payload", filename: "payload.txt", name: "compat_file" }),
    }, env)
    expect(created.status).toBe(201)

    const file = await app.request("/compat_file", {
      headers: { Accept: "text/html" },
    }, env)
    expect(file.headers.get("content-type")).toContain("text/plain")
    expect(file.headers.get("content-disposition")).toContain("payload.txt")
    expect(await file.text()).toBe("file payload")
  })
})
