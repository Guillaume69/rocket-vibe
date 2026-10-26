/**
 * One Slack RTM frame into the neutral `slack:*` envelopes the translator
 * reads, after the asynchronous part (unknown authors, a reaction's message).
 *
 * Slack pushes no conversation or read document when a message arrives: the
 * channel docs and the per-room counts are kept here, seeded by the catch-up,
 * and the unread state is derived locally. The `*_marked` frames carry
 * authoritative counts and overwrite it.
 */

import type { DdpEvent } from '@rocket-vibe/provider-api/ddp';
import { PRESENCE_EVENT, STREAM_NOTIFY_LOGGED, type PresenceStatus } from '@rocket-vibe/provider-api/presence';
import { STREAM_NOTIFY_ROOM_TYPING, TYPING_ACTIVITY } from '@rocket-vibe/provider-api/typing';
import { SlackError, compareTimestamp, exactTimestamp, isTimestamp } from './client.ts';
import type { SlackClient } from './client.ts';
import type { SlackDirectory } from './directory.ts';
import type { SlackHistory } from './history.ts';
import { SLACK_AVATAR, SLACK_MESSAGE, SLACK_MESSAGE_DELETED, SLACK_QUIET, SLACK_ROOM, SLACK_SUBSCRIPTION, SlackTranslator } from './translator.ts';
import { toSlackUser } from './directory.ts';

type Doc = Record<string, unknown>;

/** Slack presence strings onto the numbers the presence engine reads. */
const PRESENCE_CODES = new Map<string, number>([
  ['active', 1],
  ['away', 2],
]);
const PRESENCE_STATUS = new Map<string, PresenceStatus>([
  ['active', 'online'],
  ['away', 'away'],
]);

const MARKED = new Set(['channel_marked', 'group_marked', 'im_marked', 'mpim_marked']);
const JOINED = new Set(['im_created', 'channel_joined', 'group_joined', 'mpim_open', 'mpim_joined']);
const GONE = new Set(['channel_not_found', 'not_in_channel', 'missing_scope']);
const SKIPPED_PREVIEW = new Set(['tombstone', 'message_deleted', 'message_changed', 'message_replied']);
const PREVIEW_LOOKBACK = 10;
const QUIET = new Set(['hello', 'pong', 'reconnect_url', 'pref_change', 'dnd_updated', 'dnd_updated_user', 'accounts_changed']);

export class SlackLive {
  private readonly client: SlackClient;
  private readonly directory: SlackDirectory;
  private readonly history: SlackHistory;
  private readonly myId: string;
  private readonly roomNames: Map<string, string> | null;
  /** Rooms a message came from that `conversations.info` would not show: not asked again. */
  private readonly unreadable = new Set<string>();
  readonly channels = new Map<string, Doc>();
  readonly counts = new Map<string, Doc>();
  /** Presence pushed since the socket opened; the snapshot each connection setup hands over. */
  readonly presence = new Map<string, PresenceStatus>();
  /** The `ts` each room is marked read at, by me here or elsewhere: the actions never mark behind it. */
  readonly marks = new Map<string, string>();
  /** The `ts` of the message each room previews, when known: an edit or a deletion of it moves the preview. */
  readonly previews = new Map<string, string>();

  constructor(options: { client: SlackClient; directory: SlackDirectory; history: SlackHistory; myId: string; roomNames?: Map<string, string> }) {
    this.client = options.client;
    this.directory = options.directory;
    this.history = options.history;
    this.myId = options.myId;
    this.roomNames = options.roomNames ?? null;
  }

  /** The catch-up hands over each conversation and its `client.counts` entry. */
  remember(channel: Doc, counts: Doc | null): void {
    const rid = str(channel.id);
    if (rid === null) return;
    this.channels.set(rid, channel);
    if (counts !== null) this.counts.set(rid, counts);
  }

  forget(rid: string): void {
    this.channels.delete(rid);
    this.counts.delete(rid);
    this.previews.delete(rid);
  }

  /** Whose presence to follow: me and the people of my direct conversations. */
  presenceIds(): string[] {
    const ids = new Set([this.myId]);
    for (const channel of this.channels.values()) if (channel.is_im === true && typeof channel.user === 'string') ids.add(channel.user);
    return [...ids];
  }

  async expand(frame: Doc): Promise<DdpEvent[]> {
    const type = str(frame.type);
    if (type === null) return [];
    if (QUIET.has(type)) return [{ collection: SLACK_QUIET, eventKey: type, args: [] }];
    if (MARKED.has(type)) return this.marked(frame);
    if (JOINED.has(type)) return this.joined(str(frame.channel) ?? str(record(frame.channel)?.id));
    switch (type) {
      case 'message':
        return this.message(frame);
      case 'user_typing': {
        const channel = str(frame.channel);
        const user = str(frame.user);
        if (channel === null || user === null || user === this.myId) return [];
        await this.directory.ensure([user]);
        const username = this.directory.username(user) ?? user;
        return [{ collection: STREAM_NOTIFY_ROOM_TYPING, eventKey: `${channel}/user-activity`, args: [username, [TYPING_ACTIVITY]] }];
      }
      case 'presence_change':
        return this.presenceOf(Array.isArray(frame.users) ? frame.users : [frame.user], frame.presence);
      case 'manual_presence_change':
        return this.presenceOf([this.myId], frame.presence);
      case 'pin_added':
      case 'pin_removed':
        return this.pinned(frame, type === 'pin_added');
      case 'reaction_added':
      case 'reaction_removed': {
        const item = record(frame.item);
        const target = str(item?.channel);
        const ts = item?.ts;
        if (target === null || !isTimestamp(ts) || str(item?.type) !== 'message') return [];
        return this.refetch(target, ts);
      }
      case 'channel_created': {
        const channel = record(frame.channel);
        return str(channel?.creator) === this.myId ? this.joined(str(channel?.id)) : [];
      }
      case 'user_change': {
        const user = record(frame.user);
        const uid = str(user?.id);
        if (user === null || uid === null) return [];
        const parsed = toSlackUser(user);
        if (parsed !== null) this.directory.remember(parsed);
        const etag = str(record(user?.profile)?.avatar_hash);
        return etag === null ? [] : [{ collection: SLACK_AVATAR, eventKey: uid, args: [{ username: parsed?.username ?? uid, etag }] }];
      }
      default:
        return [{ collection: SLACK_QUIET, eventKey: type, args: [] }];
    }
  }

  private presenceOf(users: readonly unknown[], presence: unknown): DdpEvent[] {
    const code = PRESENCE_CODES.get(str(presence) ?? '');
    const status = PRESENCE_STATUS.get(str(presence) ?? '');
    if (code === undefined || status === undefined) return [];
    return users.flatMap((raw) => {
      const uid = str(raw);
      if (uid === null) return [];
      this.presence.set(uid, status);
      return [{ collection: STREAM_NOTIFY_LOGGED, eventKey: PRESENCE_EVENT, args: [[uid, this.directory.username(uid) ?? '', code, '']] }];
    });
  }

  /** The pinned message comes whole; its `pinned_to` is made to agree with the frame. */
  private async pinned(frame: Doc, on: boolean): Promise<DdpEvent[]> {
    const item = record(frame.item);
    const channel = str(frame.channel_id) ?? str(item?.channel);
    const message = record(item?.message);
    if (channel === null || message === null || !isTimestamp(message.ts) || str(item?.type) !== 'message') return [];
    const others = (Array.isArray(message.pinned_to) ? message.pinned_to : []).filter((c) => c !== channel);
    const doc = { ...message, channel, pinned_to: on ? [...others, channel] : others };
    const { users, bots } = SlackTranslator.people([doc]);
    await this.directory.ensure(users, bots);
    return [{ collection: SLACK_MESSAGE, eventKey: channel, args: [doc] }];
  }

  /** A new message, an edit, or a deletion; each one keeps the channel preview and unread live. */
  private async message(frame: Doc): Promise<DdpEvent[]> {
    const channel = str(frame.channel);
    if (channel === null) return [];
    const subtype = str(frame.subtype);
    if (subtype === 'message_deleted') {
      const deletedTs = frame.deleted_ts;
      if (!isTimestamp(deletedTs)) return [];
      return [{ collection: SLACK_MESSAGE_DELETED, eventKey: channel, args: [{ channel, ts: deletedTs }] }, ...(await this.previewAfterDelete(channel, deletedTs))];
    }
    // `message_replied` and the other hidden frames describe a message, never a new one.
    if (subtype !== 'message_changed' && (frame.hidden === true || subtype === 'message_replied')) return [];
    const nested = subtype === 'message_changed' ? record(frame.message) : frame;
    if (nested === null || !isTimestamp(nested.ts)) return [];
    const message: Doc = { ...nested, channel };
    const { users, bots } = SlackTranslator.people([message]);
    await this.directory.ensure(users, bots);
    const events: DdpEvent[] = [];
    if (!this.channels.has(channel) && !this.unreadable.has(channel)) {
      const found = await this.joined(channel).catch(() => null);
      if (found?.length === 0) this.unreadable.add(channel);
      events.push(...(found ?? []));
    }
    events.push({ collection: SLACK_MESSAGE, eventKey: channel, args: [message] });
    // An edit keeps the unread as it was, and the preview unless it is the one edited.
    if (subtype === 'message_changed') {
      if (!this.isPreview(channel, message)) return events;
      if (str(message.subtype) === 'tombstone') return [...events, ...(await this.previewAfterDelete(channel, exactTimestamp(message.ts)))];
      return [...events, ...compact([this.preview(channel, message)])];
    }
    // A reply only in its thread is no unread of the room, as Slack counts it.
    if (isTimestamp(message.thread_ts) && message.thread_ts !== message.ts && subtype !== 'thread_broadcast') {
      const mention = this.mentioned(channel, message);
      if (mention !== null) events.push(mention);
      return events;
    }
    const room = this.bump(channel, message);
    if (room !== null) events.push(room);
    const subscription = this.unread(channel, message);
    if (subscription !== null) events.push(subscription);
    return events;
  }

  /** A conversation I just opened, read and kept like a listed one: its document and counts. */
  async opened(rid: string): Promise<{ channel: Doc; counts: Doc } | null> {
    await this.joined(rid);
    const channel = this.channels.get(rid);
    return channel === undefined ? null : { channel, counts: this.counts.get(rid) ?? { id: rid } };
  }

  /** A conversation I just joined or opened, read whole so it lists like the others. */
  private async joined(rid: string | null): Promise<DdpEvent[]> {
    if (rid === null) return [];
    let channel: Doc | null;
    try {
      channel = record((await this.client.call('conversations.info', { channel: rid })).channel);
    } catch (e) {
      if (e instanceof SlackError && GONE.has(e.code)) return [];
      throw e;
    }
    if (channel === null || str(channel.id) !== rid || channel.is_archived === true || channel.is_member === false) return [];
    this.channels.set(rid, channel);
    const name = str(channel.name);
    if (name !== null && channel.is_im !== true) this.roomNames?.set(rid, name);
    if (channel.is_im === true && typeof channel.user === 'string') await this.directory.ensure([channel.user]);
    const counts = this.counts.get(rid) ?? { id: rid };
    this.counts.set(rid, counts);
    return [
      { collection: SLACK_ROOM, eventKey: rid, args: [{ channel, counts }] },
      { collection: SLACK_SUBSCRIPTION, eventKey: rid, args: [{ channel, counts }] },
    ];
  }

  /** The channel's preview and latest-ts, from the message just seen. */
  private bump(channel: string, message: Doc): DdpEvent | null {
    const doc = this.channels.get(channel);
    if (doc === undefined) return null;
    const ts = exactTimestamp(message.ts);
    const counts = { ...(this.counts.get(channel) ?? { id: channel }), latest: ts };
    this.counts.set(channel, counts);
    // A reply never becomes the room's preview; a root does.
    if (isReply(message)) return { collection: SLACK_ROOM, eventKey: channel, args: [{ channel: doc, counts }] };
    return this.preview(channel, message);
  }

  /** The room row with `message` as its preview, `null` for none. */
  private preview(channel: string, message: Doc | null): DdpEvent | null {
    const doc = this.channels.get(channel);
    if (doc === undefined) return null;
    if (message === null) this.previews.delete(channel);
    else this.previews.set(channel, String(message.ts));
    return { collection: SLACK_ROOM, eventKey: channel, args: [{ channel: doc, counts: this.counts.get(channel) ?? { id: channel }, lastMessage: message }] };
  }

  /** Whether a message is the room's preview: the one known, else a root at least as new as the room's latest. */
  private isPreview(channel: string, message: Doc): boolean {
    if (!isTimestamp(message.ts) || isReply(message)) return false;
    const known = this.previews.get(channel);
    if (known !== undefined) return known === message.ts;
    const latest = this.counts.get(channel)?.latest;
    return isTimestamp(latest) && compareTimestamp(message.ts, latest) >= 0;
  }

  /** The room's preview after its message went: the newest root message left, or none. */
  private async previewAfterDelete(channel: string, ts: string): Promise<DdpEvent[]> {
    if (!this.isPreview(channel, { ts })) return [];
    this.previews.delete(channel);
    let next: Doc | null;
    try {
      const { messages } = await this.history.history(channel, { limit: PREVIEW_LOOKBACK });
      next = messages.find((m) => m.ts !== ts && !isReply(m) && m.hidden !== true && !SKIPPED_PREVIEW.has(str(m.subtype) ?? '')) ?? null;
    } catch {
      return [];
    }
    if (this.previews.has(channel)) return [];
    return compact([this.preview(channel, next)]);
  }

  /** My read state after a message I did not send; my own message leaves it. */
  private unread(channel: string, message: Doc): DdpEvent | null {
    const doc = this.channels.get(channel);
    if (doc === undefined || str(message.user) === this.myId) return null;
    const previous = this.counts.get(channel) ?? { id: channel };
    const mentions = num(previous.mention_count) + (mentionsMe(message, this.myId) ? 1 : 0);
    const counts = { ...previous, has_unreads: true, mention_count: mentions };
    this.counts.set(channel, counts);
    return { collection: SLACK_SUBSCRIPTION, eventKey: channel, args: [{ channel: doc, counts }] };
  }

  /** A thread reply from someone else that names me: one more mention, the room's unread left alone. */
  private mentioned(channel: string, message: Doc): DdpEvent | null {
    const doc = this.channels.get(channel);
    if (doc === undefined || str(message.user) === this.myId || !mentionsMe(message, this.myId)) return null;
    const previous = this.counts.get(channel) ?? { id: channel };
    const counts = { ...previous, mention_count: num(previous.mention_count) + 1 };
    this.counts.set(channel, counts);
    return { collection: SLACK_SUBSCRIPTION, eventKey: channel, args: [{ channel: doc, counts }] };
  }

  /** A room read elsewhere: the frame's own unread/mention counts win. */
  private marked(frame: Doc): DdpEvent[] {
    const channel = str(frame.channel);
    if (channel !== null && isTimestamp(frame.ts)) this.marks.set(channel, frame.ts);
    const doc = channel === null ? undefined : this.channels.get(channel);
    if (channel === null || doc === undefined) return [];
    const previous = this.counts.get(channel) ?? { id: channel };
    const unread = num(frame.unread_count_display ?? frame.unread_count);
    const counts = {
      ...previous,
      has_unreads: unread > 0,
      mention_count: num(frame.mention_count_display ?? frame.mention_count),
      ...(isTimestamp(frame.ts) ? { last_read: frame.ts } : {}),
    };
    this.counts.set(channel, counts);
    return [{ collection: SLACK_SUBSCRIPTION, eventKey: channel, args: [{ channel: doc, counts }] }];
  }

  /** Re-reads one message after a reaction changed it, Slack sending no updated body. */
  async refetch(channel: string, ts: string): Promise<DdpEvent[]> {
    try {
      const message = await this.history.fetchAny(`${channel}:${ts}`);
      return message === null ? [] : [{ collection: SLACK_MESSAGE, eventKey: channel, args: [{ ...message, channel }] }];
    } catch (e) {
      if (e instanceof SlackError && (e.code === 'channel_not_found' || e.code === 'not_in_channel')) return [];
      throw e;
    }
  }
}

function isReply(message: Doc): boolean {
  return isTimestamp(message.thread_ts) && message.thread_ts !== message.ts;
}

function compact(events: (DdpEvent | null)[]): DdpEvent[] {
  return events.filter((e): e is DdpEvent => e !== null);
}

function mentionsMe(message: Doc, myId: string): boolean {
  const text = str(message.text);
  if (text === null) return false;
  if (text.includes(`<@${myId}>`) || text.includes('<!channel>') || text.includes('<!here>') || text.includes('<!everyone>')) return true;
  return false;
}

function record(value: unknown): Doc | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Doc) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
