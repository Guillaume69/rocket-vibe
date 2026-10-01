CREATE TABLE `native_star_states` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`revision` text NOT NULL,
	`present` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_native_star_room` ON `native_star_states` (`rid`);