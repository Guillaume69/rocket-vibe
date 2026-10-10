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
import type { MmCategories } from './categories.ts';
import type { MmClient } from './client.ts';
import { nameFormatOf, type MmDirectory, type NameFormat } from './directory.ts';
import { MmHistory } from './history.ts';
import type { MmLive } from './live.ts';
import type { MmRoomDoc } from './translator.ts';

type Doc = Record<string, unknown>;

const PREVIEWS = 40;
/** Rows `?since=` answers at most (read in the 11.11 server), in no promised order. */
const SINCE_CAP = 1000;
const PREVIEW_CONCURRENCY = 4;
const CURSOR_SCOPE = '*';
const CURSOR_STREAM = 'mm-last-post';
const NAME_STREAM = 'mm-names-';
const NAME_FORMATS: readonly NameFormat[] = ['username', 'nickname_full_name', 'full_name'];

export class MmCatchUp {
  private readonly client: MmClient;
  private readonly directory: MmDirectory;
  private readonly live: MmLive;
  private readonly history: MmHistory;
  private readonly categories: MmCategories | null;
  private readonly myId: string;
  /** kChat lists deletions on their own route; upstream returns them in `since`. */
  private readonly deletedRoute: boolean;
  private readonly running = new Map<string, Promise<void>>();

  constructor(options: { client: MmClient; directory: MmDirectory; live: MmLive; history: MmHistory; categories?: MmCategories; myId: string; deletedRoute: boolean }) {
    this.client = options.client;
    this.directory = options.directory;
    this.live = options.live;
    this.history = options.history;
    this.categories = options.categories ?? null;
    this.myId = options.myId;
    this.deletedRoute = options.deletedRoute;
  }

  /** The whole list in one answer: this route ignores `page` and `per_page`. */
  async channels(): Promise<Doc[]> {
    const list = await this.client.get<unknown>('/users/me/channels');
    return Array.isArray(list) ? (list as Doc[]) : [];
  }

  async global(engine: SyncEngine, isDiscarded: () => boolean): Promise<void> {
    const mark = this.live.mark();
    // A server older than 5.32 has no categories: the rooms keep the default sections.
    const [channels, members, format, flags] = await Promise.all([
      this.channels(),
      this.client.pages<Doc>('/users/me/channel_members'),
      this.nameFormat(),
      this.client.get<unknown>('/users/me/preferences/flagged_post').catch(() => null),
      this.categories?.load().catch(() => {}),
      this.categories?.sidebar.load().catch(() => {}),
    ]);
    if (format !== null) this.directory.setNameFormat(format);
    if (isDiscarded()) return;
    // My stars are preferences, not in the posts: the set marks every post read from now on.
    if (Array.isArray(flags)) {
      const ids = (flags as Doc[]).filter((p) => p?.value !== 'false' && typeof p?.name === 'string').map((p) => String(p.name));
      for (const event of this.live.resetFlags(ids)) await engine.apply(event);
    }
    const memberOf = new Map(members.map((m) => [String(m.channel_id), m]));
    const live = channels.filter((c) => !(typeof c.delete_at === 'number' && c.delete_at > 0) && memberOf.has(String(c.id)));
    this.categories?.rankConversations(live);
    await this.directory.ensure([this.myId, ...live.flatMap((c) => (c.type === 'D' ? String(c.name ?? '').split('__') : []))]);
    await this.directory.ensureUsernames(live.flatMap((c) => (c.type === 'G' ? String(c.display_name ?? '').split(',').map((n) => n.trim()) : [])));
    // A room an event changed during the requests has fresher counts than this snapshot.
    const fresh = live.filter((c) => !this.live.changedSince(String(c.id), mark));
    for (const channel of fresh) this.live.remember(channel, memberOf.get(String(channel.id)));

    const store = engine.syncStore;
    // DM names follow the name format: rooms written under another one are all written again.
    const named = await Promise.all(NAME_FORMATS.map((f) => store.readCursor(CURSOR_SCOPE, `${NAME_STREAM}${f}`)));
    const newest = Math.max(...named.map((at) => at ?? 0));
    const current = named[NAME_FORMATS.indexOf(this.directory.nameFormat)] ?? 0;
    const since = newest > current || current === 0 ? 0 : ((await store.readCursor(CURSOR_SCOPE, CURSOR_STREAM)) ?? 0);
    // An unchanged room is not re-ingested: its row would lose the preview,
    // the list's last message being written as is, null included.
    // Conversations are named from people, whose names move without the channel moving.
    const changed = live.filter((c) => changedAt(c) > since || c.type === 'D' || c.type === 'G').sort((a, b) => lastPostAt(b) - lastPostAt(a));
    const previews = await this.previews(changed.slice(0, PREVIEWS));
    if (isDiscarded()) return;
    for (const [rid, post] of previews) this.live.lastPosts.set(rid, post);

    const rooms: MmRoomDoc[] = changed.map((channel) => ({ channel, lastPost: this.live.lastPosts.get(String(channel.id)) }));
    await engine.ingestRooms(rooms as unknown as Doc[]);
    await engine.ingestSubscriptions(
      live
        .filter((c) => !this.live.changedSince(String(c.id), mark))
        .map((channel) => ({ channel, member: memberOf.get(String(channel.id)) })),
    );
    const latest = live.reduce((max, c) => Math.max(max, changedAt(c)), 0);
    if (latest > 0) await store.writeCursor(CURSOR_SCOPE, CURSOR_STREAM, latest);
    if (current === 0 || newest > current) await store.writeCursor(CURSOR_SCOPE, `${NAME_STREAM}${this.directory.nameFormat}`, Date.now());
  }

  /** My `name_format` preference, else the server's `TeammateNameDisplay`, which wins when locked. */
  private async nameFormat(): Promise<NameFormat | null> {
    const [config, prefs] = await Promise.all([
      this.client.get<Doc>('/config/client', { query: { format: 'old' } }).catch(() => ({}) as Doc),
      this.client.get<unknown>('/users/me/preferences/display_settings').catch(() => []),
    ]);
    const server = nameFormatOf(config.TeammateNameDisplay);
    const preference = Array.isArray(prefs) ? prefs.find((p: Doc) => p?.name === 'name_format') : undefined;
    const mine = nameFormatOf((preference as Doc | undefined)?.value);
    return config.LockTeammateNameDisplay === 'true' ? server : (mine ?? server);
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
    // A full answer may have left changes out, in no order, and ingesting it
    // would move the cursor (the newest `updatedAt`) past them: the cache can no
    // longer be vouched for. It goes, and the newest page comes back in its place;
    // older history pages in from the server again when scrolled to.
    if (posts.length >= SINCE_CAP) {
      const first = await this.history.page(rid, null);
      await this.live.ensureAuthors(first);
      if (isDiscarded()) return;
      await store.clearRoomMessages(rid);
      await engine.ingestMessages(first);
      return;
    }
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
