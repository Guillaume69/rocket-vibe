CREATE TABLE `native_quote_references` (
	`message_id` text NOT NULL,
	`rid` text NOT NULL,
	`ordinal` integer NOT NULL,
	`source_id` text NOT NULL,
	`source_room` text NOT NULL,
	`observed_revision` text NOT NULL,
	PRIMARY KEY(`message_id`, `ordinal`)
);
--> statement-breakpoint
CREATE INDEX `idx_native_quote_origins` ON `native_quote_references` (`source_room`,`source_id`);--> statement-breakpoint
CREATE TABLE `native_quote_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`membership` text,
	`view_position` text NOT NULL,
	`payload` text
);
--> statement-breakpoint
CREATE INDEX `idx_native_quote_source_rooms` ON `native_quote_sources` (`rid`);