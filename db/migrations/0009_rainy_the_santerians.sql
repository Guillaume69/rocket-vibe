CREATE TABLE `utilisateurs` (
	`uid` text PRIMARY KEY NOT NULL,
	`username` text,
	`mis_a_jour_le` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- Backfill : sans lui, la table naît vide et les messages DÉJÀ en base ne la
-- peupleraient qu'à leur prochaine ré-ingestion (souvent jamais, pour un
-- historique profond). On sème depuis l'existant : pour chaque auteur, le pseudo
-- de son message le PLUS RÉCENT. `MAX(mis_a_jour_le)` fixe la ligne d'où
-- `auteur_nom` est tiré (règle SQLite des « bare columns » avec un seul max()).
INSERT INTO `utilisateurs` (`uid`, `username`, `mis_a_jour_le`)
SELECT `auteur_id`, `auteur_nom`, MAX(`mis_a_jour_le`)
FROM `messages`
WHERE `auteur_nom` IS NOT NULL
GROUP BY `auteur_id`;
