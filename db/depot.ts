/**
 * Implémentation du `Depot` sur `expo-sqlite`.
 *
 * On passe par `runAsync` avec le SQL et les constructeurs de paramètres de
 * `db/upserts.ts` plutôt que par le constructeur de requêtes de Drizzle : c'est
 * **exactement** ce que les tests exécutent sur `node:sqlite`. Un
 * `onConflictDoUpdate` reconstruit ici pourrait diverger du SQL testé sans que
 * rien ne le signale.
 *
 * Les écritures passent par la connexion ouverte avec `enableChangeListener`,
 * donc `useLiveQuery` les voit : l'UI se rafraîchit sans qu'on la prévienne.
 */

import type { SQLiteDatabase } from 'expo-sqlite';

import type { DepotEnvoi, LigneSortie } from '../lib/envoi.ts';
import type { Depot } from '../lib/sync.ts';
import {
  INSERER_SORTIE,
  LIRE_CURSEUR,
  LISTER_SORTIE_A_ENVOYER,
  MARQUER_SORTIE_ECHEC,
  RID_PAR_SUB_ID,
  SUPPRIMER_ABONNEMENT,
  SUPPRIMER_MESSAGE,
  SUPPRIMER_MESSAGE_OPTIMISTE,
  SUPPRIMER_SALON,
  SUPPRIMER_SORTIE,
  UPSERT_ABONNEMENT,
  UPSERT_CURSEUR,
  UPSERT_MESSAGE,
  UPSERT_SALON,
  paramsAbonnement,
  paramsMessage,
  paramsSalon,
} from './upserts.ts';

export function creerDepot(brute: SQLiteDatabase): Depot {
  return {
    async upsertMessage(m) {
      await brute.runAsync(UPSERT_MESSAGE, paramsMessage(m));
      // Réconciliation de la file d'envoi : ce dépôt ne reçoit QUE des
      // documents d'origine serveur (stream, historique, réponse d'envoi).
      // L'un d'eux qui porte notre `_id` prouve la livraison — la ligne de
      // sortie n'a plus de raison d'être, quel que soit son statut.
      await brute.runAsync(SUPPRIMER_SORTIE, [m.id]);
    },
    async upsertSalon(s) {
      await brute.runAsync(UPSERT_SALON, paramsSalon(s));
    },
    async upsertAbonnement(a) {
      await brute.runAsync(UPSERT_ABONNEMENT, paramsAbonnement(a));
    },
    async supprimerMessage(id) {
      await brute.runAsync(SUPPRIMER_MESSAGE, [id]);
    },
    async supprimerSalon(rid) {
      await brute.runAsync(SUPPRIMER_SALON, [rid]);
    },
    async supprimerAbonnement(rid) {
      await brute.runAsync(SUPPRIMER_ABONNEMENT, [rid]);
    },
    async supprimerParSubId(subId) {
      const ligne = await brute.getFirstAsync<{ rid: string }>(RID_PAR_SUB_ID, [subId]);
      if (ligne === null) return;
      await brute.runAsync(SUPPRIMER_ABONNEMENT, [ligne.rid]);
      // Quitter un salon le fait disparaître de la liste — le document Rooms
      // existe toujours côté serveur, mais plus pour ce compte.
      await brute.runAsync(SUPPRIMER_SALON, [ligne.rid]);
    },
    async lireCurseur(portee, flux) {
      const ligne = await brute.getFirstAsync<{ mis_a_jour_depuis: number }>(LIRE_CURSEUR, [
        portee,
        flux,
      ]);
      return ligne?.mis_a_jour_depuis ?? null;
    },
    async ecrireCurseur(portee, flux, misAJourDepuis) {
      await brute.runAsync(UPSERT_CURSEUR, [portee, flux, misAJourDepuis]);
    },
    async transaction(fn) {
      // Un lot = un commit = UN événement de changement pour `useLiveQuery`,
      // au lieu d'une ré-exécution de chaque requête vive par ligne insérée.
      await brute.withTransactionAsync(fn);
    },
  };
}

type BruteSortie = {
  id: string;
  rid: string;
  texte: string;
  fil_id: string | null;
  statut: 'en-attente' | 'echec';
  tentatives: number;
};

export function creerDepotEnvoi(brute: SQLiteDatabase): DepotEnvoi {
  return {
    async insererSortie(id, rid, texte, filId) {
      await brute.runAsync(INSERER_SORTIE, [id, rid, texte, filId, Date.now()]);
    },
    async listerAEnvoyer(): Promise<LigneSortie[]> {
      const lignes = await brute.getAllAsync<BruteSortie>(LISTER_SORTIE_A_ENVOYER);
      return lignes.map((l) => ({
        id: l.id,
        rid: l.rid,
        texte: l.texte,
        filId: l.fil_id,
        statut: l.statut,
        tentatives: l.tentatives,
      }));
    },
    async marquerEchec(id, erreur) {
      await brute.runAsync(MARQUER_SORTIE_ECHEC, [erreur, id]);
    },
    async supprimerSortie(id) {
      await brute.runAsync(SUPPRIMER_SORTIE, [id]);
    },
    async upsertMessage(m) {
      await brute.runAsync(UPSERT_MESSAGE, paramsMessage(m));
    },
    async supprimerMessageOptimiste(id) {
      await brute.runAsync(SUPPRIMER_MESSAGE_OPTIMISTE, [id]);
    },
  };
}
