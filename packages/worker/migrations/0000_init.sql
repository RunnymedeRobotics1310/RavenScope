CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`last4` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE INDEX `api_keys_workspace_revoked_idx` ON `api_keys` (`workspace_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`actor_user_id` text,
	`actor_api_key_id` text,
	`workspace_id` text,
	`ip_hash` text,
	`created_at` integer NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_created_workspace_idx` ON `audit_log` (`created_at`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `login_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`email` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_tokens_token_hash_unique` ON `login_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `login_tokens_email_expires_idx` ON `login_tokens` (`email`,`expires_at`);--> statement-breakpoint
CREATE TABLE `session_batches` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`byte_length` integer NOT NULL,
	`entry_count` integer NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `seq`),
	FOREIGN KEY (`session_id`) REFERENCES `telemetry_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `telemetry_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`session_id` text NOT NULL,
	`team_number` integer,
	`robot_ip` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`entry_count` integer DEFAULT 0 NOT NULL,
	`uploaded_count` integer DEFAULT 0 NOT NULL,
	`tournament_id` text,
	`match_label` text,
	`match_level` text,
	`match_number` integer,
	`playoff_round` text,
	`fms_event_name` text,
	`created_at` integer NOT NULL,
	`last_batch_at` integer,
	`wpilog_key` text,
	`wpilog_generated_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telemetry_sessions_workspace_session_unique` ON `telemetry_sessions` (`workspace_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `telemetry_sessions_workspace_started_idx` ON `telemetry_sessions` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
