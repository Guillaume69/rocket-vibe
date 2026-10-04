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

export function createStore(raw: SQLiteDatabase, serially: WriteQueue): Store {
  /**
   * Ce qu'un salon laisse derrière lui et que personne ne peut plus atteindre :
   * sa file d'envoi, sa file de téléversements, ses brouillons, ses curseurs.
   * Aucun écran ne lit ces lignes hors du salon ouvert — donc plus aucun
   * bouton « abandonner » — mais le rejeu, lui, les reprend à chaque
   * raccordement. Les messages, eux, restent à la charge de la
   * réconciliation, comme avant : c'est elle qui balaye les orphelins.
   */
  const clearSatellites = async (rid: string): Promise<void> => {
    await raw.runAsync(DELETE_ROOM_OUTBOX, [rid]);
    await raw.runAsync(DELETE_ROOM_UPLOADS, [rid]);
    await raw.runAsync(DELETE_ROOM_DRAFTS, [rid]);
    await raw.runAsync(DELETE_ROOM_CURSORS, [rid]);
  };

  // Les écritures DIRECTES, sans file : c'est ce que reçoit le `fn` d'une
  // transaction (la file attend la fin de la transaction ouverte — passer
  // par elle depuis `fn` s'interbloquerait, la signature de
  // `Depot.transaction` l'interdit).
  const direct: StoreWrites = {
    async upsertMessage(m) {
      await raw.runAsync(UPSERT_MESSAGE, paramsMessage(m));
      // L'identité de l'auteur (`uid → pseudo courant`) se dérive de chaque
      // message : le plus récent par uid fait foi. Un message chiffré
      // indéchiffrable n'a pas de pseudo (`auteurNom` null) — rien à noter.
      if (m.authorName !== null) {
        await raw.runAsync(
          UPSERT_USER,
          userParams({ uid: m.authorId, username: m.authorName, updatedAt: m.updatedAt }),
        );
      }
      // Réconciliation de la file d'envoi : ce dépôt ne reçoit QUE des
      // documents d'origine serveur (stream, historique, réponse d'envoi).
      // L'un d'eux qui porte notre `_id` prouve la livraison — la ligne de
      // sortie n'a plus de raison d'être, quel que soit son statut.
      await raw.runAsync(DELETE_OUTBOX, [m.id]);
    },
    async upsertRoom(s) {
      await raw.runAsync(UPSERT_ROOM, roomParams(s));
      // L'AUTRE d'un DM entre dans `utilisateurs` dès l'ingestion du salon, sans
      // attendre qu'un de ses messages soit chargé : la liste montre sa photo, et
      // le stream `updateAvatar` ne sait la rattacher qu'à une ligne existante
      // (il ne désigne l'utilisateur que par son pseudo). Sans cela, l'avatar
      // d'un DM jamais ouvert ne se rafraîchirait jamais.
      if (s.dmOtherUid !== null && s.dmOtherUsername !== null) {
        await raw.runAsync(
          UPSERT_IDENTITY,
          identityParams({ uid: s.dmOtherUid, username: s.dmOtherUsername, avatarEtag: null }),
        );
      }
    },
    async upsertSubscription(a) {
      await raw.runAsync(UPSERT_SUBSCRIPTION, subscriptionParams(a));
    },
    async deleteMessage(id) {
      await raw.runAsync(DELETE_MESSAGE, [id]);
      // L'aperçu de liste d'un salon CHIFFRÉ n'a pas de source serveur — le
      // stream ne porte que du ciphertext. Effacer le dernier message y
      // laisserait donc son texte en aperçu, indéfiniment. On le recalcule sur
      // les messages restants ; le SQL ne touche rien s'il n'a rien à changer,
      // et c'est un no-op sans salon chiffré. Les salons en clair, eux, sont
      // couverts par le `rooms-changed` qui suit toute suppression.
      await raw.runAsync(UPDATE_ENCRYPTED_PREVIEW);
    },
    async deleteRoom(rid) {
      await raw.runAsync(DELETE_ROOM, [rid]);
      await clearSatellites(rid);
    },
    async deleteSubscription(rid) {
      await raw.runAsync(DELETE_SUBSCRIPTION, [rid]);
    },
    async deleteBySubId(subId) {
      const row = await raw.getFirstAsync<{ rid: string }>(RID_BY_SUB_ID, [subId]);
      if (row === null) return;
      await raw.runAsync(DELETE_SUBSCRIPTION, [row.rid]);
      // Quitter un salon le fait disparaître de la liste — le document Rooms
      // existe toujours côté serveur, mais plus pour ce compte.
      await raw.runAsync(DELETE_ROOM, [row.rid]);
      await clearSatellites(row.rid);
    },
    async writeCursor(scope, stream, updatedSince) {
      await raw.runAsync(UPSERT_CURSOR, [scope, stream, updatedSince]);
    },
  };

  return {
    upsertMessage: (m) => serially(() => direct.upsertMessage(m)),
    upsertRoom: (s) => serially(() => direct.upsertRoom(s)),
    upsertSubscription: (a) => serially(() => direct.upsertSubscription(a)),
    deleteMessage: (id) => serially(() => direct.deleteMessage(id)),
    deleteRoom: (rid) => serially(() => direct.deleteRoom(rid)),
    deleteSubscription: (rid) => serially(() => direct.deleteSubscription(rid)),
    deleteBySubId: (subId) => serially(() => direct.deleteBySubId(subId)),
    async listKnownRids() {
      const rows = await raw.getAllAsync<{ rid: string }>(LIST_KNOWN_RIDS);
      return rows.map((l) => l.rid);
    },
    purgeMissingRooms(aliveRids, knownRids) {
      // Garde-fou : jamais de purge totale sur une liste vide (réponse serveur
      // muette ou tronquée). L'appelant garde aussi ce test — ceinture et
      // bretelles, car `NOT IN (rien)` effacerait tout ce qui est connu.
      if (aliveRids.length === 0 || knownRids.length === 0) return Promise.resolve();
      const alive = JSON.stringify(aliveRids);
      const known = JSON.stringify(knownRids);
      // Les sept DELETE en UNE transaction : un seul rafraîchissement
      // des requêtes vives, et pas de fenêtre où les tables sont incohérentes.
      return serially(() =>
        raw.withTransactionAsync(async () => {
          for (const sql of [
            PURGE_MISSING_ROOMS,
            PURGE_MISSING_SUBSCRIPTIONS,
            PURGE_MISSING_MESSAGES,
            PURGE_MISSING_OUTBOX,
            PURGE_MISSING_UPLOADS,
            PURGE_MISSING_DRAFTS,
            PURGE_MISSING_CURSORS,
          ]) {
            await raw.runAsync(sql, [known, alive]);
          }
        }),
      );
    },
    applyRetention: (nbMax) =>
      serially(async () => {
        await raw.runAsync(APPLY_RETENTION, [nbMax]);
      }),
    async readCursor(scope, stream) {
      // Lecture : pas de file. Elle peut voir un lot non commis — sans
      // conséquence, les curseurs ne s'écrivent qu'après le retour du lot.
      const row = await raw.getFirstAsync<{ mis_a_jour_depuis: number }>(READ_CURSOR, [
        scope,
        stream,
      ]);
      return row?.mis_a_jour_depuis ?? null;
    },
    async lastMessageUpdatedAt(rid) {
      // Lecture directe (pas de file), comme `lireCurseur`. `MAX(...)` d'un
      // salon sans message local rend `NULL` → `null`.
      const row = await raw.getFirstAsync<{ mis_a_jour_le: number | null }>(
        LAST_MESSAGE_UPDATED_AT,
        [rid],
      );
      return row?.mis_a_jour_le ?? null;
    },
    writeCursor: (scope, stream, v) => serially(() => direct.writeCursor(scope, stream, v)),
    async listRoomKeys() {
      const rows = await raw.getAllAsync<{ rid: string; e2e_key: string }>(LIST_ROOM_KEYS);
      return rows.map((l) => ({ rid: l.rid, e2eKey: l.e2e_key }));
    },
    async messagesToDecrypt() {
      const rows = await raw.getAllAsync<{ id: string; rid: string; chiffre_brut: string }>(
        MESSAGES_TO_DECRYPT,
      );
      return rows.map((l) => ({ id: l.id, rid: l.rid, encryptedRaw: l.chiffre_brut }));
    },
    // La passe de déverrouillage écrit le clair : elle passe par la file, comme
    // toute écriture, pour ne pas s'intercaler dans une transaction ouverte.
    updateMessageText: (id, text, attachments) =>
      serially(async () => {
        await raw.runAsync(UPDATE_MESSAGE_TEXT, [text, attachments, id]);
      }),
    updateMessageMarks: (id, pinned, starred) =>
      serially(async () => {
        await raw.runAsync(UPDATE_MESSAGE_MARKS, [pinned ? 1 : 0, starred, id]);
      }),
    hideEncryptedMessages: () =>
      serially(async () => {
        await raw.runAsync(HIDE_ENCRYPTED_MESSAGES);
        await raw.runAsync(HIDE_ENCRYPTED_PREVIEW);
      }),
    updateEncryptedPreview: () =>
      serially(async () => {
        await raw.runAsync(UPDATE_ENCRYPTED_PREVIEW);
      }),
    // Versions d'avatar. L'etag est passé deux fois : le SQL ne touche la ligne
    // que s'il CHANGE (voir `MAJ_AVATAR_UTILISATEUR`).
    updateUserAvatar: (username, etag) =>
      serially(async () => {
        await raw.runAsync(UPDATE_USER_AVATAR, [etag, username, etag]);
      }),
    updateRoomAvatar: (rid, etag) =>
      serially(async () => {
        await raw.runAsync(UPDATE_ROOM_AVATAR, [etag, rid, etag]);
      }),
    saveIdentity: (identity) =>
      serially(async () => {
        await raw.runAsync(UPSERT_IDENTITY, identityParams(identity));
      }),
    transaction(fn) {
      // Un lot = un commit = UN rafraîchissement des requêtes vives,
      // au lieu d'une ré-exécution de chaque requête vive par ligne insérée.
      return serially(() => raw.withTransactionAsync(() => fn(direct)));
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
export function createEmojiStore(raw: SQLiteDatabase, serially: WriteQueue): EmojiStore {
  return {
    replace(entries: EmojiCustom[]) {
      return serially(() =>
        raw.withTransactionAsync(async () => {
          await raw.runAsync(CLEAR_CUSTOM_EMOJIS);
          for (const e of entries) {
            await raw.runAsync(
              INSERT_CUSTOM_EMOJI,
              paramsEmojiCustom({ ...e, updatedAt: Date.now() }),
            );
          }
        }),
      );
    },
    async list(): Promise<EmojiCustom[]> {
      const rows = await raw.getAllAsync<{ nom: string; extension: string; aliases: string }>(
        LIST_CUSTOM_EMOJIS,
      );
      return rows.map((l) => ({
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

function parseAliases(raw: string): string[] {
  try {
    return filterAliases(JSON.parse(raw));
  } catch {
    return [];
  }
}

type RawOutbox = {
  id: string;
  rid: string;
  texte: string;
  fil_id: string | null;
  statut: 'en-attente' | 'echec';
  tentatives: number;
};

export function createOutboxStore(raw: SQLiteDatabase, serially: WriteQueue): OutboxStore {
  // Écritures dans la MÊME file que les lots de synchro : émises hors file
  // pendant un lot ouvert, elles rejoindraient sa transaction — un rollback
  // du lot emporterait alors le message que l'utilisateur vient d'envoyer.
  return {
    insertOutbox(id, rid, text, threadId) {
      return serially(() =>
        raw.runAsync(INSERT_OUTBOX, [id, rid, text, threadId, Date.now()]).then(() => {}),
      );
    },
    async listToSend(): Promise<OutboxRow[]> {
      const rows = await raw.getAllAsync<RawOutbox>(LIST_OUTBOX_TO_SEND);
      return rows.map((l) => ({
        id: l.id,
        rid: l.rid,
        text: l.texte,
        threadId: l.fil_id,
        status: l.statut,
        attempts: l.tentatives,
      }));
    },
    markFailed(id, error) {
      return serially(() => raw.runAsync(MARK_OUTBOX_FAILED, [error, id]).then(() => {}));
    },
    deleteOutbox(id) {
      return serially(() => raw.runAsync(DELETE_OUTBOX, [id]).then(() => {}));
    },
    upsertMessage(m) {
      return serially(() => raw.runAsync(UPSERT_MESSAGE, paramsMessage(m)).then(() => {}));
    },
    deleteOptimisticMessage(id) {
      return serially(() => raw.runAsync(DELETE_OPTIMISTIC_MESSAGE, [id]).then(() => {}));
    },
    async roomEncrypted(rid) {
      const row = await raw.getFirstAsync<{ chiffre: number }>(ROOM_ENCRYPTED, [rid]);
      return row?.chiffre === 1;
    },
  };
}

/** Le SQL rend `file_id` en snake — la remise en `fileId` est explicite, ci-dessous. */
type RawUpload = {
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
  raw: SQLiteDatabase,
  serially: WriteQueue,
): UploadStore {
  return {
    insert(row) {
      return serially(() =>
        raw
          .runAsync(INSERT_UPLOAD, [
            row.id,
            row.rid,
            row.uri,
            row.name,
            row.type,
            row.caption,
            Date.now(),
          ])
          .then(() => {}),
      );
    },
    async listToSend(): Promise<UploadRow[]> {
      const rows = await raw.getAllAsync<RawUpload>(LIST_UPLOADS_TO_SEND);
      return rows.map((l) => ({
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
      const r = await raw.runAsync(MARK_UPLOAD_IN_FLIGHT, [id]);
      return r.changes > 0;
    },
    rearmInFlight(inFlightHere) {
      return serially(() =>
        raw.runAsync(REARM_IN_FLIGHT_UPLOADS, [JSON.stringify(inFlightHere)]).then(() => {}),
      );
    },
    rearm(id) {
      return serially(() => raw.runAsync(REARM_UPLOAD, [id]).then(() => {}));
    },
    recordFileId(id, fileId) {
      return serially(() => raw.runAsync(RECORD_FILE_ID, [fileId, id]).then(() => {}));
    },
    async fileAlreadyPosted(rid, fileId) {
      const l = await raw.getFirstAsync<{ id: string }>(MESSAGE_WITH_FILE, [rid, fileId]);
      return l !== null;
    },
    markFailed(id, error) {
      return serially(() =>
        raw.runAsync(MARK_UPLOAD_FAILED, [error, id]).then(() => {}),
      );
    },
    delete(id) {
      return serially(() => raw.runAsync(DELETE_UPLOAD, [id]).then(() => {}));
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
  read: (key: string) => Promise<string | null>;
  write: (key: string, text: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

export function createDraftStore(
  raw: SQLiteDatabase,
  serially: WriteQueue,
): DraftStore {
  return {
    async read(key) {
      const row = await raw.getFirstAsync<{ texte: string }>(READ_DRAFT, [key]);
      return row?.texte ?? null;
    },
    write(key, text) {
      return serially(() =>
        raw.runAsync(UPSERT_DRAFT, [key, text, Date.now()]).then(() => {}),
      );
    },
    delete(key) {
      return serially(() => raw.runAsync(DELETE_DRAFT, [key]).then(() => {}));
    },
  };
}
