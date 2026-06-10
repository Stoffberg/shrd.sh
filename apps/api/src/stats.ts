import type { ContentMetadata, Env } from "./types"
import { shouldUseLegacyFallback, supportsD1Feature } from "./d1"

const METRICS_PREFIX = "metrics:"

type MetricsDelta = Partial<{
  uploadsTotal: number
  uploadsInline: number
  uploadsMultipart: number
  readsRaw: number
  readsMeta: number
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

const ZERO_METRICS: DailyMetrics = {
  uploadsTotal: 0,
  uploadsInline: 0,
  uploadsMultipart: 0,
  readsRaw: 0,
  readsMeta: 0,
  deletes: 0,
  notFound: 0,
  errors4xx: 0,
  errors5xx: 0,
  idempotencyHits: 0,
  idempotencyConflicts: 0,
  multipartResumes: 0,
  bytesUploaded: 0,
}

async function canUseMetricsD1(env: Env): Promise<boolean> {
  return supportsD1Feature(
    env,
    "daily-metrics",
    `SELECT
      uploads_total,
      uploads_inline,
      uploads_multipart,
      reads_raw,
      reads_meta,
      deletes,
      not_found,
      errors_4xx,
      errors_5xx,
      idempotency_hits,
      idempotency_conflicts,
      multipart_resumes,
      bytes_uploaded
    FROM daily_metrics
    LIMIT 1`
  )
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function metricsKey(day: string): string {
  return `${METRICS_PREFIX}daily:${day}`
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

  if (await canUseMetricsD1(env)) {
    try {
      await env.DB.prepare(
        `INSERT INTO daily_metrics (
          day,
          uploads_total,
          uploads_inline,
          uploads_multipart,
          reads_raw,
          reads_meta,
          deletes,
          not_found,
          errors_4xx,
          errors_5xx,
          idempotency_hits,
          idempotency_conflicts,
          multipart_resumes,
          bytes_uploaded
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day) DO UPDATE SET
          uploads_total = uploads_total + excluded.uploads_total,
          uploads_inline = uploads_inline + excluded.uploads_inline,
          uploads_multipart = uploads_multipart + excluded.uploads_multipart,
          reads_raw = reads_raw + excluded.reads_raw,
          reads_meta = reads_meta + excluded.reads_meta,
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
    } catch (error) {
      if (!shouldUseLegacyFallback(error)) {
        throw error
      }
    }
  }

  const existing = normalizeMetrics(await getKvJson<MetricsDelta>(env, metricsKey(day)))
  const merged = {
    uploadsTotal: existing.uploadsTotal + normalized.uploadsTotal,
    uploadsInline: existing.uploadsInline + normalized.uploadsInline,
    uploadsMultipart: existing.uploadsMultipart + normalized.uploadsMultipart,
    readsRaw: existing.readsRaw + normalized.readsRaw,
    readsMeta: existing.readsMeta + normalized.readsMeta,
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
}
