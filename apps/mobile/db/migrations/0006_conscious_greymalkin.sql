CREATE TABLE `emojis_custom` (
	`nom` text PRIMARY KEY NOT NULL,
	`extension` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`mis_a_jour_le` integer DEFAULT 0 NOT NULL
);
