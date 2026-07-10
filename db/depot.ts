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
import type { DepotTeleversements, LigneTeleversement } from '../lib/envoiFichiers.ts';
import type { Depot, EcrituresDepot } from '../lib/sync.ts';
import {
  INSERER_SORTIE,
  INSERER_TELEVERSEMENT,
  LISTER_TELEVERSEMENTS_A_ENVOYER,
  MARQUER_TELEVERSEMENT_ECHEC,
  SUPPRIMER_TELEVERSEMENT,
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

/**
 * File d'écritures d'UNE connexion SQLite. Les transactions de
 * `withTransactionAsync` sont par CONNEXION et non réentrantes : toute
 * écriture hors file émise pendant un `BEGIN` ouvert serait absorbée dedans —
 * et silencieusement annulée si le lot échoue. La file appartient donc à la
 * connexion, pas à un dépôt : les trois dépôts (`creerDepot`,
 * `creerDepotEnvoi`, `creerDepotTeleversements`) bâtis sur la même connexion
 * doivent recevoir la MÊME instance.
 *
 * Deux lots concurrents entrelacés mouraient sur « cannot rollback - no
 * transaction is active » — constaté sur l'AVD (historique d'écran +
 * rattrapage du raccordement).
 */
export type FileEcritures = <T>(job: () => Promise<T>) => Promise<T>;

export function creerFileEcritures(): FileEcritures {
  let queue: Promise<unknown> = Promise.resolve();
  return (job) => {
    // `tour` porte le rejet au demandeur ; la file, elle, l'avale pour ne
    // jamais se bloquer sur un échec passé.
    const tour = queue.then(job);
    queue = tour.then(
      () => {},
      () => {},
    );
    return tour;
  };
}

export function creerDepot(brute: SQLiteDatabase, enSerie: FileEcritures): Depot {
  // Les écritures DIRECTES, sans file : c'est ce que reçoit le `fn` d'une
  // transaction (la file attend la fin de la transaction ouverte — passer
  // par elle depuis `fn` s'interbloquerait, la signature de
  // `Depot.transaction` l'interdit).
  const direct: EcrituresDepot = {
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
    async ecrireCurseur(portee, flux, misAJourDepuis) {
      await brute.runAsync(UPSERT_CURSEUR, [portee, flux, misAJourDepuis]);
    },
  };

  return {
    upsertMessage: (m) => enSerie(() => direct.upsertMessage(m)),
    upsertSalon: (s) => enSerie(() => direct.upsertSalon(s)),
    upsertAbonnement: (a) => enSerie(() => direct.upsertAbonnement(a)),
    supprimerMessage: (id) => enSerie(() => direct.supprimerMessage(id)),
    supprimerSalon: (rid) => enSerie(() => direct.supprimerSalon(rid)),
    supprimerAbonnement: (rid) => enSerie(() => direct.supprimerAbonnement(rid)),
    supprimerParSubId: (subId) => enSerie(() => direct.supprimerParSubId(subId)),
    async lireCurseur(portee, flux) {
      // Lecture : pas de file. Elle peut voir un lot non commis — sans
      // conséquence, les curseurs ne s'écrivent qu'après le retour du lot.
      const ligne = await brute.getFirstAsync<{ mis_a_jour_depuis: number }>(LIRE_CURSEUR, [
        portee,
        flux,
      ]);
      return ligne?.mis_a_jour_depuis ?? null;
    },
    ecrireCurseur: (portee, flux, v) => enSerie(() => direct.ecrireCurseur(portee, flux, v)),
    transaction(fn) {
      // Un lot = un commit = UN événement de changement pour `useLiveQuery`,
      // au lieu d'une ré-exécution de chaque requête vive par ligne insérée.
      return enSerie(() => brute.withTransactionAsync(() => fn(direct)));
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

export function creerDepotEnvoi(brute: SQLiteDatabase, enSerie: FileEcritures): DepotEnvoi {
  // Écritures dans la MÊME file que les lots de synchro : émises hors file
  // pendant un lot ouvert, elles rejoindraient sa transaction — un rollback
  // du lot emporterait alors le message que l'utilisateur vient d'envoyer.
  return {
    insererSortie(id, rid, texte, filId) {
      return enSerie(() =>
        brute.runAsync(INSERER_SORTIE, [id, rid, texte, filId, Date.now()]).then(() => {}),
      );
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
    marquerEchec(id, erreur) {
      return enSerie(() => brute.runAsync(MARQUER_SORTIE_ECHEC, [erreur, id]).then(() => {}));
    },
    supprimerSortie(id) {
      return enSerie(() => brute.runAsync(SUPPRIMER_SORTIE, [id]).then(() => {}));
    },
    upsertMessage(m) {
      return enSerie(() => brute.runAsync(UPSERT_MESSAGE, paramsMessage(m)).then(() => {}));
    },
    supprimerMessageOptimiste(id) {
      return enSerie(() => brute.runAsync(SUPPRIMER_MESSAGE_OPTIMISTE, [id]).then(() => {}));
    },
  };
}

type BruteTeleversement = {
  id: string;
  rid: string;
  uri: string;
  nom: string;
  type: string;
  legende: string | null;
  statut: 'en-attente' | 'echec';
};

export function creerDepotTeleversements(
  brute: SQLiteDatabase,
  enSerie: FileEcritures,
): DepotTeleversements {
  return {
    inserer(ligne) {
      return enSerie(() =>
        brute
          .runAsync(INSERER_TELEVERSEMENT, [
            ligne.id,
            ligne.rid,
            ligne.uri,
            ligne.nom,
            ligne.type,
            ligne.legende,
            Date.now(),
          ])
          .then(() => {}),
      );
    },
    async listerAEnvoyer(): Promise<LigneTeleversement[]> {
      return brute.getAllAsync<BruteTeleversement>(LISTER_TELEVERSEMENTS_A_ENVOYER);
    },
    marquerEchec(id, erreur) {
      return enSerie(() =>
        brute.runAsync(MARQUER_TELEVERSEMENT_ECHEC, [erreur, id]).then(() => {}),
      );
    },
    supprimer(id) {
      return enSerie(() => brute.runAsync(SUPPRIMER_TELEVERSEMENT, [id]).then(() => {}));
    },
  };
}
