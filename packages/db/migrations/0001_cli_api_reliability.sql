ALTER TABLE `shares` ADD `content_type` text NOT NULL DEFAULT 'text/plain';
--> statement-breakpoint
ALTER TABLE `shares` ADD `filename` text;
--> statement-breakpoint
ALTER TABLE `shares` ADD `max_views` integer;
--> statement-breakpoint
ALTER TABLE `shares` ADD `inline_body` text;
--> statement-breakpoint
ALTER TABLE `shares` ADD `inline_body_encoding` text;
--> statement-breakpoint
ALTER TABLE `shares` ADD `last_accessed_at` text;
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
  `scope` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `request_hash` text NOT NULL,
  `status` text NOT NULL,
  `response_json` text,
  `response_status` integer,
  `resource_id` text,
  `created_at` text NOT NULL,
  `expires_at` text NOT NULL,
  PRIMARY KEY (`scope`, `idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `multipart_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `upload_id` text NOT NULL,
  `resume_token` text NOT NULL,
  `delete_token` text NOT NULL,
  `content_type` text NOT NULL,
  `filename` text,
  `expire` text,
  `ttl_seconds` integer,
  `burn` integer DEFAULT false NOT NULL,
  `name` text,
  `encrypted` integer DEFAULT false NOT NULL,
  `part_size` integer NOT NULL,
  `created_at` text NOT NULL,
  `expires_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `multipart_sessions_upload_id_unique` ON `multipart_sessions` (`upload_id`);
--> statement-breakpoint
CREATE TABLE `multipart_parts` (
  `session_id` text NOT NULL,
  `part_number` integer NOT NULL,
  `etag` text NOT NULL,
  `sha256` text NOT NULL,
  `size` integer NOT NULL,
  PRIMARY KEY (`session_id`, `part_number`),
  FOREIGN KEY (`session_id`) REFERENCES `multipart_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `daily_metrics` (
  `day` text PRIMARY KEY NOT NULL,
  `uploads_total` integer DEFAULT 0 NOT NULL,
  `uploads_inline` integer DEFAULT 0 NOT NULL,
  `uploads_multipart` integer DEFAULT 0 NOT NULL,
  `reads_raw` integer DEFAULT 0 NOT NULL,
  `reads_meta` integer DEFAULT 0 NOT NULL,
  `reads_html` integer DEFAULT 0 NOT NULL,
  `deletes` integer DEFAULT 0 NOT NULL,
  `not_found` integer DEFAULT 0 NOT NULL,
  `errors_4xx` integer DEFAULT 0 NOT NULL,
  `errors_5xx` integer DEFAULT 0 NOT NULL,
  `idempotency_hits` integer DEFAULT 0 NOT NULL,
  `idempotency_conflicts` integer DEFAULT 0 NOT NULL,
  `multipart_resumes` integer DEFAULT 0 NOT NULL,
  `bytes_uploaded` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daily_content_types` (
  `day` text NOT NULL,
  `content_type` text NOT NULL,
  `uploads` integer DEFAULT 0 NOT NULL,
  `bytes` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY (`day`, `content_type`)
);
--> statement-breakpoint
CREATE TABLE `storage_snapshots` (
  `timestamp` text PRIMARY KEY NOT NULL,
  `inline_share_count` integer DEFAULT 0 NOT NULL,
  `inline_bytes` integer DEFAULT 0 NOT NULL,
  `r2_object_count` integer DEFAULT 0 NOT NULL,
  `r2_bytes` integer DEFAULT 0 NOT NULL,
  `cleanup_checked` integer DEFAULT 0 NOT NULL,
  `cleanup_deleted` integer DEFAULT 0 NOT NULL
);
