CREATE TABLE `daily_quota` (
	`date` text PRIMARY KEY NOT NULL,
	`bytes_uploaded` integer DEFAULT 0 NOT NULL,
	`class_a_ops` integer DEFAULT 0 NOT NULL,
	`class_b_ops` integer DEFAULT 0 NOT NULL,
	`alerted_bytes` integer DEFAULT 0 NOT NULL,
	`alerted_class_a` integer DEFAULT 0 NOT NULL,
	`alerted_class_b` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
