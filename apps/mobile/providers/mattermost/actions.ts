/**
 * Message actions over Mattermost REST. A star is Mattermost's "flagged post",
 * a per-user preference (`category: flagged_post`, `name: <post id>`), not a
 * field of the post.
 */

import { cardActionRoute } from '../../lib/integrationCards.ts';
import type { LocalMessage } from '../../lib/normalize.ts';
import type { CardActionAnswer, GroupDmPerson, ProviderActions, RoomFavorite, RoomInformation } from '../../lib/provider.ts';
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
    // The screen writes the column; the set keeps it through the next read of the post.
    this.live.flag(mid, put);
  }

  async listPinned(rid: string): Promise<LocalMessage[]> {
    return this.messages(await this.client.get(`/channels/${rid}/pinned`));
  }

  async listStarred(rid: string): Promise<LocalMessage[]> {
    const list = await this.messages(
      await this.client.get('/users/me/posts/flagged', { query: { channel_id: rid, per_page: 100 } }),
    );
    for (const m of list) this.live.flag(m.id, true);
    return list.map((m) => ({ ...m, starred: JSON.stringify([this.myId]) }));
  }

  async markRead(rid: string): Promise<void> {
    await this.client.post('/channels/members/me/view', { body: { channel_id: rid } });
  }

  async cardAction(postId: string, actionId: string, cookie: string | null, selected?: string): Promise<CardActionAnswer> {
    const route = cardActionRoute(postId, actionId);
    if (route === null) throw new Error('card action outside its route');
    const answer = await this.client.post<Doc | null>(route, {
      body: { ...(cookie === null ? {} : { cookie }), ...(selected === undefined ? {} : { selected_option: selected }) },
    });
    return { ephemeralText: text(answer?.ephemeral_text), gotoLocation: text(answer?.goto_location) };
  }

  /** People by username, or channels of the room's team by display name, the value their id. */
  async cardMenuOptions(rid: string, source: 'users' | 'channels', term: string): Promise<{ label: string; value: string }[]> {
    const clean = term.trim().replace(/^[@~]+/, '');
    let found: unknown;
    if (source === 'users') {
      found = await this.client.post('/users/search', { body: { term: clean, limit: 20 } });
    } else {
      const team = text(this.live.channels.get(rid)?.team_id) ?? text((await this.client.get<Doc[]>('/users/me/teams'))[0]?.id);
      if (team === null) return [];
      found = await this.client.post(`/teams/${team}/channels/search`, { body: { term: clean } });
    }
    const key = source === 'users' ? 'username' : 'display_name';
    return (Array.isArray(found) ? (found as Doc[]) : []).flatMap((doc) => {
      const label = text(doc[key]) ?? text(doc.name);
      const value = text(doc.id);
      return label !== null && value !== null ? [{ label, value }] : [];
    }).slice(0, 20);
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

  /** Me added by the server when absent; the same set gives the same channel back. */
  async openOrCreateGroupDm(people: GroupDmPerson[]): Promise<{ rid: string; rawRoom: Record<string, unknown> }> {
    const ids = await Promise.all(people.map(async (person) => person.uid ?? (await this.directory.byName(person.username)).id));
    const channel = await this.client.post<Doc>('/channels/group', { body: [this.myId, ...ids] });
    const rid = typeof channel.id === 'string' ? channel.id : null;
    if (rid === null) throw new Error('Group channel answer without an id.');
    const shown = [{ user_id: this.myId, category: 'group_channel_show', name: rid, value: 'true' }];
    await this.client.put('/users/me/preferences', { body: shown }).catch(() => {});
    this.categories?.sidebar.apply(shown);
    this.categories?.sidebar.reveal(rid);
    await this.directory.ensure(ids);
    await this.live.load(rid).catch(() => this.live.remember(channel));
    return { rid, rawRoom: { channel: this.live.channels.get(rid) ?? channel } };
  }

  /** People by username or name for a new conversation, me and deactivated accounts left out. */
  async searchPeople(query: string): Promise<{ id: string; name: string; detail: string }[]> {
    const found = await this.client.post<unknown>('/users/search', { body: { term: query.trim().replace(/^@+/, ''), limit: 20 } });
    return (Array.isArray(found) ? (found as Doc[]) : []).flatMap((doc) => {
      const id = text(doc.id);
      const username = text(doc.username);
      if (id === null || username === null || id === this.myId || Number(doc.delete_at ?? 0) > 0) return [];
      const full = [text(doc.first_name), text(doc.last_name)].filter((part) => part !== null).join(' ');
      return [{ id, name: username, detail: full !== '' ? full : (text(doc.nickname) ?? username) }];
    });
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
