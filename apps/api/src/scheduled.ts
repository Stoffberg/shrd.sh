import type { Env } from "./types"

export async function cleanupOrphanedR2(env: Env): Promise<{ deleted: number; checked: number }> {
  let deleted = 0
  let checked = 0
  let cursor: string | undefined

  do {
    const listed = await env.STORAGE.list({ cursor, limit: 100 })

    for (const object of listed.objects) {
      checked++
      const kvExists = await env.CONTENT.get(`content:${object.key}`)
      if (!kvExists) {
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
    cleanupOrphanedR2(env).then((result) => {
      console.log(`R2 cleanup: checked ${result.checked}, deleted ${result.deleted}`)
    })
  )
}
