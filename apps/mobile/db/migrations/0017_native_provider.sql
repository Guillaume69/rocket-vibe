-- Tables of the RocketVibe native provider, consolidated from the feature branch migrations
-- 0016-0032 after master's 0016_english_names. IF NOT EXISTS keeps it safe on pilot devices
-- that already applied those branch migrations at their final schema.
CREATE TABLE IF NOT EXISTS `native_emoji_catalog` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`payload` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_favorite_intents` (
	`rid` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`membership` text NOT NULL,
	`payload` text NOT NULL,
	`phase` text DEFAULT 'pending' NOT NULL,
	`receipt_revision` text,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_native_favorite_operation` ON `native_favorite_intents` (`id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_meeting_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_native_meeting_intent_room` ON `native_meeting_intents` (`rid`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`message_id` text NOT NULL,
	`kind` text NOT NULL,
	`expected_revision` text NOT NULL,
	`text` text NOT NULL,
	`quotes` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_native_command_message` ON `native_commands` (`message_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_outbox_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_positions` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`position` text NOT NULL,
	`revision` text NOT NULL,
	`reply_to` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_native_positions_room` ON `native_positions` (`rid`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_profile_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`slot` text NOT NULL,
	`payload` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_native_profile_operation_slot` ON `native_profile_operations` (`slot`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_quote_references` (
	`message_id` text NOT NULL,
	`rid` text NOT NULL,
	`ordinal` integer NOT NULL,
	`source_id` text NOT NULL,
	`source_room` text NOT NULL,
	`observed_revision` text NOT NULL,
	PRIMARY KEY(`message_id`, `ordinal`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_native_quote_origins` ON `native_quote_references` (`source_room`,`source_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_quote_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`membership` text,
	`view_position` text NOT NULL,
	`payload` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_native_quote_source_rooms` ON `native_quote_sources` (`rid`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_read_intents` (
	`rid` text PRIMARY KEY NOT NULL,
	`membership` text NOT NULL,
	`root_position` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_read_states` (
	`rid` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_room_access` (
	`rid` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`read_only` integer,
	`can_send` integer,
	`role` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_room_creations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`private` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_native_room_creation_form` ON `native_room_creations` (`name`,`private`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_room_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`payload` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_native_room_operation_room` ON `native_room_operations` (`rid`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_star_states` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`revision` text NOT NULL,
	`present` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_native_star_room` ON `native_star_states` (`rid`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_sync_state` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`data_epoch` text NOT NULL,
	`cursor` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_thread_read_intents` (
	`root` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`membership` text NOT NULL,
	`position` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_thread_states` (
	`root` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `native_upload_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`payload` text NOT NULL,
	`phase` text DEFAULT 'pending' NOT NULL
);
