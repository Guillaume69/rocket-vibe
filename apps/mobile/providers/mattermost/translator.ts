/**
 * Mattermost wire documents to the app's neutral rows. The sub-fields the UI
 * reads as serialized JSON (`reactions`, `attachments`, `urls`) are produced
 * in the shape the renderer already knows, so nothing downstream branches on
 * the server.
 *
 * The listener (`live.ts`) hands this translator its own `mm:*` envelopes,
 * already enriched (users known, counters computed): translation stays
 * synchronous, as `Translator` requires.
 */

import type { DdpEvent } from '../../lib/ddp.ts';
import type { Translation, Translator } from '../../lib/provider.ts';
import type { LocalMessage, LocalRoom, LocalSubscription } from '../../lib/normalize.ts';
import type { MmCategories } from './categories.ts';
import { sameOrigin } from '../../lib/origin.ts';
import type { MmDirectory } from './directory.ts';

export const MM_POST = 'mm:post';
export const MM_POST_DELETED = 'mm:post-deleted';
export const MM_ROOM = 'mm:room';
export const MM_ROOM_DELETED = 'mm:room-deleted';
export const MM_MEMBERSHIP = 'mm:membership';
export const MM_AVATAR = 'mm:avatar';
export const MM_QUIET = 'mm:quiet';

/** A channel and, when known, its newest root post: what the room list shows. */
export type MmRoomDoc = { channel: Record<string, unknown>; lastPost?: Record<string, unknown> | null };
/** A channel and MY membership of it: unread and mention counters live there. */
export type MmMembershipDoc = { channel: Record<string, unknown>; member: Record<string, unknown> };

const ROOM_TYPES: Record<string, string> = { O: 'c', P: 'p', D: 'd', G: 'd' };

/** Mattermost system post types onto the ones `lib/systemMessages.ts` renders. */
const SYSTEM_TYPES: Record<string, { type: string; param: (props: Record<string, unknown>, author: string | null) => string | null }> = {
  system_join_channel: { type: 'uj', param: (p, a) => str(p.username) ?? a },
  system_join_team: { type: 'uj', param: (p, a) => str(p.username) ?? a },
  system_leave_channel: { type: 'ul', param: (p, a) => str(p.username) ?? a },
  system_leave_team: { type: 'ul', param: (p, a) => str(p.username) ?? a },
  system_add_to_channel: { type: 'au', param: (p) => str(p.addedUsername) },
  system_add_to_team: { type: 'au', param: (p) => str(p.addedUsername) },
  system_remove_from_channel: { type: 'ru', param: (p) => str(p.removedUsername) },
  system_remove_from_team: { type: 'ru', param: (p) => str(p.removedUsername) },
  system_header_change: { type: 'room_changed_topic', param: (p) => str(p.new_header) ?? '' },
  system_purpose_change: { type: 'room_changed_description', param: (p) => str(p.new_purpose) ?? '' },
  system_displayname_change: { type: 'r', param: (p) => str(p.new_displayname) },
};

export class MmTranslator implements Translator {
  private readonly directory: MmDirectory;
  private readonly myId: string;
  private readonly categories: MmCategories | null;
  private readonly fileBase: string;

  constructor(directory: MmDirectory, myId: string, categories: MmCategories | null = null, fileBase = '/api/v4/files') {
    this.directory = directory;
    this.myId = myId;
    this.categories = categories;
    this.fileBase = fileBase;
  }

  translateEvent(event: DdpEvent): Translation {
    const doc = record(event.args[0]);
    switch (event.collection) {
      case MM_POST: {
        if (doc === null) return IGNORE;
        if (num(doc.delete_at) > 0) return deleted(str(doc.id));
        const message = this.toMessage(doc);
        return message === null ? IGNORE : change({ type: 'message', doc: message });
      }
      case MM_POST_DELETED:
        return deleted(str(doc?.id));
      case MM_ROOM: {
        const room = doc === null ? null : this.toRoom(doc);
        return room === null ? IGNORE : change({ type: 'room', doc: room });
      }
      case MM_ROOM_DELETED: {
        const rid = str(doc?.channel_id);
        return rid === null ? IGNORE : change({ type: 'room-deleted', rid });
      }
      case MM_MEMBERSHIP: {
        const subscription = doc === null ? null : this.toSubscription(doc);
        return subscription === null ? IGNORE : change({ type: 'subscription', doc: subscription });
      }
      case MM_AVATAR: {
        const username = str(doc?.username);
        const etag = str(doc?.etag);
        return username === null || etag === null
          ? IGNORE
          : change({ type: 'avatar', username, rid: null, etag });
      }
      case MM_QUIET:
        return SILENCE;
      default:
        return IGNORE;
    }
  }

  toMessage(raw: Record<string, unknown>): LocalMessage | null {
    const id = str(raw.id);
    const rid = str(raw.channel_id);
    const ts = positive(raw.create_at);
    const authorId = str(raw.user_id);
    if (id === null || rid === null || ts === null || authorId === null) return null;
    if (num(raw.delete_at) > 0) return null;
    const props = record(raw.props) ?? {};
    const author = this.directory.user(authorId);
    const authorName = str(props.override_username) ?? author?.username ?? null;
    const mmType = str(raw.type) ?? '';
    const system = SYSTEM_TYPES[mmType];
    const metadata = record(raw.metadata) ?? {};
    const rootId = str(raw.root_id);
    const call = mmType === 'custom_call' ? kmeetCall(props) : null;
    return {
      id,
      rid,
      text: call !== null ? call.param : system === undefined ? (str(raw.message) ?? '') : system.param(props, author?.username ?? null),
      ts,
      authorId,
      authorName,
      systemType: call?.type ?? system?.type ?? null,
      threadId: rootId,
      threadCount: rootId === null ? num(raw.reply_count) : 0,
      threadLast: rootId === null ? positive(raw.last_reply_at) : null,
      threadShown: false,
      editedAt: positive(raw.edit_at),
      md: null,
      attachments: this.attachments(metadata.files),
      reactions: this.reactions(metadata.reactions),
      urls: previews(metadata.embeds),
      callId: call?.joinUrl ?? null,
      encryptedRaw: null,
      pinned: raw.is_pinned === true,
      starred: null,
      updatedAt: positive(raw.update_at) ?? ts,
    };
  }

  toRoom(raw: Record<string, unknown>): LocalRoom | null {
    const doc = raw as MmRoomDoc;
    const channel = record(doc.channel);
    if (channel === null) return null;
    const rid = str(channel.id);
    const mmType = str(channel.type);
    const type = mmType === null ? undefined : ROOM_TYPES[mmType];
    if (rid === null || type === undefined) return null;
    const other = mmType === 'D' ? this.dmOther(str(channel.name)) : null;
    const otherUser = other === null ? null : this.directory.user(other);
    const last = record(doc.lastPost);
    const lastMessage = last === null ? null : this.toMessage(last);
    const lastPostAt = positive(channel.last_root_post_at) ?? positive(channel.last_post_at);
    return {
      rid,
      type,
      name: mmType === 'D' ? (otherUser?.username ?? null) : str(channel.name),
      displayName: this.channelLabel(channel, mmType, otherUser?.displayName ?? otherUser?.username ?? null),
      encrypted: false,
      readOnly: false,
      dmOtherUid: other,
      dmOtherUsername: otherUser?.username ?? null,
      lastMessage: lastMessage?.systemType === null ? lastMessage.text : null,
      lastMessageType: lastMessage?.systemType ?? null,
      lastMessageTs: lastMessage?.ts ?? lastPostAt,
      keepPreview: doc.lastPost === undefined,
      avatarEtag: null,
      updatedAt: Math.max(positive(channel.update_at) ?? 0, lastPostAt ?? 0),
    };
  }

  toSubscription(raw: Record<string, unknown>): LocalSubscription | null {
    const doc = raw as MmMembershipDoc;
    const channel = record(doc.channel);
    const member = record(doc.member);
    const rid = str(member?.channel_id) ?? str(channel?.id);
    if (channel === null || member === null || rid === null) return null;
    const { unread, mentions } = membershipCounts(channel, member);
    const roles = (str(member.roles) ?? '').split(/\s+/);
    const placement = this.categories?.placement(rid);
    return {
      rid,
      subId: rid,
      unread,
      mentions,
      groupMentions: 0,
      alert: unread > 0,
      open: this.categories?.sidebar.isListed(channel, unread) ?? true,
      favorite: placement?.favorite ?? false,
      lastSeen: positive(member.last_viewed_at),
      e2eKey: null,
      e2eKeyId: null,
      roles: roles.includes('channel_admin') ? JSON.stringify(['owner']) : null,
      groupId: placement?.groupId ?? null,
      groupName: placement?.groupName ?? null,
      groupRank: placement?.rank ?? null,
      updatedAt: Math.max(positive(member.last_update_at) ?? 0, positive(channel.update_at) ?? 0),
    };
  }

  /** `<idA>__<idB>`: the id that is not mine, or mine for a note-to-self. */
  dmOther(name: string | null): string | null {
    if (name === null) return null;
    const ids = name.split('__').filter((p) => p !== '');
    if (ids.length !== 2) return null;
    return ids.find((p) => p !== this.myId) ?? this.myId;
  }

  private channelLabel(channel: Record<string, unknown>, mmType: string | null, dmName: string | null): string | null {
    if (mmType === 'D') return dmName;
    const display = str(channel.display_name);
    if (mmType !== 'G' || display === null) return display ?? str(channel.name);
    const me = this.directory.username(this.myId);
    const others = display.split(',').map((n) => n.trim()).filter((n) => n !== '' && n !== me);
    const named = others.map((n) => this.directory.nameOf(n) ?? n);
    return named.length > 0 ? named.join(', ') : display;
  }

  private reactions(raw: unknown): string | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const grouped: Record<string, { usernames: string[] }> = {};
    for (const item of raw) {
      const reaction = record(item);
      const emoji = str(reaction?.emoji_name);
      const userId = str(reaction?.user_id);
      if (emoji === null || userId === null) continue;
      const key = `:${emoji}:`;
      const bucket = (grouped[key] ??= { usernames: [] });
      bucket.usernames.push(this.directory.username(userId) ?? userId);
    }
    return Object.keys(grouped).length === 0 ? null : JSON.stringify(grouped);
  }

  private attachments(raw: unknown): string | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const out: Record<string, unknown>[] = [];
    for (const item of raw) {
      const file = record(item);
      const id = str(file?.id);
      if (file === null || id === null) continue;
      const name = str(file.name) ?? id;
      const mime = str(file.mime_type) ?? 'application/octet-stream';
      const link = `${this.fileBase}/${id}`;
      const attachment: Record<string, unknown> = { title: name, title_link: link, type: 'file', size: num(file.size) };
      if (mime.startsWith('image/')) {
        attachment.image_url = file.has_preview_image === true ? `${link}/preview` : link;
        attachment.image_type = mime;
        attachment.image_size = num(file.size);
        const width = num(file.width);
        const height = num(file.height);
        if (width > 0 && height > 0) attachment.image_dimensions = { width, height };
      } else if (mime.startsWith('video/')) {
        attachment.video_url = link;
        attachment.video_type = mime;
        attachment.video_size = num(file.size);
      } else if (mime.startsWith('audio/')) {
        attachment.audio_url = link;
        attachment.audio_type = mime;
        attachment.audio_size = num(file.size);
      }
      out.push(attachment);
    }
    return out.length === 0 ? null : JSON.stringify(out);
  }
}

/**
 * Unread ROOT posts (replies live in threads, as on the screen) and mentions of
 * one membership. Servers without the root counters fall back on the totals.
 */
export function membershipCounts(channel: Record<string, unknown>, member: Record<string, unknown>): { unread: number; mentions: number } {
  const rootTotal = channel.total_msg_count_root;
  const useRoot = typeof rootTotal === 'number' && typeof member.msg_count_root === 'number';
  const unread = useRoot
    ? num(rootTotal) - num(member.msg_count_root)
    : num(channel.total_msg_count) - num(member.msg_count);
  // Mattermost counts every message of a DM as a mention; the list shows a DM's unread count instead.
  return { unread: Math.max(0, unread), mentions: channel.type === 'D' ? 0 : num(member.mention_count) };
}

/** Mattermost OpenGraph embeds to the `urls` shape `lib/linkPreview.ts` reads. */
function previews(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const urls: Record<string, unknown>[] = [];
  for (const item of raw) {
    const embed = record(item);
    const url = str(embed?.url);
    if (embed === null || url === null || embed.type !== 'opengraph') continue;
    const data = record(embed.data) ?? {};
    const image = Array.isArray(data.images) ? record(data.images[0]) : null;
    const meta: Record<string, unknown> = {};
    if (str(data.title) !== null) meta.ogTitle = str(data.title);
    if (str(data.description) !== null) meta.ogDescription = str(data.description);
    const imageUrl = str(image?.secure_url) ?? str(image?.url);
    if (imageUrl !== null) meta.ogImage = imageUrl;
    if (str(data.site_name) !== null) meta.ogSiteName = str(data.site_name);
    urls.push({ url, meta });
  }
  return urls.length === 0 ? null : JSON.stringify(urls);
}

const IGNORE: Translation = { kind: 'ignore' };
const SILENCE: Translation = { kind: 'silence' };

function change(c: Extract<Translation, { kind: 'change' }>['change']): Translation {
  return { kind: 'change', change: c };
}

function deleted(id: string | null): Translation {
  return id === null ? IGNORE : change({ type: 'message-deleted', id });
}

/** kChat sends nested payloads as objects, upstream Mattermost as JSON strings: accept both. */
export function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function positive(value: unknown): number | null {
  const n = num(value);
  return n > 0 ? n : null;
}

const CALL_OVER = new Set(['ended', 'missed', 'declined', 'cancelled']);

/** Any room member can post a `custom_call`: only kMeet's own origin is ever opened. */
export const KMEET_ORIGIN = 'https://kmeet.infomaniak.com';

export function isKmeetUrl(url: string): boolean {
  return sameOrigin(url, KMEET_ORIGIN);
}

/**
 * kChat's kMeet call post (`custom_call`): `props.url` is the meeting, joined
 * as is. A running call is a `videoconf` whose `callId` is that URL; one that
 * is over is a `videoconf-ended` carrying its length in seconds, when known.
 */
export function kmeetCall(props: Record<string, unknown>): { type: string; param: string; joinUrl: string | null } {
  const start = positive(props.start_at);
  const end = positive(props.end_at);
  if (end !== null || CALL_OVER.has(str(props.status) ?? '')) {
    const seconds = start !== null && end !== null && end >= start ? Math.round((end - start) / 1000) : null;
    return { type: 'videoconf-ended', param: seconds === null ? '' : String(seconds), joinUrl: null };
  }
  const url = str(props.url);
  return { type: 'videoconf', param: '', joinUrl: url !== null && isKmeetUrl(url) ? url : null };
}
