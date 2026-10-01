CREATE TABLE `native_room_creations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`private` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_room_creation_form` ON `native_room_creations` (`name`,`private`);