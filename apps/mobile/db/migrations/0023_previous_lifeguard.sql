CREATE TABLE `native_favorite_intents` (
	`rid` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`membership` text NOT NULL,
	`payload` text NOT NULL,
	`phase` text DEFAULT 'pending' NOT NULL,
	`receipt_revision` text,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_favorite_operation` ON `native_favorite_intents` (`id`);--> statement-breakpoint
CREATE TABLE `native_read_intents` (
	`rid` text PRIMARY KEY NOT NULL,
	`membership` text NOT NULL,
	`root_position` text NOT NULL
);
