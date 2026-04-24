-- Migration 0002: workspace members & invites.
--
-- Hand-edited after `drizzle-kit generate`:
--   1. The `workspace_invites_pending_unique` index uses a partial WHERE
--      clause (drizzle-orm v0.45 can't express partial indexes).
--   2. The backfill `INSERT INTO workspace_members ... SELECT ... FROM
--      workspaces` runs AFTER workspace_members is created and BEFORE
--      the workspaces table-rebuild that drops owner_user_id — that
--      ordering is load-bearing and the generator does not emit it.
-- See docs/plans/2026-04-23-003-feat-workspace-members-plan.md U1.

CREATE TABLE `workspace_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`invited_email` text NOT NULL,
	`invited_by_user_id` text,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invites_token_hash_unique` ON `workspace_invites` (`token_hash`);--> statement-breakpoint
-- Partial unique index: only enforces uniqueness on pending invites (not yet
-- accepted or revoked). An owner can re-invite the same email after the prior
-- invite has been consumed or rescinded.
CREATE UNIQUE INDEX `workspace_invites_pending_unique` ON `workspace_invites` (`workspace_id`,`invited_email`) WHERE `accepted_at` IS NULL AND `revoked_at` IS NULL;--> statement-breakpoint
CREATE INDEX `workspace_invites_workspace_created_idx` ON `workspace_invites` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` integer NOT NULL,
	`invited_by_user_id` text,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workspace_members_user_joined_idx` ON `workspace_members` (`user_id`,`joined_at`,`workspace_id`);--> statement-breakpoint
-- Backfill: every existing workspace gets an owner membership row for its
-- current owner_user_id. Must run BEFORE the workspaces table-rebuild drops
-- that column.
INSERT INTO `workspace_members` (`workspace_id`, `user_id`, `role`, `joined_at`, `invited_by_user_id`)
SELECT `id`, `owner_user_id`, 'owner', `created_at`, NULL FROM `workspaces`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_workspaces`("id", "name", "created_at") SELECT "id", "name", "created_at" FROM `workspaces`;--> statement-breakpoint
DROP TABLE `workspaces`;--> statement-breakpoint
ALTER TABLE `__new_workspaces` RENAME TO `workspaces`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
