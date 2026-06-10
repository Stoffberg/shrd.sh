import type { Env } from "../../src/types"

function encodeBody(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value
}

export function toReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
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

export function createMockEnv(baseUrl = "https://test.shrd.sh"): Env {
  const kvStore = new Map<string, string>()
  const r2Store = new Map<string, { body: Uint8Array; customMetadata?: Record<string, string> }>()
  const multipartUploads = new Map<string, { key: string; customMetadata?: Record<string, string> }>()
  const multipartParts = new Map<string, Map<number, Uint8Array>>()

  return {
    BASE_URL: baseUrl,
    CONTENT: {
      get: async (key: string, format?: string) => {
        const value = kvStore.get(key)
        if (!value) return null
        if (format === "json") return JSON.parse(value)
        return value
      },
      put: async (key: string, value: string) => {
        kvStore.set(key, value)
      },
      delete: async (key: string) => {
        kvStore.delete(key)
      },
    } as unknown as KVNamespace,
    STORAGE: {
      get: async (key: string) => {
        const obj = r2Store.get(key)
        if (!obj) return null
        return {
          text: async () => new TextDecoder().decode(obj.body),
          body: toReadableStream(obj.body),
          customMetadata: obj.customMetadata,
        }
      },
      put: async (key: string, body: string | ReadableStream | Uint8Array, options?: { customMetadata?: Record<string, string> }) => {
        const bytes = await readBody(body)
        r2Store.set(key, { body: bytes, customMetadata: options?.customMetadata })
        return { size: bytes.byteLength }
      },
      delete: async (key: string) => {
        r2Store.delete(key)
      },
      list: async () => ({ objects: [], truncated: false }),
      createMultipartUpload: async (key: string, options?: { customMetadata?: Record<string, string> }) => {
        const uploadId = `${key}-upload`
        multipartUploads.set(uploadId, { key, customMetadata: options?.customMetadata })
        multipartParts.set(uploadId, new Map())
        return { uploadId }
      },
      resumeMultipartUpload: (key: string, uploadId: string) => ({
        uploadPart: async (partNumber: number, body: string | ReadableStream | Uint8Array) => {
          const session = multipartParts.get(uploadId)
          if (!session) {
            throw new Error("Upload session not found")
          }
          session.set(partNumber, await readBody(body))
          return { etag: `${uploadId}-${partNumber}` }
        },
        complete: async (parts: Array<{ partNumber: number }>) => {
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
        },
        abort: async () => {
          multipartParts.delete(uploadId)
          multipartUploads.delete(uploadId)
        },
      }),
    } as unknown as R2Bucket,
    DB: {} as D1Database,
  }
}
