-- Migration 0003: shared viewer layouts + per-user viewer preferences.
--
-- Hand-edited after `drizzle-kit generate`:
--   1. Reordered the two CREATE TABLE statements so
--      `workspace_viewer_layouts` is created before
--      `user_viewer_preferences`, which has an FK pointing at it.
--      SQLite technically tolerates the reverse order, but the right
--      order keeps the migration readable and avoids surprises under
--      stricter PRAGMA configurations.
-- See docs/plans/2026-04-24-002-feat-shared-viewer-layouts-plan.md U1.

CREATE TABLE `workspace_viewer_layouts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`state_json` text NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_viewer_layouts_workspace_name_unique` ON `workspace_viewer_layouts` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `workspace_viewer_layouts_workspace_updated_idx` ON `workspace_viewer_layouts` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `user_viewer_preferences` (
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`default_layout_id` text,
	`last_used_state_json` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `workspace_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_layout_id`) REFERENCES `workspace_viewer_layouts`(`id`) ON UPDATE no action ON DELETE set null
);
