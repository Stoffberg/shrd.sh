export function getExecutionContext(c: { executionCtx: ExecutionContext }): ExecutionContext | undefined {
  try {
    return c.executionCtx
  } catch {
    return undefined
  }
}

export async function runAsync(ctx: ExecutionContext | undefined, promise: Promise<unknown>): Promise<void> {
  if (ctx?.waitUntil) {
    ctx.waitUntil(promise)
  } else {
    await promise
  }
}

export async function getFromCacheOrFetch(
  request: Request,
  ctx: ExecutionContext | undefined,
  fetchFn: () => Promise<Response>,
  handlers?: {
    onHit?: (response: Response) => Promise<void> | void
  }
): Promise<Response> {
  if (typeof caches === "undefined") {
    return fetchFn()
  }

  const cache = caches.default
  const cacheKey = new Request(request.url, { method: "GET" })

  const cached = await cache.match(cacheKey)
  if (cached) {
    await handlers?.onHit?.(cached.clone())
    return cached
  }

  const response = await fetchFn()

  if (response.ok && ctx?.waitUntil) {
    const toCache = response.clone()
    ctx.waitUntil(cache.put(cacheKey, toCache))
  }

  return response
}

export function createCachedResponse(content: string, contentType: string, expiresAt?: string): Response {
  const ttl = expiresAt
    ? Math.max(60, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
    : 86400 * 365

  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": `public, max-age=${ttl}, immutable`,
    },
  })
}

export function notFoundResponse(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  })
}

export function noCacheResponse(content: string, contentType: string): Response {
  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
  })
}
