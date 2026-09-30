CREATE TABLE `native_positions` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`position` text NOT NULL,
	`revision` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_native_positions_room` ON `native_positions` (`rid`);--> statement-breakpoint
CREATE TABLE `native_sync_state` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`data_epoch` text NOT NULL,
	`cursor` text NOT NULL
);
