CREATE TABLE `native_follow_states` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`revision` text NOT NULL,
	`present` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_native_follow_room` ON `native_follow_states` (`rid`);