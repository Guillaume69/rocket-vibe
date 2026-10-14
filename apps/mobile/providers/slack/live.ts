/**
 * One Slack RTM frame into the neutral `slack:*` envelopes the translator
 * reads, after the asynchronous part (unknown authors, a reaction's message).
 *
 * Slack pushes no conversation or read document when a message arrives: the
 * channel docs and the per-room counts are kept here, seeded by the catch-up,
 * and the unread state is derived locally. The `*_marked` frames carry
 * authoritative counts and overwrite it.
 */

import type { DdpEvent } from '../../lib/ddp.ts';
import { PRESENCE_EVENT, STREAM_NOTIFY_LOGGED } from '../../lib/presence.ts';
import { STREAM_NOTIFY_ROOM_TYPING, TYPING_ACTIVITY } from '../../lib/typing.ts';
import { SlackError, exactTimestamp, isTimestamp } from './client.ts';
import type { SlackClient } from './client.ts';
import type { SlackDirectory } from './directory.ts';
import type { SlackHistory } from './history.ts';
import { SLACK_AVATAR, SLACK_MESSAGE, SLACK_MESSAGE_DELETED, SLACK_QUIET, SLACK_ROOM, SLACK_SUBSCRIPTION, SlackTranslator } from './translator.ts';
import { toSlackUser } from './directory.ts';

type Doc = Record<string, unknown>;

/** Slack presence strings onto the numbers the presence engine reads. */
const PRESENCE_CODES = new Map<string, number>([
  ['active', 1],
  ['away', 0],
]);

const MARKED = new Set(['channel_marked', 'group_marked', 'im_marked', 'mpim_marked']);
const QUIET = new Set(['hello', 'pong', 'reconnect_url', 'pref_change', 'dnd_updated', 'dnd_updated_user', 'accounts_changed']);

export class SlackLive {
  private readonly client: SlackClient;
  private readonly directory: SlackDirectory;
  private readonly history: SlackHistory;
  private readonly myId: string;
  readonly channels = new Map<string, Doc>();
  readonly counts = new Map<string, Doc>();

  constructor(options: { client: SlackClient; directory: SlackDirectory; history: SlackHistory; myId: string }) {
    this.client = options.client;
    this.directory = options.directory;
    this.history = options.history;
    this.myId = options.myId;
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
  }

  async expand(frame: Doc): Promise<DdpEvent[]> {
    const type = str(frame.type);
    if (type === null) return [];
    if (QUIET.has(type)) return [{ collection: SLACK_QUIET, eventKey: type, args: [] }];
    if (MARKED.has(type)) return this.marked(frame);
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
      case 'presence_change': {
        const code = PRESENCE_CODES.get(str(frame.presence) ?? '');
        if (code === undefined) return [];
        const ids = Array.isArray(frame.users) ? frame.users : str(frame.user) !== null ? [frame.user] : [];
        return ids.flatMap((raw) => {
          const uid = str(raw);
          return uid === null ? [] : [{ collection: STREAM_NOTIFY_LOGGED, eventKey: PRESENCE_EVENT, args: [[uid, this.directory.username(uid) ?? '', code, '']] }];
        });
      }
      case 'reaction_added':
      case 'reaction_removed': {
        const item = record(frame.item);
        const target = str(item?.channel);
        const ts = item?.ts;
        if (target === null || !isTimestamp(ts) || str(item?.type) !== 'message') return [];
        return this.refetch(target, ts);
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

  /** A new message, an edit, or a deletion; each one keeps the channel preview and unread live. */
  private async message(frame: Doc): Promise<DdpEvent[]> {
    const channel = str(frame.channel);
    if (channel === null) return [];
    const subtype = str(frame.subtype);
    if (subtype === 'message_deleted') {
      const deletedTs = frame.deleted_ts;
      return isTimestamp(deletedTs) ? [{ collection: SLACK_MESSAGE_DELETED, eventKey: channel, args: [{ channel, ts: deletedTs }] }] : [];
    }
    const nested = subtype === 'message_changed' ? record(frame.message) : frame;
    if (nested === null || !isTimestamp(nested.ts)) return [];
    const message = { ...nested, channel };
    const { users, bots } = SlackTranslator.people([message]);
    await this.directory.ensure(users, bots);
    const events: DdpEvent[] = [{ collection: SLACK_MESSAGE, eventKey: channel, args: [message] }];
    // An edit keeps the preview and unread as they were; only a fresh message moves them.
    if (subtype === 'message_changed') return events;
    const room = this.bump(channel, message);
    if (room !== null) events.push(room);
    const subscription = this.unread(channel, message);
    if (subscription !== null) events.push(subscription);
    return events;
  }

  /** The channel's preview and latest-ts, from the message just seen. */
  private bump(channel: string, message: Doc): DdpEvent | null {
    const doc = this.channels.get(channel);
    if (doc === undefined) return null;
    const ts = exactTimestamp(message.ts);
    const counts = { ...(this.counts.get(channel) ?? { id: channel }), latest: ts };
    this.counts.set(channel, counts);
    // A reply never becomes the room's preview; a root does.
    const reply = isTimestamp(message.thread_ts) && message.thread_ts !== message.ts;
    return { collection: SLACK_ROOM, eventKey: channel, args: [{ channel: doc, counts, ...(reply ? {} : { lastMessage: message }) }] };
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

  /** A room read elsewhere: the frame's own unread/mention counts win. */
  private marked(frame: Doc): DdpEvent[] {
    const channel = str(frame.channel);
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
      const message = await this.history.fetch(`${channel}:${ts}`);
      return message === null ? [] : [{ collection: SLACK_MESSAGE, eventKey: channel, args: [{ ...message, channel }] }];
    } catch (e) {
      if (e instanceof SlackError && (e.code === 'channel_not_found' || e.code === 'not_in_channel')) return [];
      throw e;
    }
  }
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
