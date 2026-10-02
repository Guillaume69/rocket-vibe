CREATE TABLE `native_room_access` (
	`rid` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`read_only` integer,
	`can_send` integer,
	`role` text
);
