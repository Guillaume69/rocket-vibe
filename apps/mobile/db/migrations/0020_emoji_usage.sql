-- IF NOT EXISTS: development builds of the branch created this table as migration 0019
-- before the rebase moved it after 0019_voice_channels; there it must be a no-op.
CREATE TABLE IF NOT EXISTS `emoji_usage` (
	`code` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`last_used` integer NOT NULL
);
