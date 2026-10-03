CREATE TABLE `native_upload_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`payload` text NOT NULL,
	`phase` text DEFAULT 'pending' NOT NULL
);
