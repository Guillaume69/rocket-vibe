CREATE TABLE `native_thread_read_intents` (
	`root` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`membership` text NOT NULL,
	`position` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `native_thread_states` (
	`root` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`payload` text NOT NULL
);
