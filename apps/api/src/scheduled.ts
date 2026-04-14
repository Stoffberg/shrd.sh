import type { Env } from "./types"
import {
  cleanupExpiredShares,
  cleanupStaleMultipartSessions,
  shareExistsForStorageKey,
} from "./storage"
import { collectStorageSnapshot, recordStorageSnapshot } from "./stats"

export async function cleanupOrphanedR2(env: Env): Promise<{ deleted: number; checked: number }> {
  let deleted = 0
  let checked = 0
  let cursor: string | undefined

  do {
    const listed = await env.STORAGE.list({ cursor, limit: 100 })

    for (const object of listed.objects) {
      checked++
      const exists = await shareExistsForStorageKey(env, object.key)
      if (!exists) {
        await env.STORAGE.delete(object.key)
        deleted++
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)

  return { deleted, checked }
}

export function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  ctx.waitUntil(
    Promise.all([
      cleanupOrphanedR2(env),
      cleanupExpiredShares(env),
      cleanupStaleMultipartSessions(env),
    ]).then(async ([r2Cleanup, expiredShares, staleMultipart]) => {
      const snapshot = await collectStorageSnapshot(env, r2Cleanup)
      await recordStorageSnapshot(env, snapshot)
      console.log(
        `scheduled cleanup: r2 checked ${r2Cleanup.checked}, r2 deleted ${r2Cleanup.deleted}, expired shares ${expiredShares}, stale multipart ${staleMultipart}, cron ${event.cron}`
      )
    })
  )
}
