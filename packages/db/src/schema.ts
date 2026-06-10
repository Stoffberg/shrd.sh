import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const shares = sqliteTable("shares", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["text", "json", "markdown", "binary", "image"] }).notNull(),
  name: text("name"),
  size: integer("size").notNull(),
  views: integer("views").default(0).notNull(),
  burned: integer("burned", { mode: "boolean" }).default(false).notNull(),
  encrypted: integer("encrypted", { mode: "boolean" }).default(false).notNull(),
  storageKey: text("storage_key").notNull(),
  storageType: text("storage_type", { enum: ["kv", "r2"] }).notNull(),
  deleteToken: text("delete_token").notNull(),
  contentType: text("content_type").notNull(),
  filename: text("filename"),
  maxViews: integer("max_views"),
  inlineBody: text("inline_body"),
  inlineBodyEncoding: text("inline_body_encoding", { enum: ["utf8", "base64"] }),
  lastAccessedAt: text("last_accessed_at"),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const idempotencyKeys = sqliteTable("idempotency_keys", {
  scope: text("scope").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  status: text("status", { enum: ["in_progress", "completed"] }).notNull(),
  responseJson: text("response_json"),
  responseStatus: integer("response_status"),
  resourceId: text("resource_id"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const multipartSessions = sqliteTable("multipart_sessions", {
  id: text("id").primaryKey(),
  uploadId: text("upload_id").unique().notNull(),
  resumeToken: text("resume_token").notNull(),
  deleteToken: text("delete_token").notNull(),
  contentType: text("content_type").notNull(),
  filename: text("filename"),
  expire: text("expire"),
  ttlSeconds: integer("ttl_seconds"),
  burn: integer("burn", { mode: "boolean" }).default(false).notNull(),
  name: text("name"),
  encrypted: integer("encrypted", { mode: "boolean" }).default(false).notNull(),
  partSize: integer("part_size").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
});

export const multipartParts = sqliteTable("multipart_parts", {
  sessionId: text("session_id").notNull().references(() => multipartSessions.id, { onDelete: "cascade" }),
  partNumber: integer("part_number").notNull(),
  etag: text("etag").notNull(),
  sha256: text("sha256").notNull(),
  size: integer("size").notNull(),
});

export const dailyMetrics = sqliteTable("daily_metrics", {
  day: text("day").primaryKey(),
  uploadsTotal: integer("uploads_total").default(0).notNull(),
  uploadsInline: integer("uploads_inline").default(0).notNull(),
  uploadsMultipart: integer("uploads_multipart").default(0).notNull(),
  readsRaw: integer("reads_raw").default(0).notNull(),
  readsMeta: integer("reads_meta").default(0).notNull(),
  deletes: integer("deletes").default(0).notNull(),
  notFound: integer("not_found").default(0).notNull(),
  errors4xx: integer("errors_4xx").default(0).notNull(),
  errors5xx: integer("errors_5xx").default(0).notNull(),
  idempotencyHits: integer("idempotency_hits").default(0).notNull(),
  idempotencyConflicts: integer("idempotency_conflicts").default(0).notNull(),
  multipartResumes: integer("multipart_resumes").default(0).notNull(),
  bytesUploaded: integer("bytes_uploaded").default(0).notNull(),
});
