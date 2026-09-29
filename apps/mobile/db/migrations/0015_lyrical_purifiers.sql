ALTER TABLE `abonnements` ADD `roles` text;--> statement-breakpoint
-- Les abonnements déjà en base n'ont pas leurs rôles : sans curseur, le prochain
-- rattrapage relit tous les abonnements (subscriptions.get sans updatedSince).
DELETE FROM `etat_synchro` WHERE `portee` = '*' AND `flux` = 'abonnements';
