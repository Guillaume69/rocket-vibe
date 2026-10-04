/**
 * Sync engine. The WebSocket and REST **both write into
 * SQLite**; the UI observes the database. Nothing flows from the UI to the network here.
 *
 * Pure: the database sits behind the `Store` interface, so this module is tested without
 * `expo-sqlite`.
 */

import type { DdpEvent } from './ddp.ts';
import type { SyncChange, Translator } from './provider.ts';
import type { LocalSubscription, MessageLocal, LocalRoom } from './normalize.ts';

/**
 * What sync expects from the E2EE engine, structurally (no import of
 * `lib/e2e`, so no cycle): `E2EEngine` conforms to it. SYNCHRONOUS
 * decryption (forge is) that can be plugged in along ingestion.
 */
export interface E2EDecryptor {
  decryptContent(
    rid: string,
    content: { algorithm: string; ciphertext: string; kid?: string; iv?: string },
  ): { text: string; attachments: string | null } | null;
  saveRoomKey(rid: string, e2eKey: string | null): void;
}

export interface Store {
  upsertMessage(m: MessageLocal): Promise<void>;
  upsertRoom(s: LocalRoom): Promise<void>;
  upsertSubscription(a: LocalSubscription): Promise<void>;
  deleteMessage(id: string): Promise<void>;
  deleteRoom(rid: string): Promise<void>;
  deleteSubscription(rid: string): Promise<void>;
  /**
   * A room departure reported by the catch-up: subscription `remove[]` entries
   * only carry the subscription `_id`. Deletes the subscription AND the room.
   */
  deleteBySubId(subId: string): Promise<void>;
  /**
   * Every `rid` the database knows, across all tables. To be read
   * BEFORE the reconciliation network request: this snapshot bounds
   * the purge, and so spares a room created while the request was in flight.
   */
  listKnownRids(): Promise<string[]>;
  /**
   * Anti-ghost reconciliation: deletes everything whose `rid` was in
   * the `knownRids` snapshot and is NOT in the live list. Cleans up
   * rooms deleted server-side whose 'removed' event was missed:
   * room, subscription, messages, but also outboxes, drafts and
   * cursors. Does NOTHING on an empty list (guard against a total purge).
   */
  purgeMissingRooms(aliveRids: string[], knownRids: string[]): Promise<void>;
  /**
   * Retention: keep only the `nbMax` most recent messages of EACH
   * room, sparing optimistic ones and referenced thread roots.
   */
  applyRetention(nbMax: number): Promise<void>;
  /** Catch-up cursors. `readCursor` returns null if never written. */
  readCursor(scope: string, stream: string): Promise<number | null>;
  /** Never moves backwards (guaranteed by the SQL). */
  writeCursor(scope: string, stream: string, updatedSince: number): Promise<void>;
  /**
   * The largest `_updatedAt` already ingested for a room (null if no local
   * message). Used to re-anchor the cursor when `chat.syncMessages` fails on a
   * backlog that is too big: see `catchUpRoom`.
   */
  lastMessageUpdatedAt(rid: string): Promise<number | null>;
  /** Known room keys (E2EKey of subscriptions), for the E2EE pass. */
  listRoomKeys(): Promise<{ rid: string; e2eKey: string }[]>;
  /** Encrypted messages still unreadable (`encryptedRaw` present, `text` null). */
  messagesToDecrypt(): Promise<{ id: string; rid: string; encryptedRaw: string }[]>;
  /** Sets a message's plaintext (and its attachments) after decryption at unlock. */
  updateMessageText(id: string, text: string, attachments: string | null): Promise<void>;
  /** Pinning and stars set locally after a successful gesture (`lib/marks.ts`). */
  updateMessageMarks(id: string, pinned: boolean, starred: string | null): Promise<void>;
  /**
   * Sets the avatar version (`avatarETag`) of a user, designated by their
   * USERNAME: it is the only key the stream carries. No effect on a username
   * unknown locally.
   */
  updateUserAvatar(username: string, etag: string): Promise<void>;
  /** Same for a room, designated by its `rid`. */
  updateRoomAvatar(rid: string, etag: string): Promise<void>;
  /**
   * Authoritative identity (`me`, `users.info`): current username and avatar
   * version of a uid. It is the only path that can CREATE the row of a
   * user who has not posted any message yet: my own account, most
   * often.
   */
  saveIdentity(identity: {
    uid: string;
    username: string;
    avatarEtag: string | null;
  }): Promise<void>;
  /** Re-masks the plaintext of every encrypted message (on lock). */
  hideEncryptedMessages(): Promise<void>;
  /** Refreshes the list preview of encrypted rooms (last decrypted message). */
  updateEncryptedPreview(): Promise<void>;
  /**
   * Groups writes into one transaction. A history page of 50
   * messages must produce ONE commit and ONE change event, not 50
   * re-runs of each live UI query.
   *
   * `fn` receives the writer TO USE for its writes: on SQLite, the
   * store's own methods go through a queue that waits for the open
   * transaction to end, so calling them from `fn` would deadlock. The
   * signature makes the mistake impossible to write.
   */
  transaction(fn: (tx: StoreWrites) => Promise<void>): Promise<void>;
}

/** The subset of writes usable inside a transaction. */
export type StoreWrites = Pick<
  Store,
  | 'upsertMessage'
  | 'upsertRoom'
  | 'upsertSubscription'
  | 'deleteMessage'
  | 'deleteRoom'
  | 'deleteSubscription'
  | 'deleteBySubId'
  | 'writeCursor'
>;

export const STREAM_MESSAGES = 'stream-room-messages';
export const STREAM_NOTIFY_USER = 'stream-notify-user';
export const STREAM_NOTIFY_ROOM = 'stream-notify-room';

/** Counters shown on the debug screen: what was seen, what was ignored. */
export type Stats = {
  messages: number;
  rooms: number;
  subscriptions: number;
  deletions: number;
  ignores: number;
};

export class SyncEngine {
  readonly stats: Stats = {
    messages: 0,
    rooms: 0,
    subscriptions: 0,
    deletions: 0,
    ignores: 0,
  };

  // Plain fields, not "parameter properties": the latter are not
  // erasable syntax, and would prevent loading the module under
  // Node, and so testing it.
  private readonly store: Store;
  /** Decodes the server's `DdpEvent`s and raw documents: all the RC quirks live there. */
  private readonly translator: Translator;
  /** E2EE decryptor, or `null`: an encrypted message then stays on the placeholder. */
  private decryptor: E2EDecryptor | null;

  constructor(store: Store, translator: Translator, decryptor: E2EDecryptor | null = null) {
    this.store = store;
    this.translator = translator;
    this.decryptor = decryptor;
  }

  /**
   * Decryption pass at E2EE unlock: loads every known room key
   * into the decryptor, then decrypts the messages left
   * unreadable (ingested while locked). Returns the number of messages made readable.
   * Idempotent: a message already in plaintext is no longer in `messagesToDecrypt`.
   */
  async e2eUnlocked(): Promise<number> {
    if (this.decryptor === null) return 0;
    for (const { rid, e2eKey } of await this.store.listRoomKeys()) {
      this.decryptor.saveRoomKey(rid, e2eKey);
    }
    let n = 0;
    for (const m of await this.store.messagesToDecrypt()) {
      let content: { algorithm: string; ciphertext: string; kid?: string; iv?: string };
      try {
        content = JSON.parse(m.encryptedRaw);
      } catch {
        continue;
      }
      const plain = this.decryptor.decryptContent(m.rid, content);
      if (plain !== null) {
        await this.store.updateMessageText(m.id, plain.text, plain.attachments);
        n++;
      }
    }
    // ALWAYS refreshes the list preview: on resume (key already in the
    // Keystore), messages are already in plaintext → `n` is 0, but the preview
    // still has to be set from these messages decrypted in a past session.
    await this.store.updateEncryptedPreview();
    return n;
  }

  /** Lock: clears the local plaintext of encrypted messages (placeholder again). */
  async e2eRelocked(): Promise<void> {
    await this.store.hideEncryptedMessages();
  }

  /**
   * Decrypts in place the `text` of an encrypted message, if we have the key. Without
   * a key (locked, room not unlocked yet): `text` stays null, the kept
   * `encryptedRaw` will allow a pass at unlock.
   */
  private decrypt(message: MessageLocal): void {
    if (message.encryptedRaw === null || this.decryptor === null) return;
    let content: { algorithm: string; ciphertext: string; kid?: string; iv?: string };
    try {
      content = JSON.parse(message.encryptedRaw);
    } catch {
      return;
    }
    const plain = this.decryptor.decryptContent(message.rid, content);
    if (plain === null) return;
    message.text = plain.text;
    if (plain.attachments !== null) message.attachments = plain.attachments;
  }

  /**
   * Applies a real-time event. The provider's translator decodes it;
   * the engine only writes neutral shapes. An anomaly (unexpected
   * stream) is **counted, never hidden**; an expected `silence`
   * (`user-activity`) does not count.
   */
  async apply(event: DdpEvent): Promise<void> {
    const translation = this.translator.translateEvent(event);
    if (translation.kind === 'silence') return;
    if (translation.kind === 'ignore') {
      this.stats.ignores++;
      return;
    }
    await this.applyChange(translation.change);
  }

  /** Writes an already normalized change into the store. The only write path. */
  private async applyChange(change: SyncChange): Promise<void> {
    switch (change.type) {
      case 'message':
        this.decrypt(change.doc);
        await this.store.upsertMessage(change.doc);
        this.stats.messages++;
        // An encrypted message decrypted live refreshes the list preview.
        if (change.doc.encryptedRaw !== null && change.doc.text !== null) {
          await this.store.updateEncryptedPreview();
        }
        return;
      case 'room':
        await this.store.upsertRoom(change.doc);
        this.stats.rooms++;
        return;
      case 'subscription':
        this.decryptor?.saveRoomKey(change.doc.rid, change.doc.e2eKey);
        await this.store.upsertSubscription(change.doc);
        this.stats.subscriptions++;
        return;
      case 'message-deleted':
        await this.store.deleteMessage(change.id);
        this.stats.deletions++;
        return;
      case 'room-deleted':
        await this.store.deleteRoom(change.rid);
        this.stats.deletions++;
        return;
      case 'subscription-deleted-by-sub':
        await this.store.deleteBySubId(change.subId);
        this.stats.deletions++;
        return;
      case 'avatar':
        // Neither counted nor ignored: it is not a document, just the version
        // of a photo. A target with neither username NOR rid does not exist server-side.
        if (change.username !== null) {
          await this.store.updateUserAvatar(change.username, change.etag);
        }
        if (change.rid !== null) {
          await this.store.updateRoomAvatar(change.rid, change.etag);
        }
        return;
    }
  }

  /**
   * Ingestion of a REST batch: same upserts, same idempotence guarantees,
   * but in a single transaction: see `Store.transaction`.
   *
   * Returns the largest ingested `_updatedAt` (or null): it is what the
   * catch-up cursors are made of; a cursor built on the local clock would lie.
   */
  async ingestMessages(rawItems: Record<string, unknown>[]): Promise<number | null> {
    let latest: number | null = null;
    await this.store.transaction(async (tx) => {
      for (const raw of rawItems) {
        const message = this.translator.toMessage(raw);
        if (message === null) {
          this.stats.ignores++;
          continue;
        }
        this.decrypt(message);
        await tx.upsertMessage(message);
        this.stats.messages++;
        if (latest === null || message.updatedAt > latest) {
          latest = message.updatedAt;
        }
      }
    });
    return latest;
  }

  async ingestRooms(rawItems: Record<string, unknown>[]): Promise<number | null> {
    let latest: number | null = null;
    await this.store.transaction(async (tx) => {
      for (const raw of rawItems) {
        const room = this.translator.toRoom(raw);
        if (room === null) {
          this.stats.ignores++;
          continue;
        }
        await tx.upsertRoom(room);
        this.stats.rooms++;
        if (latest === null || room.updatedAt > latest) {
          latest = room.updatedAt;
        }
      }
    });
    return latest;
  }

  async ingestSubscriptions(rawItems: Record<string, unknown>[]): Promise<number | null> {
    let latest: number | null = null;
    await this.store.transaction(async (tx) => {
      for (const raw of rawItems) {
        const subscription = this.translator.toSubscription(raw);
        if (subscription === null) {
          this.stats.ignores++;
          continue;
        }
        this.decryptor?.saveRoomKey(subscription.rid, subscription.e2eKey);
        await tx.upsertSubscription(subscription);
        this.stats.subscriptions++;
        if (latest === null || subscription.updatedAt > latest) {
          latest = subscription.updatedAt;
        }
      }
    });
    return latest;
  }

  /** Store access for the catch-up (cursors, deletions). */
  get syncStore(): Store {
    return this.store;
  }
}
