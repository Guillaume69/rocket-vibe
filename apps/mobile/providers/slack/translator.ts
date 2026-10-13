/**
 * Slack documents to the app's neutral rows. A message's id is
 * `<channel>:<ts>` with `ts` Slack's exact decimal string; milliseconds are
 * for display and order only. Slack's messages do not carry their channel:
 * every reader stamps it on as `channel` before translating.
 */

import type { DdpEvent } from '../../lib/ddp.ts';
import type { LocalMessage, LocalRoom, LocalSubscription } from '../../lib/normalize.ts';
import type { Translation, Translator } from '../../lib/provider.ts';
import { isTimestamp, timestampMs } from './client.ts';
import type { SlackDirectory } from './directory.ts';

type Doc = Record<string, unknown>;

/** A conversation and, when read, its `client.counts` entry and newest message (`null`: none). */
export type SlackRoomDoc = { channel: Doc; counts?: Doc | null; lastMessage?: Doc | null };
export type SlackSubscriptionDoc = { channel: Doc; counts: Doc | null };

const SYSTEM: Record<string, { type: string; param: (raw: Doc, author: string | null) => string }> = {
  channel_join: { type: 'uj', param: (_r, a) => a ?? '' },
  group_join: { type: 'uj', param: (_r, a) => a ?? '' },
  channel_leave: { type: 'ul', param: (_r, a) => a ?? '' },
  group_leave: { type: 'ul', param: (_r, a) => a ?? '' },
  channel_topic: { type: 'room_changed_topic', param: (r) => str(r.topic) ?? '' },
  group_topic: { type: 'room_changed_topic', param: (r) => str(r.topic) ?? '' },
  channel_purpose: { type: 'room_changed_description', param: (r) => str(r.purpose) ?? '' },
  group_purpose: { type: 'room_changed_description', param: (r) => str(r.purpose) ?? '' },
};
/** Never shown: Slack's own edit and deletion envelopes, and removed messages. */
const SKIPPED = new Set(['tombstone', 'message_deleted', 'message_changed', 'message_replied']);

export function messageId(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

/** `<channel>:<ts>` back into its parts, or null when it is not a Slack id. */
export function parseMessageId(id: string): { channel: string; ts: string } | null {
  const at = id.indexOf(':');
  if (at <= 0) return null;
  const channel = id.slice(0, at), ts = id.slice(at + 1);
  return /^[CDG][A-Z0-9]+$/.test(channel) && isTimestamp(ts) ? { channel, ts } : null;
}

export function roomType(channel: Doc): 'c' | 'p' | 'd' {
  return channel.is_im === true || channel.is_mpim === true ? 'd' : channel.is_private === true ? 'p' : 'c';
}

/** The usernames a group DM's name lists (`mpdm-a--b--c-1`). */
export function mpimUsernames(name: string): string[] {
  const match = /^mpdm-(.+)-\d+$/.exec(name);
  return match === null ? [] : match[1]!.split('--').filter((n) => n !== '');
}

export type Resolver = {
  username(id: string): string | null;
  roomName(id: string): string | null;
};

/**
 * Slack's mrkdwn into the app's markdown. Code spans and blocks are left as
 * they are; everything else has its mentions, links, bold and strike
 * rewritten. Slack's three HTML entities are decoded last, code included.
 */
export function mrkdwnToMarkdown(input: string, resolve: Resolver): string {
  const parts = input.split(/(```[\s\S]*?```|`[^`\n]+`)/);
  return unescape(parts.map((part, i) => (i % 2 === 1 ? part : prose(part, resolve))).join(''));
}

function prose(text: string, resolve: Resolver): string {
  const tokens: string[] = [];
  const held = text.replace(/<([^<>\n]+)>/g, (_m, inner: string) => {
    tokens.push(reference(inner, resolve));
    return `${tokens.length - 1}`;
  });
  const formatted = held
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1**$2**')
    .replace(/(^|[^\w~])~(?=\S)([^~\n]*?\S)~(?![\w~])/g, '$1~~$2~~');
  return formatted.replace(/(\d+)/g, (_m, n: string) => tokens[Number(n)]!);
}

function reference(inner: string, resolve: Resolver): string {
  const bar = inner.indexOf('|');
  const target = bar < 0 ? inner : inner.slice(0, bar);
  const label = bar < 0 ? null : inner.slice(bar + 1);
  if (target.startsWith('@')) {
    const id = target.slice(1);
    return `@${resolve.username(id) ?? label?.replace(/^@/, '') ?? id}`;
  }
  if (target.startsWith('#')) {
    const id = target.slice(1);
    return `#${label || resolve.roomName(id) || id}`;
  }
  if (target.startsWith('!')) {
    const command = target.slice(1);
    if (command === 'here') return '@here';
    if (command === 'channel' || command === 'everyone') return '@all';
    if (command.startsWith('subteam^')) return `@${(label ?? command.slice(8)).replace(/^@/, '')}`;
    return label ?? command;
  }
  const url = target.replace(/\)/g, '%29');
  return label === null || label === '' ? url : `[${label.replace(/[[\]]/g, '\\$&')}](${url})`;
}

function unescape(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export class SlackTranslator implements Translator {
  private readonly directory: SlackDirectory;
  private readonly myId: string;
  private readonly resolver: Resolver;

  constructor(directory: SlackDirectory, myId: string, roomNames: ReadonlyMap<string, string> = new Map()) {
    this.directory = directory;
    this.myId = myId;
    this.resolver = { username: (id) => directory.username(id), roomName: (id) => roomNames.get(id) ?? null };
  }

  translateEvent(_event: DdpEvent): Translation {
    return { kind: 'ignore' };
  }

  toMessage(raw: Doc): LocalMessage | null {
    const channel = str(raw.channel);
    const ts = raw.ts;
    if (channel === null || !isTimestamp(ts)) return null;
    const subtype = str(raw.subtype) ?? '';
    if (raw.hidden === true || SKIPPED.has(subtype)) return null;
    const ms = timestampMs(ts);
    const userId = str(raw.user);
    const botId = str(raw.bot_id);
    const authorId = userId ?? botId ?? '';
    const authorName = userId !== null
      ? (this.directory.username(userId) ?? str(record(raw.user_profile)?.name) ?? userId)
      : (botId !== null ? this.directory.bot(botId) : null) ?? str(raw.username) ?? botId;
    const system = SYSTEM[subtype];
    const threadTs = isTimestamp(raw.thread_ts) ? raw.thread_ts : null;
    const reply = threadTs !== null && threadTs !== ts;
    const editedTs = record(raw.edited)?.ts;
    const editedAt = isTimestamp(editedTs) ? timestampMs(editedTs) : null;
    return {
      id: messageId(channel, ts),
      rid: channel,
      text: system !== undefined ? system.param(raw, authorName) : this.body(raw),
      ts: ms,
      authorId,
      authorName,
      systemType: system?.type ?? null,
      threadId: reply ? messageId(channel, threadTs) : null,
      threadCount: reply ? 0 : num(raw.reply_count),
      threadLast: !reply && isTimestamp(raw.latest_reply) ? timestampMs(raw.latest_reply) : null,
      threadShown: reply && subtype === 'thread_broadcast',
      editedAt,
      md: null,
      attachments: cards(raw.attachments),
      reactions: this.reactions(raw.reactions),
      urls: null,
      callId: null,
      encryptedRaw: null,
      pinned: false,
      starred: null,
      updatedAt: editedAt ?? ms,
    };
  }

  toRoom(raw: Doc): LocalRoom | null {
    const doc = raw as SlackRoomDoc;
    const channel = record(doc.channel);
    const rid = str(channel?.id);
    if (channel === null || rid === null) return null;
    const type = roomType(channel);
    const other = channel.is_im === true ? str(channel.user) : null;
    const otherName = other === null ? null : this.directory.username(other);
    const last = record(doc.lastMessage);
    const lastMessage = last === null ? null : this.toMessage({ ...last, channel: rid });
    const latest = latestMs(doc.counts);
    const updated = typeof channel.updated === 'number' && channel.updated > 0 ? channel.updated : num(channel.created) * 1000;
    return {
      rid,
      type,
      name: other !== null ? (otherName ?? other) : str(channel.name),
      displayName: this.label(channel, other),
      encrypted: false,
      readOnly: false,
      dmOtherUid: other,
      dmOtherUsername: otherName,
      lastMessage: lastMessage?.systemType === null ? lastMessage.text : null,
      lastMessageType: lastMessage?.systemType ?? null,
      lastMessageTs: lastMessage?.ts ?? latest,
      keepPreview: doc.lastMessage === undefined,
      avatarEtag: null,
      updatedAt: Math.max(updated, latest ?? 0, lastMessage?.ts ?? 0),
    };
  }

  toSubscription(raw: Doc): LocalSubscription | null {
    const doc = raw as SlackSubscriptionDoc;
    const channel = record(doc.channel);
    const rid = str(channel?.id);
    if (channel === null || rid === null) return null;
    const counts = record(doc.counts);
    const mentions = num(counts?.mention_count);
    const alert = counts?.has_unreads === true;
    const lastSeen = isTimestamp(counts?.last_read) ? timestampMs(counts.last_read) : 0;
    return {
      rid,
      subId: rid,
      unread: alert ? Math.max(1, mentions) : 0,
      mentions,
      groupMentions: 0,
      alert,
      open: true,
      favorite: false,
      lastSeen: lastSeen > 0 ? lastSeen : null,
      e2eKey: null,
      e2eKeyId: null,
      roles: null,
      groupId: null,
      groupName: null,
      groupRank: null,
      updatedAt: Math.max(lastSeen, latestMs(counts) ?? 0),
    };
  }

  private label(channel: Doc, other: string | null): string | null {
    if (other !== null) return this.directory.displayName(other) ?? other;
    const name = str(channel.name);
    if (channel.is_mpim !== true || name === null) return name;
    const me = this.directory.username(this.myId);
    const people = mpimUsernames(name).filter((u) => u !== me).map((u) => this.directory.nameOfUsername(u) ?? u);
    return people.length > 0 ? people.join(', ') : name;
  }

  private body(raw: Doc): string {
    const text = mrkdwnToMarkdown(str(raw.text) ?? '', this.resolver);
    const files = Array.isArray(raw.files)
      ? raw.files.flatMap((f) => str(record(f)?.name) ?? str(record(f)?.title) ?? [])
      : [];
    if (files.length === 0) return text;
    const line = `📎 ${files.join(', ')}`;
    return text === '' ? line : `${text}\n${line}`;
  }

  private reactions(raw: unknown): string | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const grouped: Record<string, { usernames: string[] }> = {};
    for (const item of raw) {
      const reaction = record(item);
      const name = str(reaction?.name);
      if (reaction === null || name === null || !Array.isArray(reaction.users)) continue;
      const users = reaction.users.flatMap((id) => (typeof id === 'string' ? [this.directory.username(id) ?? id] : []));
      if (users.length > 0) grouped[`:${name}:`] = { usernames: users };
    }
    return Object.keys(grouped).length === 0 ? null : JSON.stringify(grouped);
  }

  /** Every person a batch of messages names, and every bot: what `SlackDirectory.ensure` needs first. */
  static people(messages: readonly Doc[]): { users: string[]; bots: string[] } {
    const users = new Set<string>(), bots = new Set<string>();
    for (const m of messages) {
      if (typeof m.user === 'string') users.add(m.user);
      if (typeof m.bot_id === 'string' && typeof m.user !== 'string') bots.add(m.bot_id);
      if (typeof m.text === 'string') for (const match of m.text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) users.add(match[1]!);
      if (Array.isArray(m.reactions)) {
        for (const r of m.reactions) {
          const list = record(r)?.users;
          if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') users.add(id);
        }
      }
    }
    return { users: [...users], bots: [...bots] };
  }
}

function latestMs(counts: unknown): number | null {
  const latest = record(counts)?.latest;
  return isTimestamp(latest) ? timestampMs(latest) : null;
}

/** Legacy message attachments, in the card shape Rocket.Chat's attachments already render. */
function cards(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.flatMap((item) => {
    const a = record(item);
    if (a === null) return [];
    const card: Doc = {};
    for (const key of ['author_name', 'title', 'color', 'fields']) if (a[key] !== undefined) card[key] = a[key];
    if (typeof a.title_link === 'string' && a.title_link.startsWith('https://')) card.title_link = a.title_link;
    const text = str(a.text) ?? str(a.pretext) ?? str(a.fallback);
    if (text !== null) card.text = text;
    return Object.keys(card).length > 0 ? [card] : [];
  });
  return out.length === 0 ? null : JSON.stringify(out);
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
