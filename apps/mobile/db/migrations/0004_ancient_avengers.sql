ALTER TABLE `salons` ADD `dm_autre_uid` text;--> statement-breakpoint
-- Rétro-remplissage par invalidation : `rooms.get?updatedSince` saute les
-- salons inchangés, donc un DM déjà synchronisé garderait `dm_autre_uid`
-- NULL à jamais. Curseur effacé = prochain rattrapage complet, qui repasse
-- chaque salon par `versSalon`.
DELETE FROM `etat_synchro` WHERE `portee` = '*' AND `flux` = 'salons';
