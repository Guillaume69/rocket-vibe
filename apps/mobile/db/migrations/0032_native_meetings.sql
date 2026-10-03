CREATE TABLE `native_meeting_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_meeting_intent_room` ON `native_meeting_intents` (`rid`);