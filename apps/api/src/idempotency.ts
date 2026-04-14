import type { Env } from "./types"

const IDEMPOTENCY_PREFIX = "idempotency:"
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

type IdempotencyStatus = "in_progress" | "completed"

type IdempotencyRecord = {
  scope: string
  idempotencyKey: string
  requestHash: string
  status: IdempotencyStatus
  responseJson: string | null
  responseStatus: number | null
  resourceId: string | null
  createdAt: string
  expiresAt: string
}

export type IdempotencyReservation =
  | { kind: "new" }
  | { kind: "replay"; response: unknown; status: number }
  | { kind: "conflict" }
  | { kind: "in_progress" }

function hasD1(env: Env): boolean {
  return typeof env.DB?.prepare === "function"
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)

  return `{${entries.join(",")}}`
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

export async function hashIdempotencyPayload(value: unknown): Promise<string> {
  return sha256Hex(stableStringify(value))
}

function toKey(scope: string, idempotencyKey: string): string {
  return `${IDEMPOTENCY_PREFIX}${scope}:${idempotencyKey}`
}

function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() <= Date.now()
}

async function getKvRecord(env: Env, scope: string, idempotencyKey: string): Promise<IdempotencyRecord | null> {
  return env.CONTENT.get<IdempotencyRecord>(toKey(scope, idempotencyKey), "json")
}

async function putKvRecord(env: Env, record: IdempotencyRecord): Promise<void> {
  const ttl = Math.max(1, Math.floor((new Date(record.expiresAt).getTime() - Date.now()) / 1000))
  await env.CONTENT.put(toKey(record.scope, record.idempotencyKey), JSON.stringify(record), {
    expirationTtl: ttl,
  })
}

function parseReplay(record: IdempotencyRecord): IdempotencyReservation {
  return {
    kind: "replay",
    response: record.responseJson ? JSON.parse(record.responseJson) : null,
    status: record.responseStatus ?? 200,
  }
}

export async function reserveIdempotency(
  env: Env,
  scope: string,
  idempotencyKey: string,
  requestHash: string
): Promise<IdempotencyReservation> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString()

  if (hasD1(env)) {
    const existing = await env.DB.prepare(
      `SELECT
        scope,
        idempotency_key AS idempotencyKey,
        request_hash AS requestHash,
        status,
        response_json AS responseJson,
        response_status AS responseStatus,
        resource_id AS resourceId,
        created_at AS createdAt,
        expires_at AS expiresAt
      FROM idempotency_keys
      WHERE scope = ? AND idempotency_key = ?
      LIMIT 1`
    ).bind(scope, idempotencyKey).first<IdempotencyRecord>()

    if (existing) {
      if (isExpired(existing.expiresAt)) {
        await clearIdempotency(env, scope, idempotencyKey)
      } else if (existing.requestHash !== requestHash) {
        return { kind: "conflict" }
      } else if (existing.status === "completed") {
        return parseReplay(existing)
      } else {
        return { kind: "in_progress" }
      }
    }

    try {
      await env.DB.prepare(
        `INSERT INTO idempotency_keys (
          scope,
          idempotency_key,
          request_hash,
          status,
          response_json,
          response_status,
          resource_id,
          created_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        scope,
        idempotencyKey,
        requestHash,
        "in_progress",
        null,
        null,
        null,
        now.toISOString(),
        expiresAt
      ).run()
      return { kind: "new" }
    } catch {
      const retry = await reserveIdempotency(env, scope, idempotencyKey, requestHash)
      return retry
    }
  }

  const existing = await getKvRecord(env, scope, idempotencyKey)
  if (existing) {
    if (isExpired(existing.expiresAt)) {
      await clearIdempotency(env, scope, idempotencyKey)
    } else if (existing.requestHash !== requestHash) {
      return { kind: "conflict" }
    } else if (existing.status === "completed") {
      return parseReplay(existing)
    } else {
      return { kind: "in_progress" }
    }
  }

  await putKvRecord(env, {
    scope,
    idempotencyKey,
    requestHash,
    status: "in_progress",
    responseJson: null,
    responseStatus: null,
    resourceId: null,
    createdAt: now.toISOString(),
    expiresAt,
  })
  return { kind: "new" }
}

export async function completeIdempotency(
  env: Env,
  scope: string,
  idempotencyKey: string,
  response: unknown,
  status: number,
  resourceId?: string
): Promise<void> {
  const responseJson = JSON.stringify(response)

  if (hasD1(env)) {
    await env.DB.prepare(
      `UPDATE idempotency_keys
      SET status = ?, response_json = ?, response_status = ?, resource_id = ?
      WHERE scope = ? AND idempotency_key = ?`
    ).bind("completed", responseJson, status, resourceId ?? null, scope, idempotencyKey).run()
    return
  }

  const existing = await getKvRecord(env, scope, idempotencyKey)
  if (!existing) {
    return
  }

  await putKvRecord(env, {
    ...existing,
    status: "completed",
    responseJson,
    responseStatus: status,
    resourceId: resourceId ?? null,
  })
}

export async function clearIdempotency(
  env: Env,
  scope: string,
  idempotencyKey: string
): Promise<void> {
  if (hasD1(env)) {
    await env.DB.prepare(
      "DELETE FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?"
    ).bind(scope, idempotencyKey).run()
    return
  }

  await env.CONTENT.delete(toKey(scope, idempotencyKey))
}
