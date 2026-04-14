import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createClient } from "../../../packages/sdk/src/index"

describe("SDK client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("pushes shares with the canonical contract", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      id: "deploy-log",
      url: "https://test.shrd.sh/deploy-log",
      rawUrl: "https://test.shrd.sh/deploy-log/raw",
      deleteToken: "token",
      expiresAt: null,
      name: "deploy-log",
    }), { status: 201 }))

    const client = createClient({ baseUrl: "https://test.shrd.sh" })
    const result = await client.push("hello", {
      expire: "never",
      name: "deploy-log",
      contentType: "text/plain",
      filename: "log.txt",
    })

    expect(fetch).toHaveBeenCalledWith("https://test.shrd.sh/api/v1/push", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        content: "hello",
        expire: "never",
        name: "deploy-log",
        contentType: "text/plain",
        filename: "log.txt",
      }),
    }))
    expect(result.rawUrl).toBe("https://test.shrd.sh/deploy-log/raw")
    expect(result.raw).toBe(result.rawUrl)
    expect(result.name).toBe("deploy-log")
  })

  it("extracts ids from raw URLs with fragments", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("payload", { status: 200 }))

    const client = createClient({ baseUrl: "https://test.shrd.sh" })
    const result = await client.pull("https://test.shrd.sh/custom_slug/raw#key=secret")

    expect(result).toBe("payload")
    expect(fetch).toHaveBeenCalledWith("https://test.shrd.sh/custom_slug/raw")
  })

  it("requests metadata for named shares", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      id: "release_notes",
      contentType: "text/plain",
      size: 12,
      views: 2,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      filename: "notes.txt",
      encrypted: false,
      name: "release_notes",
      storageType: "kv",
    }), { status: 200 }))

    const client = createClient({ baseUrl: "https://test.shrd.sh" })
    const meta = await client.meta("release_notes")

    expect(meta.name).toBe("release_notes")
    expect(meta.storageType).toBe("kv")
    expect(fetch).toHaveBeenCalledWith("https://test.shrd.sh/release_notes/meta")
  })
})
