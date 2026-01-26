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
  expiresAt?: string
  views: number
  maxViews?: number
  filename?: string
  storageType: "kv" | "r2"
}

export interface StoredContent {
  metadata: ContentMetadata
  content?: string
}

export interface PushRequest {
  content: string
  contentType?: string
  filename?: string
  expiresIn?: number
  burn?: boolean
}

export interface PushResponse {
  id: string
  url: string
  rawUrl: string
  deleteUrl: string
  deleteToken: string
  expiresAt?: string
}

export interface MultipartUploadSession {
  id: string
  uploadId: string
  deleteToken: string
  contentType: string
  filename?: string
  expiresIn?: number
  burn?: boolean
  parts: { partNumber: number; etag: string }[]
  createdAt: string
}
