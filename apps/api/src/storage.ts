import type { Env, ContentMetadata, StoredContent } from "./types"

const KV_SIZE_LIMIT = 25 * 1024

export async function storeContent(
  env: Env,
  id: string,
  content: string,
  metadata: ContentMetadata,
  ttlSeconds?: number
): Promise<void> {
  const contentSize = new TextEncoder().encode(content).length

  if (contentSize <= KV_SIZE_LIMIT) {
    metadata.storageType = "kv"
    const stored: StoredContent = { metadata, content }
    const options: KVNamespacePutOptions = {}
    if (ttlSeconds) {
      options.expirationTtl = ttlSeconds
    }
    await env.CONTENT.put(`content:${id}`, JSON.stringify(stored), options)
  } else {
    metadata.storageType = "r2"
    await env.STORAGE.put(id, content, {
      customMetadata: { contentType: metadata.contentType },
    })
    const stored: StoredContent = { metadata }
    const options: KVNamespacePutOptions = {}
    if (ttlSeconds) {
      options.expirationTtl = ttlSeconds
    }
    await env.CONTENT.put(`content:${id}`, JSON.stringify(stored), options)
  }
}

export async function getContent(
  env: Env,
  id: string
): Promise<{ metadata: ContentMetadata; content: string } | null> {
  const stored = await env.CONTENT.get<StoredContent>(`content:${id}`, "json")
  if (!stored) return null

  if (stored.metadata.storageType === "kv" && stored.content) {
    return { metadata: stored.metadata, content: stored.content }
  }

  const r2Object = await env.STORAGE.get(id)
  if (!r2Object) return null

  const content = await r2Object.text()
  return { metadata: stored.metadata, content }
}

export async function getContentStream(
  env: Env,
  id: string
): Promise<{ metadata: ContentMetadata; body: ReadableStream } | null> {
  const stored = await env.CONTENT.get<StoredContent>(`content:${id}`, "json")
  if (!stored) return null

  if (stored.metadata.storageType === "kv" && stored.content) {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(stored.content))
        controller.close()
      },
    })
    return { metadata: stored.metadata, body }
  }

  const r2Object = await env.STORAGE.get(id)
  if (!r2Object) return null

  return { metadata: stored.metadata, body: r2Object.body }
}

export async function getMetadata(
  env: Env,
  id: string
): Promise<ContentMetadata | null> {
  const stored = await env.CONTENT.get<StoredContent>(`content:${id}`, "json")
  return stored?.metadata ?? null
}

export async function incrementViews(
  env: Env,
  id: string
): Promise<void> {
  const stored = await env.CONTENT.get<StoredContent>(`content:${id}`, "json")
  if (!stored) return

  stored.metadata.views += 1

  const options: KVNamespacePutOptions = {}
  if (stored.metadata.expiresAt) {
    const ttl = Math.floor(
      (new Date(stored.metadata.expiresAt).getTime() - Date.now()) / 1000
    )
    if (ttl > 0) {
      options.expirationTtl = ttl
    }
  }
  await env.CONTENT.put(`content:${id}`, JSON.stringify(stored), options)
}

export async function deleteContent(env: Env, id: string): Promise<boolean> {
  const stored = await env.CONTENT.get<StoredContent>(`content:${id}`, "json")
  if (!stored) return false

  if (stored.metadata.storageType === "r2") {
    await env.STORAGE.delete(id)
  }
  await env.CONTENT.delete(`content:${id}`)
  return true
}

export async function validateDeleteToken(
  env: Env,
  id: string,
  token: string
): Promise<boolean> {
  const metadata = await getMetadata(env, id)
  return metadata?.deleteToken === token
}
