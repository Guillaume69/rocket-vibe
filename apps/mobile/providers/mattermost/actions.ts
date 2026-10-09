/**
 * Message actions over Mattermost REST. A star is Mattermost's "flagged post",
 * a per-user preference (`category: flagged_post`, `name: <post id>`), not a
 * field of the post.
 */

import type { LocalMessage } from '../../lib/normalize.ts';
import type { ProviderActions, RoomFavorite, RoomInformation } from '../../lib/provider.ts';
import type { MmCategories } from './categories.ts';
import type { MmClient } from './client.ts';
import type { MmDirectory } from './directory.ts';
import { ordered } from './history.ts';
import type { MmLive } from './live.ts';
import type { MmTranslator } from './translator.ts';

type Doc = Record<string, unknown>;

export class MmActions implements ProviderActions {
  private readonly client: MmClient;
  private readonly directory: MmDirectory;
  private readonly live: MmLive;
  private readonly translator: MmTranslator;
  private readonly myId: string;
  private readonly categories: MmCategories | null;

  constructor(options: { client: MmClient; directory: MmDirectory; live: MmLive; translator: MmTranslator; myId: string; categories?: MmCategories }) {
    this.client = options.client;
    this.directory = options.directory;
    this.live = options.live;
    this.translator = options.translator;
    this.myId = options.myId;
    this.categories = options.categories ?? null;
  }

  /** The server moves the room in or out of my Favorites category, and says so with `sidebar_category_updated`. */
  roomFavorite: RoomFavorite = {
    edit: async (rid: string, present: boolean): Promise<void> => {
      await this.client.put('/users/me/preferences', {
        body: [{ user_id: this.myId, category: 'favorite_channel', name: rid, value: String(present) }],
      });
      this.categories?.noteFavorite(rid, present);
    },
  };

  async roomInfo(rid: string): Promise<RoomInformation> {
    const [channel, stats] = await Promise.all([
      this.client.get<Doc>(`/channels/${rid}`),
      this.client.get<Doc>(`/channels/${rid}/stats`).catch(() => ({}) as Doc),
    ]);
    const room = this.translator.toRoom({ channel });
    return {
      id: rid,
      name: room?.displayName ?? String(channel.display_name ?? channel.name ?? rid),
      type: room?.type ?? 'c',
      description: text(channel.purpose),
      topic: text(channel.header),
      announcement: null,
      members: typeof stats.member_count === 'number' ? stats.member_count : null,
      readOnly: false,
    };
  }

  async react(_rid: string, mid: string, emoji: string, put: boolean): Promise<void> {
    if (put) {
      await this.client.post('/reactions', { body: { user_id: this.myId, post_id: mid, emoji_name: emoji } });
    } else {
      await this.client.delete(`/users/me/posts/${mid}/reactions/${encodeURIComponent(emoji)}`);
    }
  }

  async edit(_rid: string, mid: string, newText: string): Promise<void> {
    await this.client.put(`/posts/${mid}/patch`, { body: { message: newText } });
  }

  async delete(_rid: string, mid: string): Promise<void> {
    await this.client.delete(`/posts/${mid}`);
  }

  async pin(_rid: string, mid: string): Promise<void> {
    await this.client.post(`/posts/${mid}/pin`);
  }

  async unpin(_rid: string, mid: string): Promise<void> {
    await this.client.post(`/posts/${mid}/unpin`);
  }

  async star(_rid: string, mid: string, put: boolean): Promise<void> {
    const preference = [{ user_id: this.myId, category: 'flagged_post', name: mid, value: 'true' }];
    if (put) await this.client.put('/users/me/preferences', { body: preference });
    else await this.client.post('/users/me/preferences/delete', { body: preference });
  }

  async listPinned(rid: string): Promise<LocalMessage[]> {
    return this.messages(await this.client.get(`/channels/${rid}/pinned`));
  }

  async listStarred(rid: string): Promise<LocalMessage[]> {
    const list = await this.messages(
      await this.client.get('/users/me/posts/flagged', { query: { channel_id: rid, per_page: 100 } }),
    );
    return list.map((m) => ({ ...m, starred: JSON.stringify([this.myId]) }));
  }

  async markRead(rid: string): Promise<void> {
    await this.client.post('/channels/members/me/view', { body: { channel_id: rid } });
  }

  async openOrCreateDm(username: string, uid?: string): Promise<{ rid: string; rawRoom: Record<string, unknown> }> {
    const otherId = uid ?? (await this.directory.byName(username)).id;
    const channel = await this.client.post<Doc>('/channels/direct', { body: [this.myId, otherId] });
    const rid = typeof channel.id === 'string' ? channel.id : null;
    if (rid === null) throw new Error('Direct channel answer without an id.');
    const shown = [{ user_id: this.myId, category: 'direct_channel_show', name: otherId, value: 'true' }];
    await this.client.put('/users/me/preferences', { body: shown }).catch(() => {});
    this.categories?.sidebar.apply(shown);
    this.categories?.sidebar.reveal(rid);
    await this.directory.ensure([otherId]);
    await this.live.load(rid).catch(() => this.live.remember(channel));
    return { rid, rawRoom: { channel: this.live.channels.get(rid) ?? channel } };
  }

  private async messages(list: unknown): Promise<LocalMessage[]> {
    const posts = ordered((list ?? {}) as Parameters<typeof ordered>[0]);
    await this.live.ensureAuthors(posts);
    return posts
      .map((post) => this.translator.toMessage(post))
      .filter((m): m is LocalMessage => m !== null)
      .sort((a, b) => b.ts - a.ts);
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
