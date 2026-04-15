import type { Env } from "./types"

const schemaSupport = new WeakMap<object, Map<string, boolean>>()

export function hasD1(env: Env): boolean {
  return typeof env.DB?.prepare === "function"
}

export function shouldUseLegacyFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table|no such column|has no column named|SQLITE_ERROR|D1_ERROR/i.test(message)
}

export async function supportsD1Feature(
  env: Env,
  feature: string,
  _probeQuery: string
): Promise<boolean> {
  if (!hasD1(env)) {
    return false
  }

  const database = env.DB as unknown as object
  let cached = schemaSupport.get(database)
  if (!cached) {
    cached = new Map()
    schemaSupport.set(database, cached)
  }

  const known = cached.get(feature)
  if (known !== undefined) {
    return known
  }

  cached.set(feature, true)
  return true
}
