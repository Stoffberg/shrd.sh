import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").unique().notNull(),
  name: text("name"),
  image: text("image"),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false),
  tier: text("tier", { enum: ["free", "pro", "api", "team"] }).default("free").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").unique().notNull(),
  expiresAt: text("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: text("access_token_expires_at"),
  refreshTokenExpiresAt: text("refresh_token_expires_at"),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const verifications = sqliteTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const shares = sqliteTable("shares", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
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
  readsHtml: integer("reads_html").default(0).notNull(),
  deletes: integer("deletes").default(0).notNull(),
  notFound: integer("not_found").default(0).notNull(),
  errors4xx: integer("errors_4xx").default(0).notNull(),
  errors5xx: integer("errors_5xx").default(0).notNull(),
  idempotencyHits: integer("idempotency_hits").default(0).notNull(),
  idempotencyConflicts: integer("idempotency_conflicts").default(0).notNull(),
  multipartResumes: integer("multipart_resumes").default(0).notNull(),
  bytesUploaded: integer("bytes_uploaded").default(0).notNull(),
});

export const dailyContentTypes = sqliteTable("daily_content_types", {
  day: text("day").notNull(),
  contentType: text("content_type").notNull(),
  uploads: integer("uploads").default(0).notNull(),
  bytes: integer("bytes").default(0).notNull(),
});

export const storageSnapshots = sqliteTable("storage_snapshots", {
  timestamp: text("timestamp").primaryKey(),
  inlineShareCount: integer("inline_share_count").default(0).notNull(),
  inlineBytes: integer("inline_bytes").default(0).notNull(),
  r2ObjectCount: integer("r2_object_count").default(0).notNull(),
  r2Bytes: integer("r2_bytes").default(0).notNull(),
  cleanupChecked: integer("cleanup_checked").default(0).notNull(),
  cleanupDeleted: integer("cleanup_deleted").default(0).notNull(),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  lastUsedAt: text("last_used_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  name: text("name"),
  deleteToken: text("delete_token").notNull(),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const collectionItems = sqliteTable("collection_items", {
  id: text("id").primaryKey(),
  collectionId: text("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
  shareId: text("share_id").notNull().references(() => shares.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  order: integer("order").notNull(),
});
