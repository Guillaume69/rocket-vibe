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

import { filtrerAliases, type DepotEmojis, type EmojiCustom } from '../lib/emojisCustom.ts';
import type { DepotEnvoi, LigneSortie } from '../lib/envoi.ts';
import type { DepotTeleversements, LigneTeleversement } from '../lib/envoiFichiers.ts';
import type { Depot, EcrituresDepot } from '../lib/sync.ts';
import type { FileEcritures } from './fileEcritures.ts';
import {
  APPLIQUER_RETENTION,
  INSERER_EMOJI_CUSTOM,
  INSERER_SORTIE,
  LISTER_RIDS_CONNUS,
  PURGER_BROUILLONS_ABSENTS,
  PURGER_CURSEURS_ABSENTS,
  PURGER_SORTIE_ABSENTE,
  PURGER_TELEVERSEMENTS_ABSENTS,
  SUPPRIMER_BROUILLONS_SALON,
  SUPPRIMER_CURSEURS_SALON,
  SUPPRIMER_SORTIE_SALON,
  SUPPRIMER_TELEVERSEMENTS_SALON,
  INSERER_TELEVERSEMENT,
  LISTER_EMOJIS_CUSTOM,
  VIDER_EMOJIS_CUSTOM,
  paramsEmojiCustom,
  LISTER_TELEVERSEMENTS_A_ENVOYER,
  MARQUER_TELEVERSEMENT_ECHEC,
  MARQUER_TELEVERSEMENT_EN_VOL,
  MESSAGE_AVEC_FICHIER,
  NOTER_FILE_ID,
  REARMER_TELEVERSEMENT,
  REARMER_TELEVERSEMENTS_EN_VOL,
  SUPPRIMER_TELEVERSEMENT,
  LIRE_BROUILLON,
  UPSERT_BROUILLON,
  SUPPRIMER_BROUILLON,
  LIRE_CURSEUR,
  DERNIER_MESSAGE_MIS_A_JOUR,
  LISTER_CLES_SALON,
  MAJ_AVATAR_SALON,
  MAJ_AVATAR_UTILISATEUR,
  UPSERT_IDENTITE,
  paramsIdentite,
  MESSAGES_A_DECHIFFRER,
  MAJ_TEXTE_MESSAGE,
  MAJ_MARQUES_MESSAGE,
  MASQUER_MESSAGES_CHIFFRES,
  MAJ_APERCU_CHIFFRE,
  MASQUER_APERCU_CHIFFRE,
  LISTER_SORTIE_A_ENVOYER,
  MARQUER_SORTIE_ECHEC,
  PURGER_ABONNEMENTS_ABSENTS,
  PURGER_MESSAGES_ABSENTS,
  PURGER_SALONS_ABSENTS,
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
  UPSERT_UTILISATEUR,
  paramsAbonnement,
  paramsMessage,
  paramsSalon,
  paramsUtilisateur,
} from './upserts.ts';

/** Le quota de rétention, par salon. Voir `APPLIQUER_RETENTION`. */
export const MESSAGES_GARDES_PAR_SALON = 500;

export function creerDepot(brute: SQLiteDatabase, enSerie: FileEcritures): Depot {
  /**
   * Ce qu'un salon laisse derrière lui et que personne ne peut plus atteindre :
   * sa file d'envoi, sa file de téléversements, ses brouillons, ses curseurs.
   * Aucun écran ne lit ces lignes hors du salon ouvert — donc plus aucun
   * bouton « abandonner » — mais le rejeu, lui, les reprend à chaque
   * raccordement. Les messages, eux, restent à la charge de la
   * réconciliation, comme avant : c'est elle qui balaye les orphelins.
   */
  const effacerSatellites = async (rid: string): Promise<void> => {
    await brute.runAsync(SUPPRIMER_SORTIE_SALON, [rid]);
    await brute.runAsync(SUPPRIMER_TELEVERSEMENTS_SALON, [rid]);
    await brute.runAsync(SUPPRIMER_BROUILLONS_SALON, [rid]);
    await brute.runAsync(SUPPRIMER_CURSEURS_SALON, [rid]);
  };

  // Les écritures DIRECTES, sans file : c'est ce que reçoit le `fn` d'une
  // transaction (la file attend la fin de la transaction ouverte — passer
  // par elle depuis `fn` s'interbloquerait, la signature de
  // `Depot.transaction` l'interdit).
  const direct: EcrituresDepot = {
    async upsertMessage(m) {
      await brute.runAsync(UPSERT_MESSAGE, paramsMessage(m));
      // L'identité de l'auteur (`uid → pseudo courant`) se dérive de chaque
      // message : le plus récent par uid fait foi. Un message chiffré
      // indéchiffrable n'a pas de pseudo (`auteurNom` null) — rien à noter.
      if (m.auteurNom !== null) {
        await brute.runAsync(
          UPSERT_UTILISATEUR,
          paramsUtilisateur({ uid: m.auteurId, username: m.auteurNom, misAJourLe: m.misAJourLe }),
        );
      }
      // Réconciliation de la file d'envoi : ce dépôt ne reçoit QUE des
      // documents d'origine serveur (stream, historique, réponse d'envoi).
      // L'un d'eux qui porte notre `_id` prouve la livraison — la ligne de
      // sortie n'a plus de raison d'être, quel que soit son statut.
      await brute.runAsync(SUPPRIMER_SORTIE, [m.id]);
    },
    async upsertSalon(s) {
      await brute.runAsync(UPSERT_SALON, paramsSalon(s));
      // L'AUTRE d'un DM entre dans `utilisateurs` dès l'ingestion du salon, sans
      // attendre qu'un de ses messages soit chargé : la liste montre sa photo, et
      // le stream `updateAvatar` ne sait la rattacher qu'à une ligne existante
      // (il ne désigne l'utilisateur que par son pseudo). Sans cela, l'avatar
      // d'un DM jamais ouvert ne se rafraîchirait jamais.
      if (s.dmAutreUid !== null && s.dmAutreUsername !== null) {
        await brute.runAsync(
          UPSERT_IDENTITE,
          paramsIdentite({ uid: s.dmAutreUid, username: s.dmAutreUsername, avatarEtag: null }),
        );
      }
    },
    async upsertAbonnement(a) {
      await brute.runAsync(UPSERT_ABONNEMENT, paramsAbonnement(a));
    },
    async supprimerMessage(id) {
      await brute.runAsync(SUPPRIMER_MESSAGE, [id]);
      // L'aperçu de liste d'un salon CHIFFRÉ n'a pas de source serveur — le
      // stream ne porte que du ciphertext. Effacer le dernier message y
      // laisserait donc son texte en aperçu, indéfiniment. On le recalcule sur
      // les messages restants ; le SQL ne touche rien s'il n'a rien à changer,
      // et c'est un no-op sans salon chiffré. Les salons en clair, eux, sont
      // couverts par le `rooms-changed` qui suit toute suppression.
      await brute.runAsync(MAJ_APERCU_CHIFFRE);
    },
    async supprimerSalon(rid) {
      await brute.runAsync(SUPPRIMER_SALON, [rid]);
      await effacerSatellites(rid);
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
      await effacerSatellites(ligne.rid);
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
    async listerRidsConnus() {
      const lignes = await brute.getAllAsync<{ rid: string }>(LISTER_RIDS_CONNUS);
      return lignes.map((l) => l.rid);
    },
    purgerSalonsAbsents(ridsVivants, ridsConnus) {
      // Garde-fou : jamais de purge totale sur une liste vide (réponse serveur
      // muette ou tronquée). L'appelant garde aussi ce test — ceinture et
      // bretelles, car `NOT IN (rien)` effacerait tout ce qui est connu.
      if (ridsVivants.length === 0 || ridsConnus.length === 0) return Promise.resolve();
      const vivants = JSON.stringify(ridsVivants);
      const connus = JSON.stringify(ridsConnus);
      // Les sept DELETE en UNE transaction : un seul événement de changement
      // pour `useLiveQuery`, et pas de fenêtre où les tables sont incohérentes.
      return enSerie(() =>
        brute.withTransactionAsync(async () => {
          for (const sql of [
            PURGER_SALONS_ABSENTS,
            PURGER_ABONNEMENTS_ABSENTS,
            PURGER_MESSAGES_ABSENTS,
            PURGER_SORTIE_ABSENTE,
            PURGER_TELEVERSEMENTS_ABSENTS,
            PURGER_BROUILLONS_ABSENTS,
            PURGER_CURSEURS_ABSENTS,
          ]) {
            await brute.runAsync(sql, [connus, vivants]);
          }
        }),
      );
    },
    appliquerRetention: (nbMax) =>
      enSerie(async () => {
        await brute.runAsync(APPLIQUER_RETENTION, [nbMax]);
      }),
    async lireCurseur(portee, flux) {
      // Lecture : pas de file. Elle peut voir un lot non commis — sans
      // conséquence, les curseurs ne s'écrivent qu'après le retour du lot.
      const ligne = await brute.getFirstAsync<{ mis_a_jour_depuis: number }>(LIRE_CURSEUR, [
        portee,
        flux,
      ]);
      return ligne?.mis_a_jour_depuis ?? null;
    },
    async dernierMessageMisAJour(rid) {
      // Lecture directe (pas de file), comme `lireCurseur`. `MAX(...)` d'un
      // salon sans message local rend `NULL` → `null`.
      const ligne = await brute.getFirstAsync<{ mis_a_jour_le: number | null }>(
        DERNIER_MESSAGE_MIS_A_JOUR,
        [rid],
      );
      return ligne?.mis_a_jour_le ?? null;
    },
    ecrireCurseur: (portee, flux, v) => enSerie(() => direct.ecrireCurseur(portee, flux, v)),
    async listerClesSalon() {
      const lignes = await brute.getAllAsync<{ rid: string; e2e_key: string }>(LISTER_CLES_SALON);
      return lignes.map((l) => ({ rid: l.rid, e2eKey: l.e2e_key }));
    },
    async messagesADechiffrer() {
      const lignes = await brute.getAllAsync<{ id: string; rid: string; chiffre_brut: string }>(
        MESSAGES_A_DECHIFFRER,
      );
      return lignes.map((l) => ({ id: l.id, rid: l.rid, chiffreBrut: l.chiffre_brut }));
    },
    // La passe de déverrouillage écrit le clair : elle passe par la file, comme
    // toute écriture, pour ne pas s'intercaler dans une transaction ouverte.
    majTexteMessage: (id, texte) =>
      enSerie(async () => {
        await brute.runAsync(MAJ_TEXTE_MESSAGE, [texte, id]);
      }),
    majMarquesMessage: (id, epingle, etoiles) =>
      enSerie(async () => {
        await brute.runAsync(MAJ_MARQUES_MESSAGE, [epingle ? 1 : 0, etoiles, id]);
      }),
    masquerMessagesChiffres: () =>
      enSerie(async () => {
        await brute.runAsync(MASQUER_MESSAGES_CHIFFRES);
        await brute.runAsync(MASQUER_APERCU_CHIFFRE);
      }),
    majApercuChiffre: () =>
      enSerie(async () => {
        await brute.runAsync(MAJ_APERCU_CHIFFRE);
      }),
    // Versions d'avatar. L'etag est passé deux fois : le SQL ne touche la ligne
    // que s'il CHANGE (voir `MAJ_AVATAR_UTILISATEUR`).
    majAvatarUtilisateur: (username, etag) =>
      enSerie(async () => {
        await brute.runAsync(MAJ_AVATAR_UTILISATEUR, [etag, username, etag]);
      }),
    majAvatarSalon: (rid, etag) =>
      enSerie(async () => {
        await brute.runAsync(MAJ_AVATAR_SALON, [etag, rid, etag]);
      }),
    enregistrerIdentite: (identite) =>
      enSerie(async () => {
        await brute.runAsync(UPSERT_IDENTITE, paramsIdentite(identite));
      }),
    transaction(fn) {
      // Un lot = un commit = UN événement de changement pour `useLiveQuery`,
      // au lieu d'une ré-exécution de chaque requête vive par ligne insérée.
      return enSerie(() => brute.withTransactionAsync(() => fn(direct)));
    },
  };
}

/**
 * Emojis custom : même connexion, même file que les autres dépôts (un `BEGIN`
 * concurrent hors file mourrait sur « no transaction is active »). Le
 * remplacement est un `DELETE`+`INSERT` sous UNE transaction — donc UN seul
 * événement de changement pour `useLiveQuery`, et pas de fenêtre où la table
 * est vide.
 */
export function creerDepotEmojis(brute: SQLiteDatabase, enSerie: FileEcritures): DepotEmojis {
  return {
    remplacer(entrees: EmojiCustom[]) {
      return enSerie(() =>
        brute.withTransactionAsync(async () => {
          await brute.runAsync(VIDER_EMOJIS_CUSTOM);
          for (const e of entrees) {
            await brute.runAsync(
              INSERER_EMOJI_CUSTOM,
              paramsEmojiCustom({ ...e, misAJourLe: Date.now() }),
            );
          }
        }),
      );
    },
    async lister(): Promise<EmojiCustom[]> {
      const lignes = await brute.getAllAsync<{ nom: string; extension: string; aliases: string }>(
        LISTER_EMOJIS_CUSTOM,
      );
      return lignes.map((l) => ({
        nom: l.nom,
        extension: l.extension,
        // `aliases` est du JSON écrit par nous ; un `catch` évite qu'une ligne
        // corrompue prive tout le salon de ses autres emojis. Le même filtre
        // (`filtrerAliases`) qu'à l'ingestion réseau, une fois le JSON parsé.
        aliases: parseAliases(l.aliases),
      }));
    },
  };
}

function parseAliases(brut: string): string[] {
  try {
    return filtrerAliases(JSON.parse(brut));
  } catch {
    return [];
  }
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

/** Le SQL rend `file_id` en snake — la remise en `fileId` est explicite, ci-dessous. */
type BruteTeleversement = {
  id: string;
  rid: string;
  uri: string;
  nom: string;
  type: string;
  legende: string | null;
  statut: 'en-attente' | 'envoi' | 'echec';
  file_id: string | null;
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
      const lignes = await brute.getAllAsync<BruteTeleversement>(LISTER_TELEVERSEMENTS_A_ENVOYER);
      return lignes.map((l) => ({
        id: l.id,
        rid: l.rid,
        uri: l.uri,
        nom: l.nom,
        type: l.type,
        legende: l.legende,
        statut: l.statut,
        fileId: l.file_id,
      }));
    },
    async prendreEnCharge(id) {
      // Hors `enSerie` : on a besoin du nombre de lignes touchées, et c'est LUI
      // qui dit si une autre passe nous a devancés.
      const r = await brute.runAsync(MARQUER_TELEVERSEMENT_EN_VOL, [id]);
      return r.changes > 0;
    },
    rearmerEnVol(enVolIci) {
      return enSerie(() =>
        brute.runAsync(REARMER_TELEVERSEMENTS_EN_VOL, [JSON.stringify(enVolIci)]).then(() => {}),
      );
    },
    rearmer(id) {
      return enSerie(() => brute.runAsync(REARMER_TELEVERSEMENT, [id]).then(() => {}));
    },
    noterFileId(id, fileId) {
      return enSerie(() => brute.runAsync(NOTER_FILE_ID, [fileId, id]).then(() => {}));
    },
    async fichierDejaPoste(rid, fileId) {
      const l = await brute.getFirstAsync<{ id: string }>(MESSAGE_AVEC_FICHIER, [rid, fileId]);
      return l !== null;
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

/**
 * Brouillons de composer. Ils écrivaient jusqu'ici en direct sur la connexion
 * partagée, hors file — le seul chemin d'écriture du dépôt à le faire. Le
 * débounce de 400 ms qui tombait pendant l'ingestion d'une page de 50 messages
 * faisait entrer l'INSERT dans le `BEGIN` du lot (`withTransactionAsync` n'est
 * pas exclusif), et un échec du lot annulait le brouillon en silence.
 */
export type DepotBrouillons = {
  /** `null` si aucun brouillon pour cette clé. */
  lire: (cle: string) => Promise<string | null>;
  ecrire: (cle: string, texte: string) => Promise<void>;
  supprimer: (cle: string) => Promise<void>;
};

export function creerDepotBrouillons(
  brute: SQLiteDatabase,
  enSerie: FileEcritures,
): DepotBrouillons {
  return {
    async lire(cle) {
      const ligne = await brute.getFirstAsync<{ texte: string }>(LIRE_BROUILLON, [cle]);
      return ligne?.texte ?? null;
    },
    ecrire(cle, texte) {
      return enSerie(() =>
        brute.runAsync(UPSERT_BROUILLON, [cle, texte, Date.now()]).then(() => {}),
      );
    },
    supprimer(cle) {
      return enSerie(() => brute.runAsync(SUPPRIMER_BROUILLON, [cle]).then(() => {}));
    },
  };
}
