import type { ContentMetadata, Env } from "./types"

const METRICS_PREFIX = "metrics:"
const SNAPSHOTS_KEY = `${METRICS_PREFIX}storage:snapshots`

type MetricsDelta = Partial<{
  uploadsTotal: number
  uploadsInline: number
  uploadsMultipart: number
  readsRaw: number
  readsMeta: number
  readsHtml: number
  deletes: number
  notFound: number
  errors4xx: number
  errors5xx: number
  idempotencyHits: number
  idempotencyConflicts: number
  multipartResumes: number
  bytesUploaded: number
}>

type DailyMetrics = Required<MetricsDelta>

type ContentTypeStatsItem = {
  contentType: string
  uploads: number
  bytes: number
}

type StorageSnapshot = {
  timestamp: string
  inlineShareCount: number
  inlineBytes: number
  r2ObjectCount: number
  r2Bytes: number
  cleanupChecked: number
  cleanupDeleted: number
}

const ZERO_METRICS: DailyMetrics = {
  uploadsTotal: 0,
  uploadsInline: 0,
  uploadsMultipart: 0,
  readsRaw: 0,
  readsMeta: 0,
  readsHtml: 0,
  deletes: 0,
  notFound: 0,
  errors4xx: 0,
  errors5xx: 0,
  idempotencyHits: 0,
  idempotencyConflicts: 0,
  multipartResumes: 0,
  bytesUploaded: 0,
}

function hasD1(env: Env): boolean {
  return typeof env.DB?.prepare === "function"
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function cutoffDay(window: "24h" | "7d" | "30d"): string {
  const days = window === "24h" ? 1 : window === "7d" ? 7 : 30
  return new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function metricsKey(day: string): string {
  return `${METRICS_PREFIX}daily:${day}`
}

function contentTypesKey(day: string): string {
  return `${METRICS_PREFIX}content-types:${day}`
}

async function getKvJson<T>(env: Env, key: string): Promise<T | null> {
  return env.CONTENT.get<T>(key, "json")
}

function normalizeMetrics(delta?: MetricsDelta | null): DailyMetrics {
  return {
    ...ZERO_METRICS,
    ...delta,
  }
}

export async function recordMetrics(env: Env, delta: MetricsDelta): Promise<void> {
  const day = today()
  const normalized = normalizeMetrics(delta)

  if (hasD1(env)) {
    await env.DB.prepare(
      `INSERT INTO daily_metrics (
        day,
        uploads_total,
        uploads_inline,
        uploads_multipart,
        reads_raw,
        reads_meta,
        reads_html,
        deletes,
        not_found,
        errors_4xx,
        errors_5xx,
        idempotency_hits,
        idempotency_conflicts,
        multipart_resumes,
        bytes_uploaded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        uploads_total = uploads_total + excluded.uploads_total,
        uploads_inline = uploads_inline + excluded.uploads_inline,
        uploads_multipart = uploads_multipart + excluded.uploads_multipart,
        reads_raw = reads_raw + excluded.reads_raw,
        reads_meta = reads_meta + excluded.reads_meta,
        reads_html = reads_html + excluded.reads_html,
        deletes = deletes + excluded.deletes,
        not_found = not_found + excluded.not_found,
        errors_4xx = errors_4xx + excluded.errors_4xx,
        errors_5xx = errors_5xx + excluded.errors_5xx,
        idempotency_hits = idempotency_hits + excluded.idempotency_hits,
        idempotency_conflicts = idempotency_conflicts + excluded.idempotency_conflicts,
        multipart_resumes = multipart_resumes + excluded.multipart_resumes,
        bytes_uploaded = bytes_uploaded + excluded.bytes_uploaded`
    ).bind(
      day,
      normalized.uploadsTotal,
      normalized.uploadsInline,
      normalized.uploadsMultipart,
      normalized.readsRaw,
      normalized.readsMeta,
      normalized.readsHtml,
      normalized.deletes,
      normalized.notFound,
      normalized.errors4xx,
      normalized.errors5xx,
      normalized.idempotencyHits,
      normalized.idempotencyConflicts,
      normalized.multipartResumes,
      normalized.bytesUploaded
    ).run()
    return
  }

  const existing = normalizeMetrics(await getKvJson<MetricsDelta>(env, metricsKey(day)))
  const merged = {
    uploadsTotal: existing.uploadsTotal + normalized.uploadsTotal,
    uploadsInline: existing.uploadsInline + normalized.uploadsInline,
    uploadsMultipart: existing.uploadsMultipart + normalized.uploadsMultipart,
    readsRaw: existing.readsRaw + normalized.readsRaw,
    readsMeta: existing.readsMeta + normalized.readsMeta,
    readsHtml: existing.readsHtml + normalized.readsHtml,
    deletes: existing.deletes + normalized.deletes,
    notFound: existing.notFound + normalized.notFound,
    errors4xx: existing.errors4xx + normalized.errors4xx,
    errors5xx: existing.errors5xx + normalized.errors5xx,
    idempotencyHits: existing.idempotencyHits + normalized.idempotencyHits,
    idempotencyConflicts: existing.idempotencyConflicts + normalized.idempotencyConflicts,
    multipartResumes: existing.multipartResumes + normalized.multipartResumes,
    bytesUploaded: existing.bytesUploaded + normalized.bytesUploaded,
  }
  await env.CONTENT.put(metricsKey(day), JSON.stringify(merged))
}

export async function recordUploadMetrics(
  env: Env,
  metadata: ContentMetadata,
  uploadKind: "inline" | "direct" | "multipart"
): Promise<void> {
  await recordMetrics(env, {
    uploadsTotal: 1,
    uploadsInline: uploadKind === "inline" ? 1 : 0,
    uploadsMultipart: uploadKind === "multipart" ? 1 : 0,
    bytesUploaded: metadata.size,
  })

  const day = today()
  if (hasD1(env)) {
    await env.DB.prepare(
      `INSERT INTO daily_content_types (
        day,
        content_type,
        uploads,
        bytes
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(day, content_type) DO UPDATE SET
        uploads = uploads + excluded.uploads,
        bytes = bytes + excluded.bytes`
    ).bind(day, metadata.contentType, 1, metadata.size).run()
    return
  }

  const existing = (await getKvJson<Record<string, ContentTypeStatsItem>>(env, contentTypesKey(day))) ?? {}
  const current = existing[metadata.contentType] ?? {
    contentType: metadata.contentType,
    uploads: 0,
    bytes: 0,
  }
  existing[metadata.contentType] = {
    contentType: metadata.contentType,
    uploads: current.uploads + 1,
    bytes: current.bytes + metadata.size,
  }
  await env.CONTENT.put(contentTypesKey(day), JSON.stringify(existing))
}

function mergeMetrics(rows: DailyMetrics[]): DailyMetrics {
  return rows.reduce(
    (accumulator, row) => ({
      uploadsTotal: accumulator.uploadsTotal + row.uploadsTotal,
      uploadsInline: accumulator.uploadsInline + row.uploadsInline,
      uploadsMultipart: accumulator.uploadsMultipart + row.uploadsMultipart,
      readsRaw: accumulator.readsRaw + row.readsRaw,
      readsMeta: accumulator.readsMeta + row.readsMeta,
      readsHtml: accumulator.readsHtml + row.readsHtml,
      deletes: accumulator.deletes + row.deletes,
      notFound: accumulator.notFound + row.notFound,
      errors4xx: accumulator.errors4xx + row.errors4xx,
      errors5xx: accumulator.errors5xx + row.errors5xx,
      idempotencyHits: accumulator.idempotencyHits + row.idempotencyHits,
      idempotencyConflicts: accumulator.idempotencyConflicts + row.idempotencyConflicts,
      multipartResumes: accumulator.multipartResumes + row.multipartResumes,
      bytesUploaded: accumulator.bytesUploaded + row.bytesUploaded,
    }),
    { ...ZERO_METRICS }
  )
}

export async function getSummaryStats(env: Env, window: "24h" | "7d" | "30d") {
  const cutoff = cutoffDay(window)

  let metrics = { ...ZERO_METRICS }
  if (hasD1(env)) {
    const result = await env.DB.prepare(
      `SELECT
        uploads_total AS uploadsTotal,
        uploads_inline AS uploadsInline,
        uploads_multipart AS uploadsMultipart,
        reads_raw AS readsRaw,
        reads_meta AS readsMeta,
        reads_html AS readsHtml,
        deletes,
        not_found AS notFound,
        errors_4xx AS errors4xx,
        errors_5xx AS errors5xx,
        idempotency_hits AS idempotencyHits,
        idempotency_conflicts AS idempotencyConflicts,
        multipart_resumes AS multipartResumes,
        bytes_uploaded AS bytesUploaded
      FROM daily_metrics
      WHERE day >= ?`
    ).bind(cutoff).all<DailyMetrics>()
    metrics = mergeMetrics(result.results ?? [])
  } else {
    const rows: DailyMetrics[] = []
    for (const day of enumerateDays(cutoff, today())) {
      rows.push(normalizeMetrics(await getKvJson<MetricsDelta>(env, metricsKey(day))))
    }
    metrics = mergeMetrics(rows)
  }

  return {
    window,
    ...metrics,
    generatedAt: new Date().toISOString(),
  }
}

function enumerateDays(from: string, to: string): string[] {
  const days: string[] = []
  let cursor = new Date(`${from}T00:00:00.000Z`)
  const end = new Date(`${to}T00:00:00.000Z`)
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10))
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  }
  return days
}

export async function getContentTypeStats(
  env: Env,
  window: "24h" | "7d" | "30d",
  limit: number
) {
  const cutoff = cutoffDay(window)
  let items: ContentTypeStatsItem[] = []

  if (hasD1(env)) {
    const result = await env.DB.prepare(
      `SELECT
        content_type AS contentType,
        SUM(uploads) AS uploads,
        SUM(bytes) AS bytes
      FROM daily_content_types
      WHERE day >= ?
      GROUP BY content_type
      ORDER BY uploads DESC, bytes DESC
      LIMIT ?`
    ).bind(cutoff, limit).all<ContentTypeStatsItem>()
    items = result.results ?? []
  } else {
    const merged = new Map<string, ContentTypeStatsItem>()
    for (const day of enumerateDays(cutoff, today())) {
      const row = (await getKvJson<Record<string, ContentTypeStatsItem>>(env, contentTypesKey(day))) ?? {}
      for (const item of Object.values(row)) {
        const existing = merged.get(item.contentType) ?? {
          contentType: item.contentType,
          uploads: 0,
          bytes: 0,
        }
        existing.uploads += item.uploads
        existing.bytes += item.bytes
        merged.set(item.contentType, existing)
      }
    }
    items = [...merged.values()]
      .sort((left, right) => right.uploads - left.uploads || right.bytes - left.bytes)
      .slice(0, limit)
  }

  return {
    window,
    items,
  }
}

export async function recordStorageSnapshot(
  env: Env,
  snapshot: StorageSnapshot
): Promise<void> {
  if (hasD1(env)) {
    await env.DB.prepare(
      `INSERT INTO storage_snapshots (
        timestamp,
        inline_share_count,
        inline_bytes,
        r2_object_count,
        r2_bytes,
        cleanup_checked,
        cleanup_deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      snapshot.timestamp,
      snapshot.inlineShareCount,
      snapshot.inlineBytes,
      snapshot.r2ObjectCount,
      snapshot.r2Bytes,
      snapshot.cleanupChecked,
      snapshot.cleanupDeleted
    ).run()
    return
  }

  const existing = (await getKvJson<StorageSnapshot[]>(env, SNAPSHOTS_KEY)) ?? []
  existing.push(snapshot)
  await env.CONTENT.put(SNAPSHOTS_KEY, JSON.stringify(existing.slice(-168)))
}

export async function getStorageStats(env: Env) {
  let snapshots: StorageSnapshot[] = []

  if (hasD1(env)) {
    const result = await env.DB.prepare(
      `SELECT
        timestamp,
        inline_share_count AS inlineShareCount,
        inline_bytes AS inlineBytes,
        r2_object_count AS r2ObjectCount,
        r2_bytes AS r2Bytes,
        cleanup_checked AS cleanupChecked,
        cleanup_deleted AS cleanupDeleted
      FROM storage_snapshots
      ORDER BY timestamp DESC
      LIMIT 168`
    ).all<StorageSnapshot>()
    snapshots = (result.results ?? []).reverse()
  } else {
    snapshots = (await getKvJson<StorageSnapshot[]>(env, SNAPSHOTS_KEY)) ?? []
  }

  return {
    latestSnapshot: snapshots[snapshots.length - 1] ?? null,
    series: snapshots.map((snapshot) => ({
      timestamp: snapshot.timestamp,
      inlineShareCount: snapshot.inlineShareCount,
      inlineBytes: snapshot.inlineBytes,
      r2ObjectCount: snapshot.r2ObjectCount,
      r2Bytes: snapshot.r2Bytes,
    })),
  }
}

export async function collectStorageSnapshot(
  env: Env,
  cleanup: { checked: number; deleted: number }
): Promise<StorageSnapshot> {
  let inlineShareCount = 0
  let inlineBytes = 0

  if (hasD1(env)) {
    const aggregate = await env.DB.prepare(
      `SELECT
        COUNT(*) AS inlineShareCount,
        COALESCE(SUM(size), 0) AS inlineBytes
      FROM shares
      WHERE storage_type = 'kv'`
    ).first<{ inlineShareCount: number; inlineBytes: number }>()
    inlineShareCount = aggregate?.inlineShareCount ?? 0
    inlineBytes = aggregate?.inlineBytes ?? 0
  }

  let r2ObjectCount = 0
  let r2Bytes = 0
  let cursor: string | undefined
  do {
    const listed = await env.STORAGE.list({ cursor, limit: 100 })
    for (const object of listed.objects) {
      r2ObjectCount++
      r2Bytes += object.size
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)

  return {
    timestamp: new Date().toISOString(),
    inlineShareCount,
    inlineBytes,
    r2ObjectCount,
    r2Bytes,
    cleanupChecked: cleanup.checked,
    cleanupDeleted: cleanup.deleted,
  }
}
