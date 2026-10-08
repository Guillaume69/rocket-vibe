/**
 * Turns one Mattermost real-time event into the `mm:*` envelopes the
 * translator reads, after doing the asynchronous part (unknown users, unknown
 * channels, a reaction that needs its post). Both transports feed it: the
 * Mattermost WebSocket and kChat's Pusher channels carry the same event names.
 *
 * Mattermost pushes no membership document when a post arrives: the unread
 * counters are derived locally from the channel totals and my membership
 * counts, kept here and seeded by the catch-up.
 */

import type { DdpEvent } from '../../lib/ddp.ts';
import { PRESENCE_EVENT, STREAM_NOTIFY_LOGGED } from '../../lib/presence.ts';
import { STREAM_NOTIFY_ROOM_TYPING, TYPING_ACTIVITY } from '../../lib/typing.ts';
import type { MmCategories } from './categories.ts';
import type { MmClient } from './client.ts';
import type { MmDirectory } from './directory.ts';
import { toMmUser } from './directory.ts';
import {
  MM_AVATAR,
  MM_MEMBERSHIP,
  MM_POST,
  MM_POST_DELETED,
  MM_QUIET,
  MM_ROOM,
  MM_ROOM_DELETED,
  record,
} from './translator.ts';

type Doc = Record<string, unknown>;

/** Mattermost statuses onto Rocket.Chat's numbers, which the presence and typing engines read. */
const STATUS_CODES = new Map<string, number>([
  ['offline', 0],
  ['online', 1],
  ['away', 2],
  ['dnd', 3],
]);

const CATEGORY_EVENTS = new Set(['sidebar_category_created', 'sidebar_category_updated', 'sidebar_category_deleted', 'sidebar_category_order_updated']);

const QUIET_EVENTS = new Set(['hello', 'thread_read_changed', 'thread_updated', 'preferences_changed', 'plugin_statuses_changed', 'config_changed', 'license_changed', 'response']);

export class MmLive {
  private readonly client: MmClient;
  private readonly directory: MmDirectory;
  private readonly myId: string;
  private readonly categories: MmCategories | null;
  readonly channels = new Map<string, Doc>();
  readonly members = new Map<string, Doc>();
  readonly lastPosts = new Map<string, Doc>();
  private clock = 0;
  private readonly touched = new Map<string, number>();

  constructor(client: MmClient, directory: MmDirectory, myId: string, categories: MmCategories | null = null) {
    this.client = client;
    this.directory = directory;
    this.myId = myId;
    this.categories = categories;
  }

  remember(channel: Doc, member?: Doc | null): void {
    const id = typeof channel.id === 'string' ? channel.id : null;
    if (id === null) return;
    this.channels.set(id, channel);
    if (member) this.members.set(id, member);
  }

  /** Where a REST snapshot starts: a room an event changes after it is newer than the snapshot. */
  mark(): number {
    return this.clock;
  }

  changedSince(rid: string, mark: number): boolean {
    return (this.touched.get(rid) ?? 0) > mark;
  }

  private touch(rid: string): void {
    this.touched.set(rid, ++this.clock);
  }

  forget(rid: string): void {
    this.channels.delete(rid);
    this.members.delete(rid);
    this.lastPosts.delete(rid);
  }

  membershipEvent(rid: string): DdpEvent | null {
    const channel = this.channels.get(rid);
    const member = this.members.get(rid);
    if (channel === undefined || member === undefined) return null;
    return { collection: MM_MEMBERSHIP, eventKey: rid, args: [{ channel, member }] };
  }

  /** The room row, with the newest root post known for its preview (never a blank one by omission). */
  roomEvent(rid: string, lastPost?: Doc | null): DdpEvent | null {
    const channel = this.channels.get(rid);
    if (channel === undefined) return null;
    if (lastPost) this.lastPosts.set(rid, lastPost);
    return { collection: MM_ROOM, eventKey: rid, args: [{ channel, lastPost: this.lastPosts.get(rid) }] };
  }

  /** Fetches a channel I just learned about, with my membership. */
  async load(rid: string): Promise<boolean> {
    const [channel, member] = await Promise.all([
      this.client.get<Doc>(`/channels/${rid}`),
      this.client.get<Doc>(`/channels/${rid}/members/me`),
    ]);
    if (channel.type === 'D') {
      const other = String(channel.name ?? '').split('__').find((id) => id !== this.myId);
      if (other !== undefined) await this.directory.ensure([other]);
    }
    this.remember(channel, member);
    this.touch(rid);
    return true;
  }

  async expand(name: string, data: Doc, broadcast: Doc): Promise<DdpEvent[]> {
    if (QUIET_EVENTS.has(name)) return [{ collection: MM_QUIET, eventKey: name, args: [] }];
    if (CATEGORY_EVENTS.has(name)) return this.regroup();
    if (name === 'badge_updated') return this.recount();
    const channelId = str(data.channel_id) ?? str(broadcast.channel_id);
    switch (name) {
      case 'typing': {
        const uid = str(data.user_id);
        if (channelId === null || uid === null) return [];
        await this.directory.ensure([uid]);
        const username = this.directory.username(uid) ?? uid;
        return [{ collection: STREAM_NOTIFY_ROOM_TYPING, eventKey: `${channelId}/user-activity`, args: [username, [TYPING_ACTIVITY]] }];
      }
      case 'status_change': {
        const uid = str(data.user_id);
        const code = STATUS_CODES.get(str(data.status) ?? '');
        if (uid === null || code === undefined) return [];
        return [{ collection: STREAM_NOTIFY_LOGGED, eventKey: PRESENCE_EVENT, args: [[uid, this.directory.username(uid) ?? '', code, '']] }];
      }
      case 'posted':
        return this.posted(record(data.post), data);
      case 'post_edited': {
        const post = record(data.post);
        if (post === null) return [];
        await this.directory.ensure([String(post.user_id ?? '')]);
        return [postEvent(post)];
      }
      case 'post_deleted': {
        const post = record(data.post);
        return post === null ? [] : [{ collection: MM_POST_DELETED, eventKey: String(post.channel_id ?? ''), args: [post] }];
      }
      case 'reaction_added':
      case 'reaction_removed': {
        const reaction = record(data.reaction);
        const postId = str(reaction?.post_id);
        if (postId === null) return [];
        const post = await this.client.get<Doc>(`/posts/${postId}`);
        await this.ensureAuthors([post]);
        return [postEvent(post)];
      }
      case 'channel_viewed':
        return channelId === null ? [] : this.viewed([channelId]);
      case 'multiple_channels_viewed': {
        const times = record(data.channel_times) ?? {};
        return this.viewed(Object.keys(times));
      }
      case 'post_unread':
        return channelId === null ? [] : this.unread(channelId, data);
      case 'channel_member_updated': {
        const member = record(data.channelMember);
        const rid = str(member?.channel_id);
        if (member === null || rid === null || member.user_id !== this.myId) return [];
        this.members.set(rid, member);
        this.touch(rid);
        return compact([this.membershipEvent(rid)]);
      }
      case 'channel_created':
      case 'channel_updated':
      case 'channel_converted':
      case 'channel_restored':
      case 'direct_added':
      case 'group_added':
      case 'user_added': {
        const rid = str(record(data.channel)?.id) ?? channelId;
        if (rid === null) return [];
        if (name === 'user_added' && str(data.user_id) !== this.myId) return [];
        await this.load(rid);
        return compact([this.roomEvent(rid), this.membershipEvent(rid)]);
      }
      case 'channel_deleted':
        return channelId === null ? [] : this.removed(channelId);
      case 'user_removed': {
        const removed = str(data.user_id) ?? str(broadcast.user_id);
        return channelId === null || removed !== this.myId ? [] : this.removed(channelId);
      }
      case 'user_updated': {
        const user = toMmUser(record(data.user) ?? {});
        if (user === null) return [];
        this.directory.remember(user);
        return user.lastPictureUpdate === null
          ? []
          : [{ collection: MM_AVATAR, eventKey: user.id, args: [{ username: user.username, etag: String(user.lastPictureUpdate) }] }];
      }
      default:
        return [{ collection: name, eventKey: channelId ?? '', args: [data, broadcast] }];
    }
  }

  private async posted(post: Doc | null, data: Doc): Promise<DdpEvent[]> {
    if (post === null) return [];
    const rid = str(post.channel_id);
    if (rid === null) return [];
    await this.ensureAuthors([post]);
    if (!this.channels.has(rid) || !this.members.has(rid)) await this.load(rid).catch(() => false);
    const channel = this.channels.get(rid);
    const member = this.members.get(rid);
    const isRoot = str(post.root_id) === null;
    const createdAt = typeof post.create_at === 'number' ? post.create_at : Date.now();
    if (channel !== undefined) {
      const next: Doc = { ...channel, total_msg_count: num(channel.total_msg_count) + 1, last_post_at: createdAt };
      if (isRoot) {
        next.total_msg_count_root = num(channel.total_msg_count_root) + 1;
        next.last_root_post_at = createdAt;
      }
      this.channels.set(rid, next);
      this.touch(rid);
      if (member !== undefined) {
        const mine = post.user_id === this.myId;
        const mentions = mentioned(data.mentions, this.myId);
        this.members.set(rid, mine
          ? { ...member, msg_count: next.total_msg_count, msg_count_root: next.total_msg_count_root, mention_count: 0, last_viewed_at: createdAt }
          : { ...member, mention_count: num(member.mention_count) + (mentions ? 1 : 0) });
      }
    }
    return compact([postEvent(post), isRoot ? this.roomEvent(rid, post) : null, this.membershipEvent(rid)]);
  }

  /**
   * kChat's only sign of a read made elsewhere: no room in it, so my
   * memberships are read again and the rooms whose counts moved rewritten.
   */
  private async recount(): Promise<DdpEvent[]> {
    const out: (DdpEvent | null)[] = [];
    for (const member of await this.client.pages<Doc>('/users/me/channel_members')) {
      const rid = str(member.channel_id);
      const known = rid === null ? undefined : this.members.get(rid);
      if (rid === null || known === undefined || !countsMoved(known, member)) continue;
      this.members.set(rid, member);
      this.touch(rid);
      out.push(this.membershipEvent(rid));
    }
    return compact(out);
  }

  /** Categories come without their content: read them again, then every membership row. */
  private async regroup(): Promise<DdpEvent[]> {
    if (this.categories === null) return [{ collection: MM_QUIET, eventKey: 'sidebar', args: [] }];
    await this.categories.load();
    return compact([...this.channels.keys()].map((rid) => this.membershipEvent(rid)));
  }

  private viewed(rids: string[]): DdpEvent[] {
    const out: (DdpEvent | null)[] = [];
    for (const rid of rids) {
      const channel = this.channels.get(rid);
      const member = this.members.get(rid);
      if (channel === undefined || member === undefined) continue;
      this.members.set(rid, {
        ...member,
        msg_count: channel.total_msg_count,
        msg_count_root: channel.total_msg_count_root,
        mention_count: 0,
        mention_count_root: 0,
        last_viewed_at: Date.now(),
      });
      this.touch(rid);
      out.push(this.membershipEvent(rid));
    }
    return compact(out);
  }

  private unread(rid: string, data: Doc): DdpEvent[] {
    const member = this.members.get(rid);
    if (member === undefined) return [];
    this.members.set(rid, {
      ...member,
      msg_count: data.msg_count ?? member.msg_count,
      msg_count_root: data.msg_count_root ?? member.msg_count_root,
      mention_count: data.mention_count ?? member.mention_count,
      last_viewed_at: data.last_viewed_at ?? member.last_viewed_at,
    });
    this.touch(rid);
    return compact([this.membershipEvent(rid)]);
  }

  private removed(rid: string): DdpEvent[] {
    this.forget(rid);
    return [{ collection: MM_ROOM_DELETED, eventKey: rid, args: [{ channel_id: rid }] }];
  }

  async ensureAuthors(posts: Iterable<Doc>): Promise<void> {
    const ids: string[] = [];
    for (const post of posts) {
      if (typeof post.user_id === 'string') ids.push(post.user_id);
      const reactions = record(post.metadata)?.reactions;
      if (Array.isArray(reactions)) {
        for (const r of reactions) if (typeof r?.user_id === 'string') ids.push(r.user_id);
      }
    }
    await this.directory.ensure(ids);
  }
}

function countsMoved(before: Doc, after: Doc): boolean {
  return ['msg_count', 'msg_count_root', 'mention_count', 'mention_count_root', 'last_viewed_at'].some((k) => before[k] !== after[k]);
}

function postEvent(post: Doc): DdpEvent {
  return { collection: MM_POST, eventKey: String(post.channel_id ?? ''), args: [post] };
}

/** `mentions` is a JSON-encoded array of user ids on Mattermost, an array on kChat. */
function mentioned(raw: unknown, me: string): boolean {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return false;
    }
  }
  return Array.isArray(list) && list.includes(me);
}

function compact(events: (DdpEvent | null)[]): DdpEvent[] {
  return events.filter((e): e is DdpEvent => e !== null);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
