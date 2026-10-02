CREATE TABLE `native_room_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`payload` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_room_operation_room` ON `native_room_operations` (`rid`);