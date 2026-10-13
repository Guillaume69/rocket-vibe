/**
 * Loading Slack messages: a room's pages, a range, one message, a thread.
 * Slack bounds history by exact `ts`, while the screen hands a millisecond
 * bound. The exact `ts` of every message read is indexed by millisecond so
 * the bound turns back into the oldest exact one; a miss (a bound read from
 * the database after a restart) asks for everything up to the end of that
 * millisecond, inclusive, and the upserts drop what is already there.
 */

import type { SyncEngine } from '../../lib/sync.ts';
import type { SlackArgs, SlackClient } from './client.ts';
import { compareTimestamp, isTimestamp, latestOfMs, oldestOfMs, SlackError, timestampMs } from './client.ts';
import type { SlackDirectory } from './directory.ts';
import { parseMessageId, SlackTranslator } from './translator.ts';

type Doc = Record<string, unknown>;
type Track = 'none' | 'stretch' | 'present';

export const SLACK_HISTORY_PAGE = 50;
const THREAD_PAGE = 200;

export class SlackHistory {
  private readonly client: SlackClient;
  private readonly directory: SlackDirectory;
  /** Per room: millisecond to the oldest exact `ts` read at it. */
  private readonly index = new Map<string, Map<number, string>>();
  /** Per room: the newest exact `ts` read. */
  private readonly newest = new Map<string, string>();

  constructor(client: SlackClient, directory: SlackDirectory) {
    this.client = client;
    this.directory = directory;
  }

  /**
   * Messages stamped with their channel, their people known to the directory.
   * `track`: the page's `ts` may serve as bounds, `present` when it reaches
   * the room's newest message; never a thread's or a lone message's.
   */
  async prepare(rid: string, raw: readonly Doc[], track: Track = 'none'): Promise<Doc[]> {
    const messages = raw.filter((m) => isTimestamp(m.ts)).map((m) => ({ ...m, channel: rid }));
    if (track !== 'none') this.remember(rid, messages, track === 'present');
    const { users, bots } = SlackTranslator.people(messages);
    await this.directory.ensure(users, bots);
    return messages;
  }

  async history(rid: string, args: SlackArgs, track: Track = 'none', next: string | null = null): Promise<{ messages: Doc[]; nextCursor: string | null }> {
    const page = await this.client.page('conversations.history', { channel: rid, limit: SLACK_HISTORY_PAGE, ...args }, 'messages', next);
    return { messages: await this.prepare(rid, page.items, track), nextCursor: page.nextCursor };
  }

  async loadHistory(engine: SyncEngine, rid: string, latest?: string): Promise<{ oldest: number | null }> {
    const bound = latest === undefined ? NaN : Date.parse(latest);
    const exact = Number.isNaN(bound) ? null : this.exactAt(rid, bound);
    const args: SlackArgs = Number.isNaN(bound) ? {} : exact !== null ? { latest: exact } : { latest: latestOfMs(bound), inclusive: true };
    const { messages } = await this.history(rid, args, Number.isNaN(bound) ? 'present' : 'stretch');
    await engine.ingestMessages(messages);
    return { oldest: oldestOf(messages) };
  }

  /** The newest page of `[oldest, latest]`, bounds included, not ingested. */
  async range(rid: string, latest: number | null, oldest: number | null): Promise<Doc[]> {
    return (await this.history(rid, {
      ...(latest === null ? {} : { latest: latestOfMs(latest) }),
      ...(oldest === null ? {} : { oldest: oldestOfMs(oldest) }),
      inclusive: true,
    })).messages;
  }

  async fetch(id: string): Promise<Doc | null> {
    const target = parseMessageId(id);
    if (target === null) return null;
    try {
      const { messages } = await this.history(target.channel, { latest: target.ts, inclusive: true, limit: 1 });
      return messages.find((m) => m.ts === target.ts) ?? null;
    } catch (e) {
      if (e instanceof SlackError && (e.code === 'channel_not_found' || e.code === 'not_in_channel')) return null;
      throw e;
    }
  }

  /** The whole thread; Slack repeats the root at the head of every page, kept once. */
  async loadThread(engine: SyncEngine, threadId: string, isDiscarded: () => boolean): Promise<void> {
    const target = parseMessageId(threadId);
    if (target === null) return;
    const byTs = new Map<string, Doc>();
    const seen = new Set<string>();
    let next: string | null = null;
    do {
      const page = await this.client.page('conversations.replies', { channel: target.channel, ts: target.ts, limit: THREAD_PAGE }, 'messages', next);
      if (isDiscarded()) return;
      for (const m of page.items) if (isTimestamp(m.ts)) byTs.set(m.ts, m);
      if (page.nextCursor !== null && seen.has(page.nextCursor)) throw new SlackError('pagination_loop');
      next = page.nextCursor;
      if (next !== null) seen.add(next);
    } while (next !== null);
    const messages = await this.prepare(target.channel, [...byTs.values()]);
    if (isDiscarded()) return;
    await engine.ingestMessages(messages);
  }

  newestTs(rid: string): string | null {
    return this.newest.get(rid) ?? null;
  }

  private exactAt(rid: string, ms: number): string | null {
    return this.index.get(rid)?.get(ms) ?? null;
  }

  private remember(rid: string, messages: readonly Doc[], present: boolean): void {
    let byMs = this.index.get(rid);
    if (byMs === undefined) {
      byMs = new Map();
      this.index.set(rid, byMs);
    }
    for (const m of messages) {
      const ts = m.ts as string;
      const ms = timestampMs(ts);
      const known = byMs.get(ms);
      if (known === undefined || compareTimestamp(ts, known) < 0) byMs.set(ms, ts);
      const newest = this.newest.get(rid);
      if (newest === undefined ? present : compareTimestamp(ts, newest) > 0) this.newest.set(rid, ts);
    }
  }
}

function oldestOf(messages: readonly Doc[]): number | null {
  let oldest: number | null = null;
  for (const m of messages) {
    const ms = timestampMs(m.ts as string);
    if (oldest === null || ms < oldest) oldest = ms;
  }
  return oldest;
}
