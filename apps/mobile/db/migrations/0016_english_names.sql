DROP INDEX `idx_salons_activite`;--> statement-breakpoint
DROP INDEX `idx_messages_salon_date`;--> statement-breakpoint
DROP INDEX `idx_messages_fil`;--> statement-breakpoint
ALTER TABLE `salons` RENAME TO `rooms`;--> statement-breakpoint
ALTER TABLE `rooms` RENAME COLUMN `nom` TO `name`;--> statement-breakpoint
ALTER TABLE `rooms` RENAME COLUMN `nom_affiche` TO `display_name`;--> statement-breakpoint
ALTER TABLE `rooms` RENAME COLUMN `chiffre` TO `encrypted`;--> statement-breakpoint
ALTER TABLE `rooms` RENAME COLUMN `lecture_seule` TO `read_only`;--> statement-breakpoint
ALTER TABLE `rooms` RENAME COLUMN `dm_autre_uid` TO `dm_other_uid`;--> statement-breakpoint
ALTER TABLE `rooms` RENAME COLUMN `dernier_message` TO `last_message`;--> statement-breakpoint
ALTER TABLE `rooms` RENAME COLUMN `dernier_message_type` TO `last_message_type`;--> statement-breakpoint
ALTER TABLE `rooms` RENAME COLUMN `horodatage_dernier_message` TO `last_message_ts`;--> statement-breakpoint
ALTER TABLE `rooms` RENAME COLUMN `mis_a_jour_le` TO `updated_at`;--> statement-breakpoint
ALTER TABLE `abonnements` RENAME TO `subscriptions`;--> statement-breakpoint
ALTER TABLE `subscriptions` RENAME COLUMN `non_lus` TO `unread`;--> statement-breakpoint
ALTER TABLE `subscriptions` RENAME COLUMN `mentions_groupe` TO `group_mentions`;--> statement-breakpoint
ALTER TABLE `subscriptions` RENAME COLUMN `alerte` TO `alert`;--> statement-breakpoint
ALTER TABLE `subscriptions` RENAME COLUMN `ouvert` TO `open`;--> statement-breakpoint
ALTER TABLE `subscriptions` RENAME COLUMN `favori` TO `favorite`;--> statement-breakpoint
ALTER TABLE `subscriptions` RENAME COLUMN `lu_jusqu_a` TO `last_seen`;--> statement-breakpoint
ALTER TABLE `subscriptions` RENAME COLUMN `mis_a_jour_le` TO `updated_at`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `texte` TO `text`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `horodatage` TO `ts`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `auteur_id` TO `author_id`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `auteur_nom` TO `author_name`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `type_systeme` TO `system_type`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `fil_id` TO `thread_id`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `fil_reponses` TO `thread_count`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `fil_dernier` TO `thread_last`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `fil_affiche` TO `thread_shown`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `modifie_le` TO `edited_at`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `pieces_jointes` TO `attachments`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `appel_id` TO `call_id`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `chiffre_brut` TO `encrypted_raw`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `epingle` TO `pinned`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `etoiles` TO `starred`;--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `mis_a_jour_le` TO `updated_at`;--> statement-breakpoint
ALTER TABLE `brouillons` RENAME TO `drafts`;--> statement-breakpoint
ALTER TABLE `drafts` RENAME COLUMN `cle` TO `key`;--> statement-breakpoint
ALTER TABLE `drafts` RENAME COLUMN `texte` TO `text`;--> statement-breakpoint
ALTER TABLE `drafts` RENAME COLUMN `mis_a_jour_le` TO `updated_at`;--> statement-breakpoint
ALTER TABLE `emojis_custom` RENAME TO `custom_emojis`;--> statement-breakpoint
ALTER TABLE `custom_emojis` RENAME COLUMN `nom` TO `name`;--> statement-breakpoint
ALTER TABLE `custom_emojis` RENAME COLUMN `mis_a_jour_le` TO `updated_at`;--> statement-breakpoint
ALTER TABLE `utilisateurs` RENAME TO `users`;--> statement-breakpoint
ALTER TABLE `users` RENAME COLUMN `mis_a_jour_le` TO `updated_at`;--> statement-breakpoint
ALTER TABLE `etat_synchro` RENAME TO `cursors`;--> statement-breakpoint
ALTER TABLE `cursors` RENAME COLUMN `portee` TO `scope`;--> statement-breakpoint
ALTER TABLE `cursors` RENAME COLUMN `flux` TO `stream`;--> statement-breakpoint
ALTER TABLE `cursors` RENAME COLUMN `mis_a_jour_depuis` TO `updated_since`;--> statement-breakpoint
CREATE INDEX `idx_rooms_activity` ON `rooms` (`last_message_ts`);--> statement-breakpoint
CREATE INDEX `idx_messages_room_ts` ON `messages` (`rid`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_messages_thread` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`text` text NOT NULL,
	`thread_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `outbox` (`id`, `rid`, `text`, `thread_id`, `status`, `attempts`, `last_error`, `created_at`) SELECT `id`, `rid`, `texte`, `fil_id`, CASE `statut` WHEN 'en-attente' THEN 'pending' WHEN 'echec' THEN 'failed' ELSE `statut` END, `tentatives`, `derniere_erreur`, `cree_le` FROM `sortie`;--> statement-breakpoint
DROP TABLE `sortie`;--> statement-breakpoint
CREATE INDEX `idx_outbox_status` ON `outbox` (`status`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`rid` text NOT NULL,
	`uri` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`caption` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`file_id` text,
	`created_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `uploads` (`id`, `rid`, `uri`, `name`, `type`, `caption`, `status`, `last_error`, `file_id`, `created_at`) SELECT `id`, `rid`, `uri`, `nom`, `type`, `legende`, CASE `statut` WHEN 'en-attente' THEN 'pending' WHEN 'envoi' THEN 'sending' WHEN 'echec' THEN 'failed' ELSE `statut` END, `derniere_erreur`, `file_id`, `cree_le` FROM `televersements`;--> statement-breakpoint
DROP TABLE `televersements`;--> statement-breakpoint
CREATE INDEX `idx_uploads_status` ON `uploads` (`status`);--> statement-breakpoint
UPDATE `cursors` SET `stream` = CASE `stream` WHEN 'salons' THEN 'rooms' WHEN 'abonnements' THEN 'subscriptions' WHEN 'messages-supprimes' THEN 'messages-deleted' ELSE `stream` END;--> statement-breakpoint
UPDATE `rooms` SET `avatar_etag` = 'none' WHERE `avatar_etag` = 'sans-photo';--> statement-breakpoint
UPDATE `users` SET `avatar_etag` = 'none' WHERE `avatar_etag` = 'sans-photo';
