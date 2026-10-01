CREATE TABLE `native_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`message_id` text NOT NULL,
	`kind` text NOT NULL,
	`expected_revision` text NOT NULL,
	`text` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_command_message` ON `native_commands` (`message_id`);