ALTER TABLE `messages` ADD `discussion_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `discussion_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `discussion_last` integer;