import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http"
import { app } from "../../src/index"
import { createMockEnv } from "./mock-env"

function headersFromNode(headers: IncomingHttpHeaders): Headers {
  const result = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        result.append(key, entry)
      }
    } else if (value !== undefined) {
      result.set(key, value)
    }
  }
  return result
}

async function readRequestBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
  }
  if (chunks.length === 0) {
    return undefined
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export async function startApiServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const pending: Promise<unknown>[] = []
  const env = createMockEnv()
  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? "127.0.0.1"
    const url = new URL(req.url ?? "/", `http://${host}`)
    const method = req.method ?? "GET"
    const body = method === "GET" || method === "HEAD" ? undefined : await readRequestBody(req)
    const request = new Request(url, {
      method,
      headers: headersFromNode(req.headers),
      body,
    } as RequestInit)
    const response = await app.fetch(request, env, {
      waitUntil(promise) {
        pending.push(promise)
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext)
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    const responseBody = await response.arrayBuffer()
    res.end(Buffer.from(responseBody))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Server did not bind to a port")
  }
  env.BASE_URL = `http://127.0.0.1:${address.port}`

  return {
    url: env.BASE_URL,
    close: async () => {
      await Promise.allSettled(pending)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    },
  }
}
