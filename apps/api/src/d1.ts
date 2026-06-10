import type { Env } from "./types"

export function hasD1(env: Env): boolean {
  return typeof env.DB?.prepare === "function"
}

export function shouldUseLegacyFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table|no such column|has no column named|SQLITE_ERROR|D1_ERROR/i.test(message)
}
