CREATE TABLE `reminders` (
	`message_id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`room_name` text NOT NULL,
	`thread_id` text,
	`author` text NOT NULL,
	`excerpt` text NOT NULL,
	`due_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`scheduled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_reminders_due` ON `reminders` (`due_at`);