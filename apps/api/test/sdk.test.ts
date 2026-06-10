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

  it("uploads file bodies through the direct upload endpoint", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      id: "payload",
      url: "https://test.shrd.sh/payload",
      rawUrl: "https://test.shrd.sh/payload/raw",
      deleteToken: "token",
      expiresAt: null,
      name: "payload",
    }), { status: 201 }))

    const client = createClient({ baseUrl: "https://test.shrd.sh" })
    const result = await client.upload("file body", {
      contentType: "text/plain",
      filename: "payload.txt",
      name: "payload",
      expire: "365d",
    })

    expect(result.rawUrl).toBe("https://test.shrd.sh/payload/raw")
    expect(fetch).toHaveBeenCalledWith("https://test.shrd.sh/api/v1/upload", expect.objectContaining({
      method: "POST",
      headers: {
        "X-Content-Type": "text/plain",
        "X-Filename": "payload.txt",
        "X-Name": "payload",
        "X-Expire": "365d",
      },
      body: "file body",
    }))
  })

  it("downloads file responses without assuming text", async () => {
    const response = new Response("payload", {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    })
    vi.mocked(fetch).mockResolvedValueOnce(response)

    const client = createClient({ baseUrl: "https://test.shrd.sh" })
    const downloaded = await client.download("payload")

    expect(downloaded).toBe(response)
    expect(fetch).toHaveBeenCalledWith("https://test.shrd.sh/payload/raw")
  })
})
