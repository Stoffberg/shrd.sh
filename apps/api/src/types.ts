export interface Env {
  CONTENT: KVNamespace
  STORAGE: R2Bucket
  DB: D1Database
  BASE_URL: string
}

export interface ContentMetadata {
  id: string
  deleteToken: string
  contentType: string
  size: number
  createdAt: string
  expiresAt: string | null
  views: number
  maxViews?: number
  name?: string | null
  filename?: string
  storageType: "kv" | "r2"
  encrypted?: boolean
}

export type ShareKind = "text" | "json" | "markdown" | "binary" | "image"

export interface CanonicalContentMetadata extends ContentMetadata {
  type: ShareKind
  burned: boolean
  storageKey: string
  inlineBody?: string | null
  inlineBodyEncoding?: "utf8" | "base64" | null
  lastAccessedAt?: string | null
}

export interface StoredContent {
  metadata: ContentMetadata
  content?: string
}

export interface PushRequest {
  content: string
  contentType?: string
  filename?: string
  expire?: string
  expiresIn?: number
  burn?: boolean
  name?: string
  encrypted?: boolean
}

export interface PushResponse {
  id: string
  url: string
  rawUrl: string
  deleteUrl: string
  deleteToken: string
  expiresAt: string | null
  name: string | null
}

export interface MultipartUploadSession {
  id: string
  uploadId: string
  resumeToken: string
  deleteToken: string
  contentType: string
  filename?: string
  expire?: string
  ttlSeconds?: number | null
  burn?: boolean
  name?: string | null
  encrypted?: boolean
  partSize: number
  expiresAt?: string | null
  parts: { partNumber: number; etag: string; sha256: string; size: number }[]
  createdAt: string
}
