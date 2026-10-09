/**
 * Loading posts: a room's pages, a range around an instant, one post, a
 * thread. Mattermost pages by POST ID (`before=<id>`), never by time, while
 * the screen hands an ISO bound (the oldest message it shows). The ids of the
 * posts seen are indexed by instant so that bound turns back into an id; a
 * miss (the bound came from the local database after a restart) walks back
 * from the newest page instead.
 *
 * `collapsedThreads=true` returns root posts only, the counterpart of
 * Rocket.Chat's `showThreadMessages: false`: replies live in the thread.
 */

import type { SyncEngine } from '../../lib/sync.ts';
import type { MmClient } from './client.ts';
import { MmError } from './client.ts';
import type { MmLive } from './live.ts';

export const MM_HISTORY_PAGE = 50;
const MAX_WALK_PAGES = 20;

type Doc = Record<string, unknown>;
type PostList = { order?: string[]; posts?: Record<string, Doc>; prev_post_id?: string };

export class MmHistory {
  private readonly client: MmClient;
  private readonly live: MmLive;
  private readonly index = new Map<string, Map<number, string>>();

  constructor(client: MmClient, live: MmLive) {
    this.client = client;
    this.live = live;
  }

  /** Posts newest first, deleted ones dropped, every author known to the directory. */
  async page(rid: string, before: string | null, perPage = MM_HISTORY_PAGE): Promise<Doc[]> {
    const list = await this.client.get<PostList>(`/channels/${rid}/posts`, {
      query: { per_page: perPage, before: before ?? undefined, collapsedThreads: true },
    });
    const posts = ordered(list);
    this.remember(rid, posts);
    await this.live.ensureAuthors(posts);
    return posts;
  }

  async loadHistory(engine: SyncEngine, rid: string, latest?: string): Promise<{ oldest: number | null }> {
    const bound = latest === undefined ? null : Date.parse(latest);
    const posts = bound === null || Number.isNaN(bound) ? await this.page(rid, null) : await this.olderThan(rid, bound);
    await engine.ingestMessages(posts);
    return { oldest: oldestOf(posts) };
  }

  /** Up to a page of posts in `[oldest, latest]`, newest first, not ingested. */
  async range(rid: string, latest: number | null, oldest: number | null): Promise<Doc[]> {
    const out: Doc[] = [];
    let before: string | null = latest === null ? null : this.idAt(rid, latest);
    for (let walked = 0; walked < MAX_WALK_PAGES; walked++) {
      const posts = await this.page(rid, before);
      for (const post of posts) {
        const at = createdAt(post);
        if (latest !== null && at > latest) continue;
        if (oldest !== null && at < oldest) return out;
        out.push(post);
        if (out.length >= MM_HISTORY_PAGE) return out;
      }
      if (posts.length < MM_HISTORY_PAGE) return out;
      before = String(posts[posts.length - 1]!.id);
    }
    return out;
  }

  async fetch(id: string): Promise<Doc | null> {
    try {
      const post = await this.client.get<Doc>(`/posts/${id}`);
      await this.live.ensureAuthors([post]);
      return post;
    } catch (e) {
      if (e instanceof MmError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  }

  async loadThread(engine: SyncEngine, rootId: string, isDiscarded: () => boolean): Promise<void> {
    const list = await this.client.get<PostList>(`/posts/${rootId}/thread`);
    const posts = ordered(list);
    await this.live.ensureAuthors(posts);
    if (isDiscarded()) return;
    await engine.ingestMessages(posts);
  }

  private async olderThan(rid: string, bound: number): Promise<Doc[]> {
    const known = this.idAt(rid, bound);
    if (known !== null) return this.page(rid, known);
    let before: string | null = null;
    for (let walked = 0; walked < MAX_WALK_PAGES; walked++) {
      const posts = await this.page(rid, before);
      const older = posts.filter((p) => createdAt(p) < bound);
      if (older.length > 0 || posts.length < MM_HISTORY_PAGE) return older;
      before = String(posts[posts.length - 1]!.id);
    }
    return [];
  }

  private idAt(rid: string, at: number): string | null {
    return this.index.get(rid)?.get(at) ?? null;
  }

  private remember(rid: string, posts: Doc[]): void {
    let byTime = this.index.get(rid);
    if (byTime === undefined) {
      byTime = new Map();
      this.index.set(rid, byTime);
    }
    for (const post of posts) {
      if (typeof post.id === 'string') byTime.set(createdAt(post), post.id);
    }
  }
}

export function ordered(list: PostList): Doc[] {
  const posts = list.posts ?? {};
  return (list.order ?? [])
    .map((id) => posts[id])
    .filter((p): p is Doc => p !== undefined && !(typeof p.delete_at === 'number' && p.delete_at > 0));
}

function createdAt(post: Doc): number {
  return typeof post.create_at === 'number' ? post.create_at : 0;
}

function oldestOf(posts: Doc[]): number | null {
  let oldest: number | null = null;
  for (const post of posts) {
    const at = createdAt(post);
    if (at > 0 && (oldest === null || at < oldest)) oldest = at;
  }
  return oldest;
}
