/**
 * Mattermost outbox. The server mints the post id (probed on 11.11: a client
 * `id` is refused with `app.post.save.existing.app_error`), so the optimistic
 * row keeps its client id and leaves under it as `pending_post_id`. The server
 * echoes that field and, replayed with the same value, returns the post it
 * already created instead of a duplicate. The real post is ingested from the
 * response, then the optimistic row is dropped.
 *
 * The echo is only a short-lived server cache, not stored: a replay much later
 * cannot rely on it. Before declaring a refusal, the newest posts of the room
 * are read for one of mine with the same text and thread.
 */

import type { LocalMessage } from '../../lib/normalize.ts';
import type { OutboxStore } from '../../lib/outbox.ts';
import type { Ingest, Outbox } from '../../lib/provider.ts';
import { MmError, type MmClient } from './client.ts';
import { ordered } from './history.ts';

const UNKNOWN = Symbol('delivery unknown');

/**
 * `<my user id>:<digits>`, the web client's format: kChat refuses any other with
 * 422 (probed). The digits are the client id's hex read as a number, so a replay
 * of the same row sends the same value and the server deduplicates it.
 */
export function pendingPostId(myId: string, clientId: string): string {
  const hex = clientId.toLowerCase().replace(/[^0-9a-f]/g, '');
  return `${myId}:${hex === '' ? '0' : BigInt(`0x${hex}`).toString()}`;
}
const CHECK_DEPTH = 30;

export class MmOutbox implements Outbox {
  private readonly store: OutboxStore;
  private readonly client: MmClient;
  private readonly me: { id: string; username: string };
  private readonly generateId: () => string;
  private readonly ingest: Ingest;
  private readonly now: () => number;
  private inFlight = false;
  private rerun = false;

  constructor(options: {
    store: OutboxStore;
    client: MmClient;
    me: { id: string; username: string };
    generateId: () => string;
    ingest: Ingest;
    now?: () => number;
  }) {
    this.store = options.store;
    this.client = options.client;
    this.me = options.me;
    this.generateId = options.generateId;
    this.ingest = options.ingest;
    this.now = options.now ?? (() => Date.now());
  }

  async send(rid: string, text: string, threadId: string | null = null, localAttachments: string | null = null): Promise<string> {
    const id = this.generateId();
    const optimistic: LocalMessage = {
      id,
      rid,
      text,
      ts: this.now(),
      authorId: this.me.id,
      authorName: this.me.username,
      systemType: null,
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
      updatedAt: 0,
    };
    await this.store.upsertMessage(optimistic);
    await this.store.insertOutbox(id, rid, text, threadId);
    await this.process();
    return id;
  }

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

  async discard(id: string): Promise<void> {
    await this.store.deleteOutbox(id);
    await this.store.deleteOptimisticMessage(id);
  }

  private async runPass(): Promise<boolean> {
    for (const row of await this.store.listToSend()) {
      try {
        const post = await this.client.post<Record<string, unknown>>('/posts', {
          body: { channel_id: row.rid, message: row.text, root_id: row.threadId ?? '', pending_post_id: pendingPostId(this.me.id, row.id) },
        });
        await this.delivered(row.id, post);
      } catch (e) {
        if (e instanceof MmError && e.status === 0) return false;
        const found = await this.findMine(row.rid, row.text, row.threadId);
        if (found === UNKNOWN) return false;
        if (found !== null) {
          await this.delivered(row.id, found);
          continue;
        }
        await this.store.markFailed(row.id, e instanceof Error ? e.message : 'Send refused.');
      }
    }
    return true;
  }

  private async delivered(localId: string, post: Record<string, unknown>): Promise<void> {
    await this.ingest(post);
    await this.store.deleteOutbox(localId);
    await this.store.deleteOptimisticMessage(localId);
  }

  private async findMine(
    rid: string,
    text: string,
    threadId: string | null,
  ): Promise<Record<string, unknown> | typeof UNKNOWN | null> {
    try {
      const list = await this.client.get<{ order?: string[]; posts?: Record<string, Record<string, unknown>> }>(
        `/channels/${rid}/posts`,
        { query: { per_page: CHECK_DEPTH } },
      );
      return (
        ordered(list).find(
          (p) => p.user_id === this.me.id && p.message === text && (p.root_id || null) === (threadId ?? null),
        ) ?? null
      );
    } catch (e) {
      if (e instanceof MmError && (e.status === 0 || e.status === 429)) return UNKNOWN;
      return null;
    }
  }
}
