CREATE TABLE `native_profile_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`slot` text NOT NULL,
	`payload` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_profile_operation_slot` ON `native_profile_operations` (`slot`);