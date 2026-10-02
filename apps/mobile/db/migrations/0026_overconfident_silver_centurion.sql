CREATE TABLE `native_outbox_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`payload` text NOT NULL
);
