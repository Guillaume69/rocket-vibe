/**
 * The WhatsApp engine's frames projected into the account's database, the
 * rows every screen already reads: a room and a subscription per chat, the
 * messages with their authors' names and reactions. The engine keeps the
 * truth (its sealed cache) and replays it whole on demand; this side keeps
 * what a row needs in memory and writes the rows that changed, coalesced,
 * one transaction per burst. Mirrors `rv-core/src/whatsapp.rs` (`Snapshot`).
 */

import { shortcodeOfUnicode } from '@rocket-vibe/provider-api/emojis';
import { filePath, photoVersion } from './paths.ts';
import type { LocalMessage, LocalRoom, LocalSubscription } from '@rocket-vibe/provider-api/rows';
import type { Store } from '@rocket-vibe/provider-api/sync';
import { FATAL_ERRORS, fallbackName, isGroup, type WaFrame, type WaMessage } from './frames.ts';

/** The words the rows need, in the reader's language. */
export type WaLabels = {
  me: string;
  deleted: string;
  /** What a group is called in a search result. */
  group: string;
  /** An attachment's label: `image`, `voice`, `document`… */
  kind(kind: string): string;
};

/** What the account screens and the link sheet watch. */
export type WaStatus = {
  /** The engine's `status` (`loaded`, `connecting`, `connected`, `qr_expired`, `logged_out`…), `error` after a fatal error. */
  state: string;
  qr: string | null;
  pairingCode: string | null;
  /** The last error code, fatal or not. */
  error: string | null;
  /** The linked account, once WhatsApp named it. */
  account: { jid: string; name: string } | null;
  /** The id of the last send WhatsApp refused (it never left). */
  refused: string | null;
};

type Writer = Pick<Store, 'transaction' | 'listKnownRids' | 'purgeMissingRooms' | 'saveIdentity'>;
type Me = { userId: string; username: string };

export const INITIAL_STATUS: WaStatus = { state: 'loading', qr: null, pairingCode: null, error: null, account: null, refused: null };

/** The status after a frame, or null when the frame does not touch it. */
export function nextStatus(status: WaStatus, frame: WaFrame): WaStatus | null {
  switch (frame.type) {
    case 'status': return { ...status, state: frame.state, ...(frame.state === 'connected' ? { qr: null, pairingCode: null } : {}) };
    case 'qr': return { ...status, qr: frame.code };
    case 'pairing_code': return { ...status, pairingCode: frame.code, error: null };
    case 'account': return { ...status, account: { jid: frame.jid, name: frame.name ?? '' } };
    case 'error':
      if (frame.id !== undefined) return { ...status, refused: frame.id, error: frame.code };
      if (FATAL_ERRORS.has(frame.code)) return { ...status, state: 'error', qr: null, error: frame.code };
      return { ...status, error: frame.code };
    default: return null;
  }
}

const newer = (a: WaMessage, b: WaMessage) => a.ts > b.ts || (a.ts === b.ts && a.id > b.id);

export class WhatsAppProjection {
  status: WaStatus = INITIAL_STATUS;
  private readonly messages = new Map<string, WaMessage>();
  /** Message id → sender → glyph. */
  private readonly reactions = new Map<string, Map<string, string>>();
  private readonly names = new Map<string, string>();
  private readonly unread = new Map<string, number>();
  /** Chat → its newest message. */
  private readonly last = new Map<string, WaMessage>();
  /** JID → the version of its photo (`lib/whatsappFiles.ts`), `none` once removed. */
  private readonly photos = new Map<string, string>();
  private readonly dirtyPeople = new Set<string>();
  /** Chats opened before their first message, listed from then. */
  private readonly started = new Map<string, number>();
  /** The name each sender gave themselves (push name), for people the names table does not know. */
  private readonly authors = new Map<string, string>();
  private readonly dirtyMessages = new Set<string>();
  private readonly dirtyRooms = new Set<string>();
  private readonly dirtySubscriptions = new Set<string>();
  /** A replay in progress: the chats it brought back, and those the database had before. */
  private replay: { seen: Set<string>; known: Promise<string[]> } | null = null;
  private purge: { seen: string[]; known: Promise<string[]> } | null = null;
  private readonly listeners = new Set<() => void>();
  private clock = 0;
  private scheduled = false;
  private writing: Promise<void> = Promise.resolve();

  private readonly store: Writer;
  private readonly me: Me;
  private readonly labels: WaLabels;
  private readonly schedule: (flush: () => void) => void;

  constructor(store: Writer, me: Me, labels: WaLabels, schedule: (flush: () => void) => void = (flush) => { setTimeout(flush, 60); }) {
    this.store = store;
    this.me = me;
    this.labels = labels;
    this.schedule = schedule;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Chats with something unread, for the account's dot in the rail. */
  unreadChats(): number {
    return this.unread.size;
  }

  /** The stored message of an id, for the actions that need its chat. */
  message(id: string): WaMessage | undefined {
    return this.messages.get(id);
  }

  apply(frame: WaFrame): void {
    switch (frame.type) {
      case 'message': return this.onMessage(frame.message);
      case 'names': return this.onNames(frame.names ?? {});
      case 'reaction': {
        const { message, sender, emoji } = frame.reaction;
        const by = this.reactions.get(message) ?? new Map<string, string>();
        if (emoji === '') by.delete(sender); else by.set(sender, emoji);
        if (by.size === 0) this.reactions.delete(message); else this.reactions.set(message, by);
        if (this.messages.has(message)) this.mark(this.dirtyMessages, message);
        return;
      }
      case 'avatar': {
        const version = photoVersion(frame.data ?? '');
        if (this.photos.get(frame.jid) === version) return;
        this.photos.set(frame.jid, version);
        if (this.last.has(frame.jid)) this.mark(this.dirtyRooms, frame.jid);
        if (!isGroup(frame.jid)) this.mark(this.dirtyPeople, frame.jid);
        return;
      }
      case 'chat': {
        const unread = frame.unread ?? 0;
        if (unread > 0) this.unread.set(frame.jid, unread); else this.unread.delete(frame.jid);
        this.mark(this.dirtySubscriptions, frame.jid);
        return this.changed();
      }
      case 'reload': {
        // Everything comes again: what does not is gone from WhatsApp's side.
        for (const chat of this.unread.keys()) this.mark(this.dirtySubscriptions, chat);
        this.messages.clear(); this.reactions.clear(); this.last.clear(); this.unread.clear();
        this.replay = { seen: new Set(), known: this.store.listKnownRids() };
        return this.changed();
      }
      case 'replayed': {
        if (this.replay !== null) {
          this.purge = { seen: [...this.replay.seen], known: this.replay.known };
          this.replay = null;
          this.request();
        }
        return;
      }
      default: {
        // sent (the message frame says it), avatar, typing, file, found: elsewhere or later.
        const status = nextStatus(this.status, frame);
        if (status === null) return;
        this.status = status;
        return this.changed();
      }
    }
  }

  /**
   * A chat opened before its first message (a new conversation): listed now,
   * so its screen has a room to show; resolves once it is written.
   */
  startChat(jid: string, name?: string): Promise<void> {
    if (name && !this.names.has(jid) && name !== fallbackName(jid)) this.names.set(jid, name);
    if (!this.last.has(jid) && !this.started.has(jid)) this.started.set(jid, Date.now());
    this.mark(this.dirtyRooms, jid);
    this.mark(this.dirtySubscriptions, jid);
    return this.flush();
  }

  /** Writes what changed now; resolves once it is in the database. */
  flush(): Promise<void> {
    this.writing = this.writing.then(() => this.write()).catch(() => {});
    return this.writing;
  }

  private onMessage(m: WaMessage): void {
    this.messages.set(m.id, m);
    // Each sender's row in `users` names them in the timeline: written once a
    // session, and again when their name changes, photo or not.
    if (!m.mine && m.sender !== '' && !isGroup(m.sender) && (!this.authors.has(m.sender) || (m.author && this.authors.get(m.sender) !== m.author))) {
      this.authors.set(m.sender, m.author || this.authors.get(m.sender) || '');
      this.mark(this.dirtyPeople, m.sender);
    }
    this.mark(this.dirtyMessages, m.id);
    const last = this.last.get(m.chat);
    if (last === undefined || last.id === m.id || newer(m, last)) {
      this.last.set(m.chat, m);
      this.mark(this.dirtyRooms, m.chat);
      this.mark(this.dirtySubscriptions, m.chat);
    }
    this.replay?.seen.add(m.chat);
  }

  private onNames(names: Record<string, string>): void {
    const changed = new Set<string>();
    for (const [jid, name] of Object.entries(names)) {
      if (this.names.get(jid) === name) continue;
      this.names.set(jid, name);
      changed.add(jid);
    }
    if (changed.size === 0) return;
    for (const chat of this.last.keys()) if (changed.has(chat)) this.mark(this.dirtyRooms, chat);
    for (const jid of changed) if ((this.photos.has(jid) || this.authors.has(jid)) && !isGroup(jid)) this.mark(this.dirtyPeople, jid);
    for (const m of this.messages.values()) if (!m.mine && changed.has(m.sender)) this.mark(this.dirtyMessages, m.id);
    // Their reactions name them too.
    for (const [id, by] of this.reactions) if ([...by.keys()].some((sender) => changed.has(sender))) this.mark(this.dirtyMessages, id);
  }

  private mark(set: Set<string>, key: string): void {
    set.add(key);
    this.request();
  }

  private request(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => { this.scheduled = false; void this.flush(); });
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private async write(): Promise<void> {
    const messages = [...this.dirtyMessages].map((id) => this.messages.get(id)).filter((m) => m !== undefined);
    const listed = (chat: string) => this.last.has(chat) || this.started.has(chat);
    const rooms = [...this.dirtyRooms].filter(listed);
    const subscriptions = [...this.dirtySubscriptions];
    const people = [...this.dirtyPeople];
    this.dirtyMessages.clear(); this.dirtyRooms.clear(); this.dirtySubscriptions.clear(); this.dirtyPeople.clear();
    const purge = this.purge;
    this.purge = null;
    if (messages.length + rooms.length + subscriptions.length > 0) {
      await this.store.transaction(async (tx) => {
        // Rooms first: a message or a subscription of a room the list has not got is not shown.
        for (const chat of rooms) await tx.upsertRoom(this.roomRow(chat));
        for (const chat of subscriptions) if (listed(chat)) await tx.upsertSubscription(this.subscriptionRow(chat));
        for (const m of messages) await tx.upsertMessage(this.messageRow(m));
      });
    }
    // People's photos live in `users` (by uid), where avatars are looked up.
    // The timeline names an author by that row's username: it is the name.
    for (const jid of people) {
      const mine = jid === this.me.userId;
      await this.store.saveIdentity({ uid: jid, username: mine ? this.me.username : this.name(jid, this.authors.get(jid)),
        avatarEtag: this.photos.get(jid) ?? null, name: null });
    }
    // An empty replay purges nothing (the store refuses it as well).
    if (purge !== null && purge.seen.length > 0) await this.store.purgeMissingRooms(purge.seen, await purge.known);
  }

  /** Every write is newer than the last, or the store's guard would keep the old row. */
  private tick(): number {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  private name(jid: string, given = ''): string {
    return this.names.get(jid) || given || fallbackName(jid);
  }

  /** A person's or a chat's shown name: its WhatsApp name, else the name it gave itself, else its number. */
  nameOf(jid: string): string {
    return this.name(jid, this.authors.get(jid));
  }

  /** What a message says in words: an attachment's label then its caption, or its text. */
  words(m: WaMessage): string {
    if (m.deleted) return this.labels.deleted;
    const kind = m.kind ?? '';
    if (kind === '') return m.text;
    const label = kind === 'document' && m.file_name ? `📄 ${m.file_name}` : this.labels.kind(kind);
    return m.text ? `${label}\n${m.text}` : label;
  }

  messageRow(m: WaMessage): LocalMessage {
    const by = this.reactions.get(m.id);
    let reactions: string | null = null;
    if (by !== undefined && !m.deleted) {
      // `names` beside `usernames`, as Rocket.Chat does: who reacted, named.
      const grouped: Record<string, { usernames: string[]; names: string[] }> = {};
      for (const [sender, glyph] of by) {
        const key = `:${shortcodeOfUnicode(glyph) ?? glyph}:`;
        const bucket = (grouped[key] ??= { usernames: [], names: [] });
        bucket.usernames.push(sender === 'me' ? this.me.username : sender);
        bucket.names.push(sender === 'me' ? this.labels.me : this.nameOf(sender));
      }
      reactions = JSON.stringify(grouped);
    }
    const link = m.link_url && !m.deleted && !m.kind
      ? JSON.stringify([{ url: m.link_url, meta: {
        ...(m.link_title ? { ogTitle: m.link_title } : {}),
        ...(m.link_description ? { ogDescription: m.link_description } : {}),
      } }])
      : null;
    const kind = m.deleted ? '' : m.kind ?? '';
    return {
      // An attachment draws itself: its caption alone is the text.
      id: m.id, rid: m.chat, text: kind === '' ? this.words(m) : m.text || null, ts: m.ts,
      authorId: m.mine ? this.me.userId : m.sender,
      authorName: m.mine ? this.labels.me : this.name(m.sender, m.author),
      systemType: null, threadId: null, threadCount: 0, threadLast: null, threadShown: false,
      editedAt: m.edited && !m.deleted ? m.ts : null, md: null, attachments: this.attachmentsJson(m, kind),
      reactions, urls: link, callId: null, encryptedRaw: null, pinned: false, starred: null,
      updatedAt: this.tick(),
    };
  }

  /**
   * An attachment in the shape the timeline draws (`ui/messageRow.tsx`
   * `NativeAttachment`): its file is reached through `lib/nativeFiles.ts`,
   * which asks the engine to download it.
   */
  private attachmentsJson(m: WaMessage, kind: string): string | null {
    const all = [this.quote(m), this.attachment(m, kind)].filter((a) => a !== null);
    return all.length > 0 ? JSON.stringify(all) : null;
  }

  /**
   * The quoted message as the timeline's quote block (`message_link`, author,
   * text): its current words when cached (edited or deleted since), else the
   * text the reply carried. The link only marks it as a quote.
   */
  private quote(m: WaMessage): Record<string, unknown> | null {
    if (!m.reply_to || m.deleted) return null;
    const cached = this.messages.get(m.reply_to);
    const sender = cached ? (cached.mine ? 'me' : cached.sender) : m.quote_sender ?? '';
    const author = sender === 'me' ? this.labels.me : sender === '' ? null : this.nameOf(sender);
    return { message_link: `wa-reply:${m.reply_to}`, ...(author === null ? {} : { author_name: author }),
      text: cached ? this.words(cached) : m.quote_text ?? '' };
  }

  private attachment(m: WaMessage, kind: string): Record<string, unknown> | null {
    if (kind === '') return null;
    const url = filePath(m.id);
    const mime = (m.mime ?? '').split(';')[0]!.trim();
    const size = m.size ? m.size : null;
    const attachment: Record<string, unknown> = {
      type: 'file', title: m.file_name || this.labels.kind(kind), title_link: url, size,
    };
    if (kind === 'image' || kind === 'sticker') {
      Object.assign(attachment, { image_url: url, image_type: mime || 'image/jpeg', image_size: size,
        ...(m.width && m.height ? { image_dimensions: { width: m.width, height: m.height } } : {}) });
    } else if (kind === 'video' || kind === 'gif') {
      Object.assign(attachment, { video_url: url, video_type: mime || 'video/mp4', video_size: size });
    } else if (kind === 'voice' || kind === 'audio') {
      Object.assign(attachment, { audio_url: url, audio_type: mime || 'audio/ogg', audio_size: size });
    }
    return attachment;
  }

  roomRow(chat: string): LocalRoom {
    const last = this.last.get(chat);
    const group = isGroup(chat);
    return {
      rid: chat, type: group ? 'p' : 'd', name: chat, displayName: this.name(chat),
      encrypted: false, readOnly: false,
      dmOtherUid: group ? null : chat, dmOtherUsername: group ? null : chat,
      lastMessage: last ? this.words(last).replace(/\n/g, ' ') : null,
      lastMessageType: null, lastMessageTs: last?.ts ?? this.started.get(chat) ?? null, avatarEtag: this.photos.get(chat) ?? null,
      updatedAt: this.tick(),
    };
  }

  subscriptionRow(chat: string): LocalSubscription {
    const unread = this.unread.get(chat) ?? 0;
    return {
      rid: chat, subId: chat, unread, mentions: 0, groupMentions: 0, alert: unread > 0, open: true,
      favorite: false, lastSeen: null, e2eKey: null, e2eKeyId: null, roles: null,
      groupId: null, groupName: null, groupRank: null, updatedAt: this.tick(),
    };
  }
}
