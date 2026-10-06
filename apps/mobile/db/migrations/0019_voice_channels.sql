DROP TABLE `native_meeting_intents`;--> statement-breakpoint
DROP INDEX `idx_native_room_creation_form`;--> statement-breakpoint
ALTER TABLE `native_room_creations` ADD `voice` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_room_creation_form` ON `native_room_creations` (`name`,`private`,`voice`);--> statement-breakpoint
ALTER TABLE `rooms` ADD `voice` integer DEFAULT false NOT NULL;