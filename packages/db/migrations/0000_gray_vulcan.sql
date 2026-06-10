CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text,
	`size` integer NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`burned` integer DEFAULT false NOT NULL,
	`encrypted` integer DEFAULT false NOT NULL,
	`storage_key` text NOT NULL,
	`storage_type` text NOT NULL,
	`delete_token` text NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL
);
