CREATE TABLE `emoji_usage` (
	`code` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`last_used` integer NOT NULL
);
