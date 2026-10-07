/**
 * REST catch-up. The global pass rebuilds rooms and memberships from two
 * calls (`/users/me/channels`, `/users/me/channel_members`), which Mattermost
 * answers across every team: no `updatedSince` delta exists, but the lists are
 * a few hundred rows at most. A room's pass reads `?since=` (edits and
 * deletions included, `delete_at > 0`), which is fast server-side, unlike
 * Rocket.Chat's `chat.syncMessages`.
 *
 * Mattermost carries no last-message text on a channel: the newest root post
 * of the most recently active rooms is fetched for the list's preview.
 */

import type { SyncEngine } from '../../lib/sync.ts';
import type { MmClient } from './client.ts';
import type { MmDirectory } from './directory.ts';
import { MmHistory } from './history.ts';
import type { MmLive } from './live.ts';
import type { MmRoomDoc } from './translator.ts';

type Doc = Record<string, unknown>;

const PER_PAGE = 200;
const PREVIEWS = 40;
const PREVIEW_CONCURRENCY = 4;
const CURSOR_SCOPE = '*';
const CURSOR_STREAM = 'mm-last-post';

export class MmCatchUp {
  private readonly client: MmClient;
  private readonly directory: MmDirectory;
  private readonly live: MmLive;
  private readonly history: MmHistory;
  private readonly myId: string;
  /** kChat lists deletions on their own route; upstream returns them in `since`. */
  private readonly deletedRoute: boolean;
  private readonly running = new Map<string, Promise<void>>();

  constructor(options: { client: MmClient; directory: MmDirectory; live: MmLive; history: MmHistory; myId: string; deletedRoute: boolean }) {
    this.client = options.client;
    this.directory = options.directory;
    this.live = options.live;
    this.history = options.history;
    this.myId = options.myId;
    this.deletedRoute = options.deletedRoute;
  }

  async channels(): Promise<Doc[]> {
    return this.pages<Doc>('/users/me/channels');
  }

  async global(engine: SyncEngine, isDiscarded: () => boolean): Promise<void> {
    const [channels, members] = await Promise.all([this.channels(), this.pages<Doc>('/users/me/channel_members')]);
    if (isDiscarded()) return;
    const memberOf = new Map(members.map((m) => [String(m.channel_id), m]));
    const live = channels.filter((c) => !(typeof c.delete_at === 'number' && c.delete_at > 0) && memberOf.has(String(c.id)));
    await this.directory.ensure(live.flatMap((c) => (c.type === 'D' ? String(c.name ?? '').split('__') : [])));
    for (const channel of live) this.live.remember(channel, memberOf.get(String(channel.id)));

    const store = engine.syncStore;
    const since = (await store.readCursor(CURSOR_SCOPE, CURSOR_STREAM)) ?? 0;
    // An unchanged room is not re-ingested: its row would lose the preview,
    // the list's last message being written as is, null included.
    const changed = live.filter((c) => changedAt(c) > since).sort((a, b) => lastPostAt(b) - lastPostAt(a));
    const previews = await this.previews(changed.slice(0, PREVIEWS));
    if (isDiscarded()) return;
    for (const [rid, post] of previews) this.live.lastPosts.set(rid, post);

    const rooms: MmRoomDoc[] = changed.map((channel) => ({ channel, lastPost: this.live.lastPosts.get(String(channel.id)) ?? null }));
    await engine.ingestRooms(rooms as unknown as Doc[]);
    await engine.ingestSubscriptions(live.map((channel) => ({ channel, member: memberOf.get(String(channel.id)) })));
    const newest = live.reduce((max, c) => Math.max(max, changedAt(c)), 0);
    if (newest > 0) await store.writeCursor(CURSOR_SCOPE, CURSOR_STREAM, newest);
  }

  /** One pass per room at a time: a second call while one runs waits for it. */
  room(engine: SyncEngine, rid: string, isDiscarded: () => boolean): Promise<void> {
    const current = this.running.get(rid);
    if (current !== undefined) return current;
    const run = this.roomPass(engine, rid, isDiscarded).finally(() => this.running.delete(rid));
    this.running.set(rid, run);
    return run;
  }

  async reconcile(engine: SyncEngine, isDiscarded: () => boolean): Promise<void> {
    const store = engine.syncStore;
    const known = await store.listKnownRids();
    const alive = (await this.channels())
      .filter((c) => !(typeof c.delete_at === 'number' && c.delete_at > 0))
      .map((c) => String(c.id));
    if (isDiscarded() || alive.length === 0) return;
    await store.purgeMissingRooms(alive, known);
  }

  private async roomPass(engine: SyncEngine, rid: string, isDiscarded: () => boolean): Promise<void> {
    const store = engine.syncStore;
    const since = await store.lastMessageUpdatedAt(rid);
    // Never loaded: the screen's first page covers it, an unbounded `since=0`
    // would download the whole room.
    if (since === null) return;
    const list = await this.client.get<{ order?: string[]; posts?: Record<string, Doc> }>(`/channels/${rid}/posts`, {
      query: { since },
    });
    const posts = Object.values(list.posts ?? {});
    let deleted = posts.filter((p) => typeof p.delete_at === 'number' && p.delete_at > 0).map((p) => String(p.id));
    if (this.deletedRoute) {
      const ids = await this.client.get<unknown>(`/channels/${rid}/deleted_posts`, { query: { since } }).catch(() => []);
      if (Array.isArray(ids)) deleted = [...deleted, ...ids.filter((id): id is string => typeof id === 'string')];
    }
    const alive = posts.filter((p) => !(typeof p.delete_at === 'number' && p.delete_at > 0));
    await this.live.ensureAuthors(alive);
    if (isDiscarded()) return;
    await engine.ingestMessages(alive);
    for (const id of deleted) await store.deleteMessage(id);
  }

  private async previews(channels: Doc[]): Promise<Map<string, Doc>> {
    const out = new Map<string, Doc>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < channels.length) {
        const channel = channels[next++]!;
        const rid = String(channel.id);
        const post = await this.history.page(rid, null, 1).then((p) => p[0], () => undefined);
        if (post !== undefined) out.set(rid, post);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PREVIEW_CONCURRENCY, channels.length) }, worker));
    return out;
  }

  private async pages<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; ; page++) {
      const batch = await this.client.get<T[]>(path, { query: { page, per_page: PER_PAGE } });
      if (!Array.isArray(batch)) return out;
      out.push(...batch);
      if (batch.length < PER_PAGE) return out;
    }
  }

  get me(): string {
    return this.myId;
  }
}

function changedAt(channel: Doc): number {
  const updated = typeof channel.update_at === 'number' ? channel.update_at : 0;
  return Math.max(updated, lastPostAt(channel));
}

function lastPostAt(channel: Doc): number {
  const root = channel.last_root_post_at;
  if (typeof root === 'number' && root > 0) return root;
  return typeof channel.last_post_at === 'number' ? channel.last_post_at : 0;
}
