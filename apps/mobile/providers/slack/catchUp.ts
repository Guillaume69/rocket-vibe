/**
 * REST catch-up. The global pass rebuilds the rooms and their badges from the
 * joined roster (`users.conversations`, every page) and `client.counts`, an
 * internal method that may fail: the badges then stay as they were, and a
 * room never counted shows none. Slack carries no last-message text on a
 * conversation: the newest message of the most recently active rooms is read
 * for the list's preview, a few at a time.
 *
 * A room's pass reads forward from its newest exact `ts`. Slack has no
 * "changed since" read: edits and deletions of older messages wait for the
 * live stream.
 */

import type { SyncEngine } from '../../lib/sync.ts';
import type { SlackClient } from './client.ts';
import { isTimestamp, oldestOfMs, timestampMs } from './client.ts';
import type { SlackDirectory } from './directory.ts';
import type { SlackHistory } from './history.ts';
import type { SlackLive } from './live.ts';
import type { SlackRoomDoc, SlackSubscriptionDoc } from './translator.ts';

type Doc = Record<string, unknown>;

const ROSTER = { types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 200 } as const;
const COUNT_LISTS = ['channels', 'mpims', 'ims'] as const;
const PREVIEWS = 40;
const PREVIEW_CONCURRENCY = 2;
/** People of direct conversations named before the list is written; the others follow. */
const NAMED_FIRST = 100;
const CATCH_UP_PAGE = 200;
const CATCH_UP_PAGES = 5;

export class SlackCatchUp {
  private readonly client: SlackClient;
  private readonly directory: SlackDirectory;
  private readonly history: SlackHistory;
  private readonly roomNames: Map<string, string>;
  private readonly live: SlackLive | null;
  private readonly myId: string;
  private readonly running = new Map<string, Promise<void>>();

  constructor(options: { client: SlackClient; directory: SlackDirectory; history: SlackHistory; roomNames: Map<string, string>; myId: string; live?: SlackLive | null }) {
    this.client = options.client;
    this.directory = options.directory;
    this.history = options.history;
    this.roomNames = options.roomNames;
    this.live = options.live ?? null;
    this.myId = options.myId;
  }

  roster(): Promise<Doc[]> {
    return this.client.pages('users.conversations', ROSTER, 'channels');
  }

  /** `client.counts` by conversation id; null when Slack does not answer it. */
  async counts(): Promise<Map<string, Doc> | null> {
    const out = new Map<string, Doc>();
    try {
      const body = await this.client.call('client.counts');
      for (const list of COUNT_LISTS) {
        const entries = body[list];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (typeof entry === 'object' && entry !== null && typeof (entry as Doc).id === 'string') out.set((entry as Doc).id as string, entry as Doc);
        }
      }
    } catch {
      return null;
    }
    return out;
  }

  async global(engine: SyncEngine, isDiscarded: () => boolean): Promise<void> {
    const [channels, read] = await Promise.all([this.roster(), this.counts()]);
    if (isDiscarded()) return;
    const counts = read ?? new Map(channels.flatMap((c) => {
      const kept = this.live?.counts.get(String(c.id));
      return kept === undefined ? [] : [[String(c.id), kept] as const];
    }));
    const known = read === null ? new Set(await engine.syncStore.listKnownRids()) : null;
    if (isDiscarded()) return;
    for (const c of channels) if (typeof c.id === 'string' && typeof c.name === 'string' && c.is_im !== true) this.roomNames.set(c.id, c.name);
    if (this.live !== null) for (const c of channels) if (typeof c.id === 'string') this.live.remember(c, counts.get(String(c.id)) ?? null);
    const recent = [...channels].sort((a, b) => latest(counts.get(String(b.id))) - latest(counts.get(String(a.id))));
    const people = recent.flatMap((c) => (c.is_im === true && typeof c.user === 'string' ? [c.user] : []));
    await this.directory.ensure([this.myId, ...people.slice(0, NAMED_FIRST)]);
    const previews = await this.previews(recent.slice(0, PREVIEWS).map((c) => String(c.id)));
    if (isDiscarded()) return;
    if (this.live !== null) {
      for (const [rid, message] of previews) {
        if (message !== null && isTimestamp(message.ts)) this.live.previews.set(rid, message.ts);
        else this.live.previews.delete(rid);
      }
    }

    const rooms: SlackRoomDoc[] = channels.map((channel) => {
      const rid = String(channel.id);
      return { channel, counts: counts.get(rid) ?? null, ...(previews.has(rid) ? { lastMessage: previews.get(rid) ?? null } : {}) };
    });
    await engine.ingestRooms(rooms as unknown as Doc[]);
    // Without counts, a room already listed keeps its badge; a new one still needs its row.
    const subscriptions: SlackSubscriptionDoc[] = channels
      .filter((channel) => known === null || counts.has(String(channel.id)) || !known.has(String(channel.id)))
      .map((channel) => ({ channel, counts: counts.get(String(channel.id)) ?? null }));
    await engine.ingestSubscriptions(subscriptions as unknown as Doc[]);

    const later = people.slice(NAMED_FIRST);
    if (later.length === 0) return;
    void this.directory.ensure(later).then(async () => {
      if (isDiscarded()) return;
      const named = new Set(later);
      const docs: SlackRoomDoc[] = channels.filter((c) => named.has(String(c.user))).map((channel) => ({ channel, counts: counts.get(String(channel.id)) ?? null }));
      await engine.ingestRooms(docs as unknown as Doc[]);
    }).catch(() => {});
  }

  /** One pass per room at a time: a second call while one runs waits for it. */
  room(engine: SyncEngine, rid: string, isDiscarded: () => boolean): Promise<void> {
    const current = this.running.get(rid);
    if (current !== undefined) return current;
    const run = this.roomPass(engine, rid, isDiscarded).finally(() => this.running.delete(rid));
    this.running.set(rid, run);
    return run;
  }

  /** Purges the rooms I left elsewhere; only on a complete roster. */
  async reconcile(engine: SyncEngine, isDiscarded: () => boolean): Promise<void> {
    const store = engine.syncStore;
    const known = await store.listKnownRids();
    const alive = (await this.roster()).flatMap((c) => (typeof c.id === 'string' ? [c.id] : []));
    if (isDiscarded() || alive.length === 0) return;
    await store.purgeMissingRooms(alive, known);
  }

  private async roomPass(engine: SyncEngine, rid: string, isDiscarded: () => boolean): Promise<void> {
    const store = engine.syncStore;
    const exact = this.history.newestTs(rid);
    let bound: { oldest: string; inclusive?: boolean };
    if (exact !== null) bound = { oldest: exact };
    else {
      const since = await store.lastMessageUpdatedAt(rid);
      // Never loaded: the screen's first page covers it.
      if (since === null) return;
      bound = { oldest: oldestOfMs(since), inclusive: true };
    }
    const messages: Doc[] = [];
    let next: string | null = null;
    for (let n = 0; n < CATCH_UP_PAGES; n++) {
      const page = await this.history.history(rid, { ...bound, limit: CATCH_UP_PAGE }, 'present', next);
      messages.push(...page.messages);
      next = page.nextCursor;
      if (next === null) break;
    }
    if (isDiscarded()) return;
    // Too far behind to fill the gap: the cache goes, the newest page comes back in its place.
    if (next !== null) {
      const { messages: first } = await this.history.history(rid, {}, 'present');
      if (isDiscarded()) return;
      await store.clearRoomMessages(rid);
      await engine.ingestMessages(first);
      return;
    }
    await engine.ingestMessages(messages);
  }

  private async previews(rids: string[]): Promise<Map<string, Doc | null>> {
    const out = new Map<string, Doc | null>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < rids.length) {
        const rid = rids[next++]!;
        const page = await this.history.history(rid, { limit: 1 }).catch(() => null);
        if (page !== null) out.set(rid, page.messages[0] ?? null);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PREVIEW_CONCURRENCY, rids.length) }, worker));
    return out;
  }
}

function latest(counts: Doc | undefined): number {
  return isTimestamp(counts?.latest) ? timestampMs(counts.latest) : 0;
}
