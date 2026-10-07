/**
 * `Store` implementation on `expo-sqlite`.
 *
 * We go through `runAsync` with the SQL and parameter builders of
 * `db/upserts.ts` rather than Drizzle's query builder: it is **exactly** what
 * the tests run on `node:sqlite`. An `onConflictDoUpdate` rebuilt here could
 * drift from the tested SQL without anything flagging it.
 *
 * Writes go through the connection opened with `enableChangeListener`, so
 * `useCoalescedLiveQuery` sees them: the UI refreshes without being told.
 */

import type { SQLiteDatabase } from 'expo-sqlite';

import { filterAliases, type EmojiStore, type CustomEmoji } from '../lib/customEmojis.ts';
import type { OutboxStore, OutboxRow } from '../lib/outbox.ts';
import type { UploadStore, UploadRow } from '../lib/uploadQueue.ts';
import type { Store, StoreWrites } from '../lib/sync.ts';
import { KEPT_CODES, normalizeEmojiCode, type EmojiUse } from '../lib/emojiUsage.ts';
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
  customEmojiParams,
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
  messageParams,
  roomParams,
  userParams,
  RECORD_EMOJI_USE,
  PRUNE_EMOJI_USAGE,
  LIST_EMOJI_USAGE,
} from './upserts.ts';

/** The retention quota, per room. See `APPLY_RETENTION`. */
export const MESSAGES_KEPT_PER_ROOM = 500;

export function createStore(raw: SQLiteDatabase, serially: WriteQueue): Store {
  /**
   * What a room leaves behind that nobody can reach anymore: its outbox, its
   * upload queue, its drafts, its cursors. No screen reads these rows outside
   * the open room, so no "discard" button either, but the replay picks them up
   * at every connection setup. Messages stay the reconciliation's job, as
   * before: it sweeps the orphans.
   */
  const clearSatellites = async (rid: string): Promise<void> => {
    await raw.runAsync(DELETE_ROOM_OUTBOX, [rid]);
    await raw.runAsync(DELETE_ROOM_UPLOADS, [rid]);
    await raw.runAsync(DELETE_ROOM_DRAFTS, [rid]);
    await raw.runAsync(DELETE_ROOM_CURSORS, [rid]);
  };

  // DIRECT writes, without the queue: this is what a transaction's `fn`
  // receives (the queue waits for the open transaction to end; going through
  // it from `fn` would deadlock, the signature of `Store.transaction` forbids
  // it).
  const direct: StoreWrites = {
    async upsertMessage(m) {
      await raw.runAsync(UPSERT_MESSAGE, messageParams(m));
      // The author's identity (`uid -> current username`) derives from each
      // message: the most recent per uid wins. An undecryptable encrypted message
      // has no username (`authorName` null): nothing to record.
      if (m.authorName !== null) {
        await raw.runAsync(
          UPSERT_USER,
          userParams({ uid: m.authorId, username: m.authorName, updatedAt: m.updatedAt }),
        );
      }
      // Outbox reconciliation: this store receives ONLY server-origin documents
      // (stream, history, send response). One of them carrying our `_id` proves
      // delivery: the outbox row has no reason to exist anymore, whatever its
      // status.
      await raw.runAsync(DELETE_OUTBOX, [m.id]);
    },
    async upsertRoom(s) {
      await raw.runAsync(UPSERT_ROOM, roomParams(s));
      // The OTHER party of a DM enters `users` as soon as the room is ingested,
      // without waiting for one of their messages to load: the list shows their
      // photo, and the `updateAvatar` stream can only attach it to an existing row
      // (it only names the user by username). Without this, the avatar of a DM
      // never opened would never refresh.
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
      // The list preview of an ENCRYPTED room has no server source: the stream only
      // carries ciphertext. Deleting the last message would therefore leave its text
      // as the preview, indefinitely. We recompute it from the remaining messages;
      // the SQL touches nothing if it has nothing to change, and it is a no-op
      // without an encrypted room. Plaintext rooms are covered by the
      // `rooms-changed` that follows any deletion.
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
      // Leaving a room makes it vanish from the list: the Rooms document still
      // exists server-side, but no longer for this account.
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
      // Safeguard: never a full purge on an empty list (mute or truncated server
      // response). The caller also keeps this test, belt and braces, because
      // `NOT IN (nothing)` would erase everything known.
      if (aliveRids.length === 0 || knownRids.length === 0) return Promise.resolve();
      const alive = JSON.stringify(aliveRids);
      const known = JSON.stringify(knownRids);
      // The seven DELETEs in ONE transaction: a single refresh of the live
      // queries, and no window where the tables are inconsistent.
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
      // Read: no queue. It may see an uncommitted batch, without consequence:
      // cursors are only written after the batch returns.
      const row = await raw.getFirstAsync<{ updated_since: number }>(READ_CURSOR, [
        scope,
        stream,
      ]);
      return row?.updated_since ?? null;
    },
    async lastMessageUpdatedAt(rid) {
      // Direct read (no queue), like `readCursor`. `MAX(...)` of a room with no
      // local message returns `NULL` -> `null`.
      const row = await raw.getFirstAsync<{ updated_at: number | null }>(
        LAST_MESSAGE_UPDATED_AT,
        [rid],
      );
      return row?.updated_at ?? null;
    },
    writeCursor: (scope, stream, v) => serially(() => direct.writeCursor(scope, stream, v)),
    async listRoomKeys() {
      const rows = await raw.getAllAsync<{ rid: string; e2e_key: string }>(LIST_ROOM_KEYS);
      return rows.map((l) => ({ rid: l.rid, e2eKey: l.e2e_key }));
    },
    async messagesToDecrypt() {
      const rows = await raw.getAllAsync<{ id: string; rid: string; encrypted_raw: string }>(
        MESSAGES_TO_DECRYPT,
      );
      return rows.map((l) => ({ id: l.id, rid: l.rid, encryptedRaw: l.encrypted_raw }));
    },
    // The unlock pass writes the plaintext: it goes through the queue, like any
    // write, so as not to slip into an open transaction.
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
    // Avatar versions. The etag is passed twice: the SQL only touches the row
    // if it CHANGES (see `UPDATE_USER_AVATAR`).
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
      // One batch = one commit = ONE refresh of the live queries,
      // instead of rerunning every live query for each inserted row.
      return serially(() => raw.withTransactionAsync(() => fn(direct)));
    },
  };
}

/**
 * Custom emojis: same connection, same queue as the other stores (a
 * concurrent `BEGIN` outside the queue would die on "no transaction is
 * active"). The replacement is a `DELETE`+`INSERT` under ONE transaction,
 * hence ONE refresh of the live queries, and no window where the table is
 * empty.
 */
export function createEmojiStore(raw: SQLiteDatabase, serially: WriteQueue): EmojiStore {
  return {
    replace(entries: CustomEmoji[]) {
      return serially(() =>
        raw.withTransactionAsync(async () => {
          await raw.runAsync(CLEAR_CUSTOM_EMOJIS);
          for (const e of entries) {
            await raw.runAsync(
              INSERT_CUSTOM_EMOJI,
              customEmojiParams({ ...e, updatedAt: Date.now() }),
            );
          }
        }),
      );
    },
    async list(): Promise<CustomEmoji[]> {
      const rows = await raw.getAllAsync<{ name: string; extension: string; aliases: string }>(
        LIST_CUSTOM_EMOJIS,
      );
      return rows.map((l) => ({
        name: l.name,
        extension: l.extension,
        // `aliases` is JSON written by us; a `catch` keeps one corrupt row from
        // depriving the whole room of its other emojis. The same filter
        // (`filterAliases`) as at network ingestion, once the JSON is parsed.
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
  text: string;
  thread_id: string | null;
  status: 'pending' | 'failed';
  attempts: number;
};

export function createOutboxStore(raw: SQLiteDatabase, serially: WriteQueue): OutboxStore {
  // Writes in the SAME queue as the sync batches: issued outside the queue
  // during an open batch, they would join its transaction, and a rollback of
  // the batch would then take away the message the user just sent.
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
        text: l.text,
        threadId: l.thread_id,
        status: l.status,
        attempts: l.attempts,
      }));
    },
    markFailed(id, error) {
      return serially(() => raw.runAsync(MARK_OUTBOX_FAILED, [error, id]).then(() => {}));
    },
    deleteOutbox(id) {
      return serially(() => raw.runAsync(DELETE_OUTBOX, [id]).then(() => {}));
    },
    upsertMessage(m) {
      return serially(() => raw.runAsync(UPSERT_MESSAGE, messageParams(m)).then(() => {}));
    },
    deleteOptimisticMessage(id) {
      return serially(() => raw.runAsync(DELETE_OPTIMISTIC_MESSAGE, [id]).then(() => {}));
    },
    async roomEncrypted(rid) {
      const row = await raw.getFirstAsync<{ encrypted: number }>(ROOM_ENCRYPTED, [rid]);
      return row?.encrypted === 1;
    },
  };
}

/** The SQL returns `file_id` in snake case; mapping it to `fileId` is explicit, below. */
type RawUpload = {
  id: string;
  rid: string;
  uri: string;
  name: string;
  type: string;
  caption: string | null;
  tmid: string | null;
  status: 'pending' | 'sending' | 'failed';
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
            row.tmid,
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
        name: l.name,
        type: l.type,
        caption: l.caption,
        tmid: l.tmid,
        status: l.status,
        fileId: l.file_id,
      }));
    },
    async claim(id) {
      // Outside `serially`: we need the number of rows touched, and IT tells
      // whether another pass got ahead of us.
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
 * Composer drafts. Until now they wrote directly on the shared connection,
 * outside the queue, the only write path of the store to do so. The 400 ms
 * debounce firing during the ingestion of a 50-message page made the INSERT
 * enter the batch's `BEGIN` (`withTransactionAsync` is not exclusive), and a
 * failed batch silently rolled back the draft.
 */
export type DraftStore = {
  /** `null` if there is no draft for this key. */
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
      const row = await raw.getFirstAsync<{ text: string }>(READ_DRAFT, [key]);
      return row?.text ?? null;
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

/**
 * The emoji I react with (`lib/emojiUsage.ts`), per account since it lives in
 * the account's database. Written through the queue like the drafts; a code
 * that is not a shortcode is ignored, and each use prunes the table back to
 * `KEPT_CODES` rows in the same job.
 */
export type EmojiUsageStore = {
  read: () => Promise<EmojiUse[]>;
  record: (code: string) => Promise<void>;
};

export function createEmojiUsageStore(
  raw: SQLiteDatabase,
  serially: WriteQueue,
): EmojiUsageStore {
  return {
    read() {
      return raw.getAllAsync<EmojiUse>(LIST_EMOJI_USAGE);
    },
    record(input) {
      const code = normalizeEmojiCode(input);
      if (code === null) return Promise.resolve();
      return serially(async () => {
        await raw.runAsync(RECORD_EMOJI_USE, [code, Date.now()]);
        await raw.runAsync(PRUNE_EMOJI_USAGE, [KEPT_CODES]);
      });
    },
  };
}
