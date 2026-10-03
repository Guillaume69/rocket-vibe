CREATE TABLE `native_emoji_catalog` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`payload` text
);
