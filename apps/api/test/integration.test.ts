import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startApiServer } from "./helpers/server"

const externalApiUrl = process.env.SHRD_API_URL?.replace(/\/$/, "")
const createdShares: { id: string; token: string }[] = []
let apiUrl = externalApiUrl ?? ""
let localApi: Awaited<ReturnType<typeof startApiServer>> | undefined

interface PushResponse {
  id: string
  url: string
  rawUrl: string
  deleteUrl: string
  deleteToken: string
  expiresAt: string | null
  name: string | null
}

function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function createTextShare(content: string, body: Record<string, unknown> = {}): Promise<PushResponse> {
  const response = await fetch(`${apiUrl}/api/v1/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, ...body }),
  })
  expect(response.status).toBe(201)
  const created = await readJson<PushResponse>(response)
  createdShares.push({ id: created.id, token: created.deleteToken })
  return created
}

async function deleteShare(id: string, token: string): Promise<void> {
  await fetch(`${apiUrl}/api/v1/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {})
}

beforeAll(async () => {
  if (!externalApiUrl) {
    localApi = await startApiServer()
    apiUrl = localApi.url
  }
})

afterAll(async () => {
  await Promise.all(createdShares.map((share) => deleteShare(share.id, share.token)))
  await localApi?.close()
})

describe("API integration", () => {
  it("serves health", async () => {
    const response = await fetch(`${apiUrl}/health`)
    expect(response.status).toBe(200)
    expect(await readJson<{ status: string }>(response)).toMatchObject({ status: "ok" })
  })

  it("round trips text with the one-year default expiry", async () => {
    const content = `integration text ${Date.now()}`
    const created = await createTextShare(content)
    const days = (new Date(created.expiresAt!).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(364)

    const raw = await fetch(created.rawUrl)
    expect(raw.status).toBe(200)
    expect(await raw.text()).toBe(content)
  })

  it("keeps metadata and share URL downloads compatible", async () => {
    const name = uniqueName("integration_file")
    const created = await createTextShare("file payload", {
      name,
      filename: "note.txt",
      contentType: "text/plain",
    })

    const meta = await fetch(`${apiUrl}/${created.id}/meta`)
    expect(meta.status).toBe(200)
    expect(await readJson<Record<string, unknown>>(meta)).toMatchObject({
      id: name,
      contentType: "text/plain",
      filename: "note.txt",
      encrypted: false,
      name,
      storageType: "kv",
    })

    const file = await fetch(created.url, { headers: { Accept: "text/html" } })
    expect(file.status).toBe(200)
    expect(file.headers.get("content-type")).toContain("text/plain")
    expect(file.headers.get("content-disposition")).toContain("note.txt")
    expect(await file.text()).toBe("file payload")
  })

  it("round trips direct uploads", async () => {
    const name = uniqueName("integration_upload")
    const response = await fetch(`${apiUrl}/api/v1/upload`, {
      method: "POST",
      headers: {
        "X-Name": name,
        "X-Content-Type": "text/plain",
        "X-Filename": "payload.txt",
      },
      body: "direct upload payload",
    })
    expect(response.status).toBe(201)
    const created = await readJson<PushResponse>(response)
    createdShares.push({ id: created.id, token: created.deleteToken })

    const meta = await fetch(`${apiUrl}/${created.id}/meta`)
    expect(await readJson<Record<string, unknown>>(meta)).toMatchObject({
      id: name,
      filename: "payload.txt",
      storageType: "r2",
    })

    const raw = await fetch(created.rawUrl)
    expect(await raw.text()).toBe("direct upload payload")
  })

  it("rejects invalid expiry and duplicate names", async () => {
    const badExpiry = await fetch(`${apiUrl}/api/v1/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "bad", expire: "tomorrow" }),
    })
    expect(badExpiry.status).toBe(400)

    const name = uniqueName("integration_duplicate")
    await createTextShare("first", { name })
    const duplicate = await fetch(`${apiUrl}/api/v1/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "second", name }),
    })
    expect(duplicate.status).toBe(409)
  })
})
