/**
 * Outbox and optimistic UI.
 *
 * The message `_id` is generated CLIENT-SIDE, 24 hex digits, BEFORE anything is
 * displayed: it is the key to everything. The message shows immediately (a
 * `messages` row with `updatedAt = 0`, which any server version overwrites),
 * the `outbox` queue persists the intent. A replay after a crash never creates
 * a duplicate: the server refuses it with a 400 on an already accepted `_id`,
 * and `chat.getMessage` decides between "already delivered" and "refused".
 *
 * Network unreachable (status 0): the message STAYS `en-attente`, the replay at
 * the next start or network return will carry it. Server refusal (4xx/5xx):
 * `echec`, actionable from the UI.
 *
 * Encrypted room: the text is encrypted when it leaves, never before; the
 * queue keeps the plaintext, as the database keeps decrypted messages. Without
 * a key (locked), the row waits for the unlock instead of failing.
 *
 * Pure: the database is behind `OutboxStore`, REST behind `ClientRest`, so
 * everything is testable under Node.
 */

import type { EncryptedContent } from './e2e/crypto.ts';
import { mentionsE2E } from './e2e/mentions.ts';
import { ENCRYPTED_TYPE, type MessageLocal } from './normalize.ts';
import { RestError, type ClientRest } from './rest.ts';

export type OutboxRow = {
  id: string;
  rid: string;
  text: string;
  threadId: string | null;
  status: 'en-attente' | 'echec';
  attempts: number;
};

export interface OutboxStore {
  insertOutbox(id: string, rid: string, text: string, threadId: string | null): Promise<void>;
  listToSend(): Promise<OutboxRow[]>;
  markFailed(id: string, error: string): Promise<void>;
  deleteOutbox(id: string): Promise<void>;
  upsertMessage(m: MessageLocal): Promise<void>;
  /** Deletes the message only if it is still optimistic (never delivered). */
  deleteOptimisticMessage(id: string): Promise<void>;
  roomEncrypted(rid: string): Promise<boolean>;
}

/** E2EE encryption of a payload, or `null` while it is impossible (locked, key missing). */
export interface OutboxEncryptor {
  encrypt(rid: string, payload: object): EncryptedContent | null;
}

/** 24 hex digits from 12 bytes: the Rocket.Chat `_id` format. */
export function idFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 12), (o) => o.toString(16).padStart(2, '0')).join('');
}

type SendResponse = { message?: Record<string, unknown> };

/** Verdict of `messageDelivered` when the question could not be asked. */
const UNKNOWN = Symbol('delivery unknown');

export class OutboxEngine {
  private readonly store: OutboxStore;
  private readonly client: ClientRest;
  private readonly me: { id: string; username: string };
  private readonly generateId: () => string;
  private readonly now: () => number;
  /** Reconciliation: the document returned by the server goes back through sync. */
  private readonly ingest: (doc: Record<string, unknown>) => Promise<void>;
  private readonly encryptor: OutboxEncryptor | null;
  private inFlight = false;

  constructor(options: {
    store: OutboxStore;
    client: ClientRest;
    me: { id: string; username: string };
    generateId: () => string;
    ingest: (doc: Record<string, unknown>) => Promise<void>;
    encryptor?: OutboxEncryptor | null;
    now?: () => number;
  }) {
    this.store = options.store;
    this.client = options.client;
    this.me = options.me;
    this.generateId = options.generateId;
    this.ingest = options.ingest;
    this.encryptor = options.encryptor ?? null;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Immediate display + persisted intent, THEN a send attempt. Returns the
   * generated `_id`. `threadId` (Rocket.Chat's `tmid`) makes this message a
   * thread reply. `localAttachments` (`attachments` JSON) exists only for the
   * optimistic DISPLAY, typically a quote: the server will rebuild the real
   * attachments from the text, and its version (real updatedAt) overwrites
   * this one. NOTHING of it goes over the network.
   */
  async send(
    rid: string,
    text: string,
    threadId: string | null = null,
    localAttachments: string | null = null,
  ): Promise<string> {
    const id = this.generateId();
    const when = this.now();
    await this.store.upsertMessage({
      id,
      rid,
      text,
      ts: when,
      authorId: this.me.id,
      authorName: this.me.username,
      systemType: (await this.store.roomEncrypted(rid)) ? ENCRYPTED_TYPE : null,
      threadId,
      threadCount: 0,
      threadLast: null,
      threadShown: false,
      editedAt: null,
      md: null,
      attachments: localAttachments,
      reactions: null,
      urls: null,
      callId: null,
      encryptedRaw: null,
      pinned: false,
      starred: null,
      // 0: the server version, whatever it is, overwrites the optimistic one,
      // and the optimistic one never overwrites a real state.
      updatedAt: 0,
    });
    await this.store.insertOutbox(id, rid, text, threadId);
    await this.process();
    return id;
  }

  private rerun = false;

  /**
   * Replays everything that is waiting, in order. Safely re-entrant: one pass
   * at a time, and a pass requested WHILE another runs is noted then run at
   * the end, otherwise a message sent during the flush would stay "⏳" until
   * the next trigger.
   */
  async process(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    this.inFlight = true;
    try {
      do {
        this.rerun = false;
        if (!(await this.runPass())) return;
      } while (this.rerun);
    } finally {
      this.inFlight = false;
    }
  }

  /** Returns `false` if the network is unreachable: no point insisting. */
  private async runPass(): Promise<boolean> {
    for (const row of await this.store.listToSend()) {
      const message = await this.messageBody(row);
      if (message === null) continue;
      try {
        const response = await this.client.post<SendResponse>('chat.sendMessage', {
          body: { message },
        });
        await this.store.deleteOutbox(row.id);
        if (response.message !== undefined) await this.ingest(response.message);
      } catch (e) {
        if (e instanceof RestError && e.status === 0) {
          // Unreachable: nothing to be done from here. The row stays as is,
          // the next `process()` will retry.
          return false;
        }
        // Replaying an already accepted `_id` is NOT idempotent server-side:
        // Rocket.Chat 8.5 answers 400 ("Cannot read properties of undefined
        // (reading 'starred')", checked). No duplicate is created, but the
        // response does not tell "already delivered" from "refused": ask the
        // server.
        const delivered = await this.messageDelivered(row.id);
        if (delivered === UNKNOWN) {
          // Could not decide. The row stays `en-attente`, so replayable, and
          // the pass stops: the following rows would burn the same quota for
          // the same verdict.
          return false;
        }
        if (delivered !== null) {
          // Ingest the fetched document: it is the real version (server ts),
          // and passing it through the store reconciles the outbox.
          await this.ingest(delivered);
          await this.store.deleteOutbox(row.id);
          continue;
        }
        // `derniere_erreur` is a DIAGNOSTIC (never displayed, the UI shows
        // `messageRow.failedRetry`): not a string to translate.
        const message = e instanceof Error ? e.message : 'Send refused.';
        await this.store.markFailed(row.id, message);
      }
    }
    return true;
  }

  /** The message as it leaves, or `null` if it must wait for a room key. */
  private async messageBody(row: OutboxRow): Promise<Record<string, unknown> | null> {
    const base = {
      _id: row.id,
      rid: row.rid,
      ...(row.threadId === null ? {} : { tmid: row.threadId }),
    };
    if (!(await this.store.roomEncrypted(row.rid))) return { ...base, msg: row.text };
    const content = this.encryptor?.encrypt(row.rid, { msg: row.text }) ?? null;
    if (content === null) return null;
    return { ...base, t: ENCRYPTED_TYPE, e2e: 'pending', content, e2eMentions: mentionsE2E(row.text) };
  }

  /** Discarding a final failure: the outbox row AND the optimistic message go. */
  async discard(id: string): Promise<void> {
    await this.store.deleteOutbox(id);
    await this.store.deleteOptimisticMessage(id);
  }

  /**
   * THREE verdicts, not two: the document if the server has it, `null` if it
   * says no, `UNKNOWN` if we COULD NOT ask.
   *
   * The distinction is not cosmetic. "I could not check" is not "the server
   * says no": folding everything into `null` marked `echec`, so displayed "not
   * sent", on a message the server may have accepted. The user types it again:
   * now there are two.
   */
  private async messageDelivered(
    id: string,
  ): Promise<Record<string, unknown> | typeof UNKNOWN | null> {
    try {
      const response = await this.client.get<{ message?: Record<string, unknown> }>(
        'chat.getMessage',
        { params: { msgId: id } },
      );
      const doc = response.message;
      return doc !== undefined && doc._id === id ? doc : null;
    } catch (e) {
      // Status 0: nobody answered. 429: `chat.getMessage` is under the same
      // 10/min limit as `chat.sendMessage` (CLAUDE.md), and a burst of sends
      // exhausts it: after `ClientRest`'s three retries, every check of the
      // pass falls back to 429. Neither is a denial from the server.
      if (e instanceof RestError && (e.status === 0 || e.status === 429)) return UNKNOWN;
      // The server spoke (404, permission denied, message missing): decide.
      return null;
    }
  }
}
