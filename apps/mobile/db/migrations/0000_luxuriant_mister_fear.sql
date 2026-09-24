CREATE TABLE `abonnements` (
	`rid` text PRIMARY KEY NOT NULL,
	`non_lus` integer DEFAULT 0 NOT NULL,
	`mentions` integer DEFAULT 0 NOT NULL,
	`mentions_groupe` integer DEFAULT 0 NOT NULL,
	`alerte` integer DEFAULT false NOT NULL,
	`ouvert` integer DEFAULT true NOT NULL,
	`favori` integer DEFAULT false NOT NULL,
	`lu_jusqu_a` integer,
	`mis_a_jour_le` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `etat_synchro` (
	`portee` text NOT NULL,
	`flux` text NOT NULL,
	`mis_a_jour_depuis` integer NOT NULL,
	PRIMARY KEY(`portee`, `flux`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`texte` text,
	`horodatage` integer NOT NULL,
	`auteur_id` text NOT NULL,
	`auteur_nom` text,
	`type_systeme` text,
	`fil_id` text,
	`fil_reponses` integer DEFAULT 0 NOT NULL,
	`modifie_le` integer,
	`md` text,
	`pieces_jointes` text,
	`reactions` text,
	`mis_a_jour_le` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_messages_salon_date` ON `messages` (`rid`,`horodatage`);--> statement-breakpoint
CREATE INDEX `idx_messages_fil` ON `messages` (`fil_id`);--> statement-breakpoint
CREATE TABLE `salons` (
	`rid` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`nom` text,
	`nom_affiche` text,
	`chiffre` integer DEFAULT false NOT NULL,
	`lecture_seule` integer DEFAULT false NOT NULL,
	`dernier_message` text,
	`horodatage_dernier_message` integer,
	`mis_a_jour_le` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_salons_activite` ON `salons` (`horodatage_dernier_message`);--> statement-breakpoint
CREATE TABLE `sortie` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`texte` text NOT NULL,
	`fil_id` text,
	`statut` text DEFAULT 'en-attente' NOT NULL,
	`tentatives` integer DEFAULT 0 NOT NULL,
	`derniere_erreur` text,
	`cree_le` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sortie_statut` ON `sortie` (`statut`);