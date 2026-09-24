CREATE TABLE `televersements` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`uri` text NOT NULL,
	`nom` text NOT NULL,
	`type` text NOT NULL,
	`legende` text,
	`statut` text DEFAULT 'en-attente' NOT NULL,
	`derniere_erreur` text,
	`cree_le` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_televersements_statut` ON `televersements` (`statut`);