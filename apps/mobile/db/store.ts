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
 * donc `useRequeteVive` les voit : l'UI se rafraîchit sans qu'on la prévienne.
 */

import type { SQLiteDatabase } from 'expo-sqlite';

import { filterAliases, type EmojiStore, type EmojiCustom } from '../lib/customEmojis.ts';
import type { OutboxStore, OutboxRow } from '../lib/outbox.ts';
import type { UploadStore, UploadRow } from '../lib/uploadQueue.ts';
import type { Store, StoreWrites } from '../lib/sync.ts';
import type { WriteQueue } from './writeQueue.ts';
import {
  APPLY_RETENTION,
  INSERT_CUSTOM_EMOJI,
  INSERT_OUTBOX,
  LIST_KNOWN_RIDS,
  PURGE_MISSING_DRAFTS,
  PURGE_MISSING_CURSORS,
  PURGE_MISSING_OUTBOX,
  PURGE_MISSING_UPLOADS,
  DELETE_ROOM_DRAFTS,
  DELETE_ROOM_CURSORS,
  DELETE_ROOM_OUTBOX,
  DELETE_ROOM_UPLOADS,
  INSERT_UPLOAD,
  LIST_CUSTOM_EMOJIS,
  CLEAR_CUSTOM_EMOJIS,
  paramsEmojiCustom,
  LIST_UPLOADS_TO_SEND,
  MARK_UPLOAD_FAILED,
  MARK_UPLOAD_IN_FLIGHT,
  MESSAGE_WITH_FILE,
  RECORD_FILE_ID,
  REARM_UPLOAD,
  REARM_IN_FLIGHT_UPLOADS,
  DELETE_UPLOAD,
  READ_DRAFT,
  UPSERT_DRAFT,
  DELETE_DRAFT,
  READ_CURSOR,
  LAST_MESSAGE_UPDATED_AT,
  LIST_ROOM_KEYS,
  UPDATE_ROOM_AVATAR,
  UPDATE_USER_AVATAR,
  UPSERT_IDENTITY,
  identityParams,
  MESSAGES_TO_DECRYPT,
  UPDATE_MESSAGE_TEXT,
  UPDATE_MESSAGE_MARKS,
  HIDE_ENCRYPTED_MESSAGES,
  UPDATE_ENCRYPTED_PREVIEW,
  HIDE_ENCRYPTED_PREVIEW,
  LIST_OUTBOX_TO_SEND,
  ROOM_ENCRYPTED,
  MARK_OUTBOX_FAILED,
  PURGE_MISSING_SUBSCRIPTIONS,
  PURGE_MISSING_MESSAGES,
  PURGE_MISSING_ROOMS,
  RID_BY_SUB_ID,
  DELETE_SUBSCRIPTION,
  DELETE_MESSAGE,
  DELETE_OPTIMISTIC_MESSAGE,
  DELETE_ROOM,
  DELETE_OUTBOX,
  UPSERT_SUBSCRIPTION,
  UPSERT_CURSOR,
  UPSERT_MESSAGE,
  UPSERT_ROOM,
  UPSERT_USER,
  subscriptionParams,
  paramsMessage,
  roomParams,
  userParams,
} from './upserts.ts';

/** Le quota de rétention, par salon. Voir `APPLIQUER_RETENTION`. */
export const MESSAGES_KEPT_PER_ROOM = 500;

export function createStore(brute: SQLiteDatabase, enSerie: WriteQueue): Store {
  /**
   * Ce qu'un salon laisse derrière lui et que personne ne peut plus atteindre :
   * sa file d'envoi, sa file de téléversements, ses brouillons, ses curseurs.
   * Aucun écran ne lit ces lignes hors du salon ouvert — donc plus aucun
   * bouton « abandonner » — mais le rejeu, lui, les reprend à chaque
   * raccordement. Les messages, eux, restent à la charge de la
   * réconciliation, comme avant : c'est elle qui balaye les orphelins.
   */
  const effacerSatellites = async (rid: string): Promise<void> => {
    await brute.runAsync(DELETE_ROOM_OUTBOX, [rid]);
    await brute.runAsync(DELETE_ROOM_UPLOADS, [rid]);
    await brute.runAsync(DELETE_ROOM_DRAFTS, [rid]);
    await brute.runAsync(DELETE_ROOM_CURSORS, [rid]);
  };

  // Les écritures DIRECTES, sans file : c'est ce que reçoit le `fn` d'une
  // transaction (la file attend la fin de la transaction ouverte — passer
  // par elle depuis `fn` s'interbloquerait, la signature de
  // `Depot.transaction` l'interdit).
  const direct: StoreWrites = {
    async upsertMessage(m) {
      await brute.runAsync(UPSERT_MESSAGE, paramsMessage(m));
      // L'identité de l'auteur (`uid → pseudo courant`) se dérive de chaque
      // message : le plus récent par uid fait foi. Un message chiffré
      // indéchiffrable n'a pas de pseudo (`auteurNom` null) — rien à noter.
      if (m.authorName !== null) {
        await brute.runAsync(
          UPSERT_USER,
          userParams({ uid: m.authorId, username: m.authorName, updatedAt: m.updatedAt }),
        );
      }
      // Réconciliation de la file d'envoi : ce dépôt ne reçoit QUE des
      // documents d'origine serveur (stream, historique, réponse d'envoi).
      // L'un d'eux qui porte notre `_id` prouve la livraison — la ligne de
      // sortie n'a plus de raison d'être, quel que soit son statut.
      await brute.runAsync(DELETE_OUTBOX, [m.id]);
    },
    async upsertRoom(s) {
      await brute.runAsync(UPSERT_ROOM, roomParams(s));
      // L'AUTRE d'un DM entre dans `utilisateurs` dès l'ingestion du salon, sans
      // attendre qu'un de ses messages soit chargé : la liste montre sa photo, et
      // le stream `updateAvatar` ne sait la rattacher qu'à une ligne existante
      // (il ne désigne l'utilisateur que par son pseudo). Sans cela, l'avatar
      // d'un DM jamais ouvert ne se rafraîchirait jamais.
      if (s.dmOtherUid !== null && s.dmOtherUsername !== null) {
        await brute.runAsync(
          UPSERT_IDENTITY,
          identityParams({ uid: s.dmOtherUid, username: s.dmOtherUsername, avatarEtag: null }),
        );
      }
    },
    async upsertSubscription(a) {
      await brute.runAsync(UPSERT_SUBSCRIPTION, subscriptionParams(a));
    },
    async deleteMessage(id) {
      await brute.runAsync(DELETE_MESSAGE, [id]);
      // L'aperçu de liste d'un salon CHIFFRÉ n'a pas de source serveur — le
      // stream ne porte que du ciphertext. Effacer le dernier message y
      // laisserait donc son texte en aperçu, indéfiniment. On le recalcule sur
      // les messages restants ; le SQL ne touche rien s'il n'a rien à changer,
      // et c'est un no-op sans salon chiffré. Les salons en clair, eux, sont
      // couverts par le `rooms-changed` qui suit toute suppression.
      await brute.runAsync(UPDATE_ENCRYPTED_PREVIEW);
    },
    async deleteRoom(rid) {
      await brute.runAsync(DELETE_ROOM, [rid]);
      await effacerSatellites(rid);
    },
    async deleteSubscription(rid) {
      await brute.runAsync(DELETE_SUBSCRIPTION, [rid]);
    },
    async deleteBySubId(subId) {
      const ligne = await brute.getFirstAsync<{ rid: string }>(RID_BY_SUB_ID, [subId]);
      if (ligne === null) return;
      await brute.runAsync(DELETE_SUBSCRIPTION, [ligne.rid]);
      // Quitter un salon le fait disparaître de la liste — le document Rooms
      // existe toujours côté serveur, mais plus pour ce compte.
      await brute.runAsync(DELETE_ROOM, [ligne.rid]);
      await effacerSatellites(ligne.rid);
    },
    async writeCursor(scope, stream, misAJourDepuis) {
      await brute.runAsync(UPSERT_CURSOR, [scope, stream, misAJourDepuis]);
    },
  };

  return {
    upsertMessage: (m) => enSerie(() => direct.upsertMessage(m)),
    upsertRoom: (s) => enSerie(() => direct.upsertRoom(s)),
    upsertSubscription: (a) => enSerie(() => direct.upsertSubscription(a)),
    deleteMessage: (id) => enSerie(() => direct.deleteMessage(id)),
    deleteRoom: (rid) => enSerie(() => direct.deleteRoom(rid)),
    deleteSubscription: (rid) => enSerie(() => direct.deleteSubscription(rid)),
    deleteBySubId: (subId) => enSerie(() => direct.deleteBySubId(subId)),
    async listKnownRids() {
      const lignes = await brute.getAllAsync<{ rid: string }>(LIST_KNOWN_RIDS);
      return lignes.map((l) => l.rid);
    },
    purgeMissingRooms(ridsVivants, ridsConnus) {
      // Garde-fou : jamais de purge totale sur une liste vide (réponse serveur
      // muette ou tronquée). L'appelant garde aussi ce test — ceinture et
      // bretelles, car `NOT IN (rien)` effacerait tout ce qui est connu.
      if (ridsVivants.length === 0 || ridsConnus.length === 0) return Promise.resolve();
      const vivants = JSON.stringify(ridsVivants);
      const connus = JSON.stringify(ridsConnus);
      // Les sept DELETE en UNE transaction : un seul rafraîchissement
      // des requêtes vives, et pas de fenêtre où les tables sont incohérentes.
      return enSerie(() =>
        brute.withTransactionAsync(async () => {
          for (const sql of [
            PURGE_MISSING_ROOMS,
            PURGE_MISSING_SUBSCRIPTIONS,
            PURGE_MISSING_MESSAGES,
            PURGE_MISSING_OUTBOX,
            PURGE_MISSING_UPLOADS,
            PURGE_MISSING_DRAFTS,
            PURGE_MISSING_CURSORS,
          ]) {
            await brute.runAsync(sql, [connus, vivants]);
          }
        }),
      );
    },
    applyRetention: (nbMax) =>
      enSerie(async () => {
        await brute.runAsync(APPLY_RETENTION, [nbMax]);
      }),
    async readCursor(portee, flux) {
      // Lecture : pas de file. Elle peut voir un lot non commis — sans
      // conséquence, les curseurs ne s'écrivent qu'après le retour du lot.
      const ligne = await brute.getFirstAsync<{ mis_a_jour_depuis: number }>(READ_CURSOR, [
        portee,
        flux,
      ]);
      return ligne?.mis_a_jour_depuis ?? null;
    },
    async lastMessageUpdatedAt(rid) {
      // Lecture directe (pas de file), comme `lireCurseur`. `MAX(...)` d'un
      // salon sans message local rend `NULL` → `null`.
      const ligne = await brute.getFirstAsync<{ mis_a_jour_le: number | null }>(
        LAST_MESSAGE_UPDATED_AT,
        [rid],
      );
      return ligne?.mis_a_jour_le ?? null;
    },
    writeCursor: (portee, flux, v) => enSerie(() => direct.writeCursor(portee, flux, v)),
    async listRoomKeys() {
      const lignes = await brute.getAllAsync<{ rid: string; e2e_key: string }>(LIST_ROOM_KEYS);
      return lignes.map((l) => ({ rid: l.rid, e2eKey: l.e2e_key }));
    },
    async messagesToDecrypt() {
      const lignes = await brute.getAllAsync<{ id: string; rid: string; chiffre_brut: string }>(
        MESSAGES_TO_DECRYPT,
      );
      return lignes.map((l) => ({ id: l.id, rid: l.rid, encryptedRaw: l.chiffre_brut }));
    },
    // La passe de déverrouillage écrit le clair : elle passe par la file, comme
    // toute écriture, pour ne pas s'intercaler dans une transaction ouverte.
    updateMessageText: (id, texte, piecesJointes) =>
      enSerie(async () => {
        await brute.runAsync(UPDATE_MESSAGE_TEXT, [texte, piecesJointes, id]);
      }),
    updateMessageMarks: (id, epingle, etoiles) =>
      enSerie(async () => {
        await brute.runAsync(UPDATE_MESSAGE_MARKS, [epingle ? 1 : 0, etoiles, id]);
      }),
    hideEncryptedMessages: () =>
      enSerie(async () => {
        await brute.runAsync(HIDE_ENCRYPTED_MESSAGES);
        await brute.runAsync(HIDE_ENCRYPTED_PREVIEW);
      }),
    updateEncryptedPreview: () =>
      enSerie(async () => {
        await brute.runAsync(UPDATE_ENCRYPTED_PREVIEW);
      }),
    // Versions d'avatar. L'etag est passé deux fois : le SQL ne touche la ligne
    // que s'il CHANGE (voir `MAJ_AVATAR_UTILISATEUR`).
    updateUserAvatar: (username, etag) =>
      enSerie(async () => {
        await brute.runAsync(UPDATE_USER_AVATAR, [etag, username, etag]);
      }),
    updateRoomAvatar: (rid, etag) =>
      enSerie(async () => {
        await brute.runAsync(UPDATE_ROOM_AVATAR, [etag, rid, etag]);
      }),
    saveIdentity: (identite) =>
      enSerie(async () => {
        await brute.runAsync(UPSERT_IDENTITY, identityParams(identite));
      }),
    transaction(fn) {
      // Un lot = un commit = UN rafraîchissement des requêtes vives,
      // au lieu d'une ré-exécution de chaque requête vive par ligne insérée.
      return enSerie(() => brute.withTransactionAsync(() => fn(direct)));
    },
  };
}

/**
 * Emojis custom : même connexion, même file que les autres dépôts (un `BEGIN`
 * concurrent hors file mourrait sur « no transaction is active »). Le
 * remplacement est un `DELETE`+`INSERT` sous UNE transaction — donc UN seul
 * rafraîchissement des requêtes vives, et pas de fenêtre où la table
 * est vide.
 */
export function createEmojiStore(brute: SQLiteDatabase, enSerie: WriteQueue): EmojiStore {
  return {
    replace(entrees: EmojiCustom[]) {
      return enSerie(() =>
        brute.withTransactionAsync(async () => {
          await brute.runAsync(CLEAR_CUSTOM_EMOJIS);
          for (const e of entrees) {
            await brute.runAsync(
              INSERT_CUSTOM_EMOJI,
              paramsEmojiCustom({ ...e, updatedAt: Date.now() }),
            );
          }
        }),
      );
    },
    async list(): Promise<EmojiCustom[]> {
      const lignes = await brute.getAllAsync<{ nom: string; extension: string; aliases: string }>(
        LIST_CUSTOM_EMOJIS,
      );
      return lignes.map((l) => ({
        name: l.nom,
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
    return filterAliases(JSON.parse(brut));
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

export function createOutboxStore(brute: SQLiteDatabase, enSerie: WriteQueue): OutboxStore {
  // Écritures dans la MÊME file que les lots de synchro : émises hors file
  // pendant un lot ouvert, elles rejoindraient sa transaction — un rollback
  // du lot emporterait alors le message que l'utilisateur vient d'envoyer.
  return {
    insertOutbox(id, rid, texte, filId) {
      return enSerie(() =>
        brute.runAsync(INSERT_OUTBOX, [id, rid, texte, filId, Date.now()]).then(() => {}),
      );
    },
    async listToSend(): Promise<OutboxRow[]> {
      const lignes = await brute.getAllAsync<BruteSortie>(LIST_OUTBOX_TO_SEND);
      return lignes.map((l) => ({
        id: l.id,
        rid: l.rid,
        text: l.texte,
        threadId: l.fil_id,
        status: l.statut,
        attempts: l.tentatives,
      }));
    },
    markFailed(id, erreur) {
      return enSerie(() => brute.runAsync(MARK_OUTBOX_FAILED, [erreur, id]).then(() => {}));
    },
    deleteOutbox(id) {
      return enSerie(() => brute.runAsync(DELETE_OUTBOX, [id]).then(() => {}));
    },
    upsertMessage(m) {
      return enSerie(() => brute.runAsync(UPSERT_MESSAGE, paramsMessage(m)).then(() => {}));
    },
    deleteOptimisticMessage(id) {
      return enSerie(() => brute.runAsync(DELETE_OPTIMISTIC_MESSAGE, [id]).then(() => {}));
    },
    async roomEncrypted(rid) {
      const ligne = await brute.getFirstAsync<{ chiffre: number }>(ROOM_ENCRYPTED, [rid]);
      return ligne?.chiffre === 1;
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

export function createUploadStore(
  brute: SQLiteDatabase,
  enSerie: WriteQueue,
): UploadStore {
  return {
    insert(ligne) {
      return enSerie(() =>
        brute
          .runAsync(INSERT_UPLOAD, [
            ligne.id,
            ligne.rid,
            ligne.uri,
            ligne.name,
            ligne.type,
            ligne.caption,
            Date.now(),
          ])
          .then(() => {}),
      );
    },
    async listToSend(): Promise<UploadRow[]> {
      const lignes = await brute.getAllAsync<BruteTeleversement>(LIST_UPLOADS_TO_SEND);
      return lignes.map((l) => ({
        id: l.id,
        rid: l.rid,
        uri: l.uri,
        name: l.nom,
        type: l.type,
        caption: l.legende,
        status: l.statut,
        fileId: l.file_id,
      }));
    },
    async claim(id) {
      // Hors `enSerie` : on a besoin du nombre de lignes touchées, et c'est LUI
      // qui dit si une autre passe nous a devancés.
      const r = await brute.runAsync(MARK_UPLOAD_IN_FLIGHT, [id]);
      return r.changes > 0;
    },
    rearmInFlight(enVolIci) {
      return enSerie(() =>
        brute.runAsync(REARM_IN_FLIGHT_UPLOADS, [JSON.stringify(enVolIci)]).then(() => {}),
      );
    },
    rearm(id) {
      return enSerie(() => brute.runAsync(REARM_UPLOAD, [id]).then(() => {}));
    },
    recordFileId(id, fileId) {
      return enSerie(() => brute.runAsync(RECORD_FILE_ID, [fileId, id]).then(() => {}));
    },
    async fileAlreadyPosted(rid, fileId) {
      const l = await brute.getFirstAsync<{ id: string }>(MESSAGE_WITH_FILE, [rid, fileId]);
      return l !== null;
    },
    markFailed(id, erreur) {
      return enSerie(() =>
        brute.runAsync(MARK_UPLOAD_FAILED, [erreur, id]).then(() => {}),
      );
    },
    delete(id) {
      return enSerie(() => brute.runAsync(DELETE_UPLOAD, [id]).then(() => {}));
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
export type DraftStore = {
  /** `null` si aucun brouillon pour cette clé. */
  read: (cle: string) => Promise<string | null>;
  write: (cle: string, texte: string) => Promise<void>;
  delete: (cle: string) => Promise<void>;
};

export function createDraftStore(
  brute: SQLiteDatabase,
  enSerie: WriteQueue,
): DraftStore {
  return {
    async read(cle) {
      const ligne = await brute.getFirstAsync<{ texte: string }>(READ_DRAFT, [cle]);
      return ligne?.texte ?? null;
    },
    write(cle, texte) {
      return enSerie(() =>
        brute.runAsync(UPSERT_DRAFT, [cle, texte, Date.now()]).then(() => {}),
      );
    },
    delete(cle) {
      return enSerie(() => brute.runAsync(DELETE_DRAFT, [cle]).then(() => {}));
    },
  };
}
