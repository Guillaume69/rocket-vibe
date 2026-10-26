/**
 * Teams into the store: the aggregator's chats and channels with their read
 * state, and each conversation's history, newest page first, older pages
 * reached through the backward link the service hands out. Documents reach
 * the engine raw, tagged with their conversation (`__rid`) or team
 * (`__team`); `TeamsTranslator` reads them. Mirrors
 * `apps/desktop/crates/rv-core/src/teams/sync.rs`.
 */

import type { DdpEvent } from '@rocket-vibe/provider-api/ddp';
import type { LocalMessage, LocalRoom, LocalSubscription } from '@rocket-vibe/provider-api/rows';
import type { Translation, Translator } from '@rocket-vibe/provider-api/provider';
import type { SyncEngine } from '@rocket-vibe/provider-api/sync';
import { TeamsError } from './auth.ts';
import type { TeamsClient } from './client.ts';
import {
  TeamsDirectory, chatRoom, channelRoom, conversationOf, deleted, int, lastId, messageId, readUpTo, rootOf, splitId, str, subject, toMessage, toSubscription,
} from './translate.ts';

type Doc = Record<string, unknown>;
export const TEAMS_HISTORY_PAGE = 50;
const VIEW = 'view=msnp24Equivalent%7CsupportsMessageProperties';
const OLDER_PAGES = 20;
const PREVIEW_LOOKBACK = 20;
const PREVIEWED = new Set(['Text', 'RichText/Html', 'RichText']);
/** The collection live Trouter events arrive under; `eventKey` is the resource type. */
export const TEAMS_EVENTS = 'teams';

type Team = { id: string; name: string };

/** Each room's aggregator entry and team, to rebuild its row when a message arrives. */
export class TeamsRooms {
  readonly entries = new Map<string, { entry: Doc; team: Team | null }>();

  /** The room's entry updated with a newly arrived message, as raw documents for the engine. */
  withLast(rid: string, resource: Doc, mine: boolean): Doc | null {
    const known = this.entries.get(rid);
    if (!known) return null;
    const entry: Doc = {
      ...known.entry,
      lastMessage: {
        messageType: resource.messagetype, content: resource.content, from: resource.from,
        imDisplayName: resource.imdisplayname, composeTime: resource.composetime ?? resource.originalarrivaltime, id: resource.id,
        subject: subject(resource),
      },
      isRead: mine, isMessageRead: mine, isLastMessageFromMe: mine,
    };
    this.entries.set(rid, { entry, team: known.team });
    return { ...entry, __team: known.team };
  }

  /** The newest message id the room's entry lists, events included. */
  lastId(rid: string): number | null {
    const known = this.entries.get(rid);
    return known ? lastId(known.entry) : null;
  }

  /** The room's entry read up to `id`, as a raw document for the engine. */
  readUpTo(rid: string, id: number): Doc | null {
    const known = this.entries.get(rid);
    if (!known) return null;
    const entry = readUpTo(known.entry, id);
    this.entries.set(rid, { entry, team: known.team });
    return { ...entry, __team: known.team };
  }

  /** Whether a message is the one the room's entry previews. */
  isPreview(rid: string, resource: Doc): boolean {
    const shown = int((this.entries.get(rid)?.entry as Doc | undefined)?.lastMessage, 'id');
    return shown !== null && shown === int(resource, 'id');
  }

  /** The room's entry previewing `resource` instead (an empty text for none), at the time it showed. */
  withPreview(rid: string, resource: Doc | null): Doc | null {
    const known = this.entries.get(rid);
    if (!known) return null;
    const composeTime = ((known.entry.lastMessage ?? {}) as Doc).composeTime ?? null;
    const lastMessage = resource
      ? { messageType: resource.messagetype, content: resource.content, from: resource.from, imDisplayName: resource.imdisplayname, composeTime, id: resource.id, subject: subject(resource) }
      : { messageType: 'Text', content: '', composeTime };
    const entry: Doc = { ...known.entry, lastMessage };
    this.entries.set(rid, { entry, team: known.team });
    return { ...entry, __team: known.team };
  }
}

/** The live event naming a post whose reply count moved. */
export const THREAD_COUNTERS = 'thread';

/** Each channel post's replies seen, for the count and last reply time the
 *  post shows: Teams sends no reply count. */
export class TeamsThreads {
  private readonly replies = new Map<string, Map<string, number>>();

  /** Notes a reply under its post; answers the post. */
  note(message: LocalMessage): string | null {
    if (message.threadId === null) return null;
    const replies = this.replies.get(message.threadId) ?? new Map<string, number>();
    replies.set(message.id, message.ts);
    this.replies.set(message.threadId, replies);
    return message.threadId;
  }

  /** Forgets a deleted reply; answers the post it was under. */
  drop(id: string): string | null {
    for (const [root, replies] of this.replies) {
      if (replies.delete(id)) return root;
    }
    return null;
  }

  counters(root: string): { count: number; last: number | null } {
    const replies = [...(this.replies.get(root)?.values() ?? [])];
    return { count: replies.length, last: replies.length > 0 ? Math.max(...replies) : null };
  }

  /** A post as shown: its replies counted. */
  counted(message: LocalMessage): LocalMessage {
    if (message.threadId !== null || !this.replies.has(message.id)) return message;
    const { count, last } = this.counters(message.id);
    return { ...message, threadCount: count, threadLast: last };
  }
}

export class TeamsTranslator implements Translator {
  private readonly directory: TeamsDirectory;
  private readonly me: string;
  private readonly threads: TeamsThreads;

  constructor(directory: TeamsDirectory, me: string, threads: TeamsThreads = new TeamsThreads()) {
    this.directory = directory;
    this.me = me;
    this.threads = threads;
  }

  toMessage(raw: Doc): LocalMessage | null {
    const rid = str(raw, '__rid') ?? conversationOf(raw);
    const message = rid ? toMessage(rid, raw, this.directory) : null;
    if (message === null) return null;
    this.threads.note(message);
    return this.threads.counted(message);
  }

  toRoom(raw: Doc): LocalRoom | null {
    const team = raw.__team as Team | null | undefined;
    return team ? channelRoom(raw, team.name, this.directory) : chatRoom(this.me, raw, this.directory);
  }

  toSubscription(raw: Doc): LocalSubscription | null {
    const rid = str(raw, 'id');
    return rid ? toSubscription(rid, raw, this.me, (raw.__team as Team | null | undefined) ?? null) : null;
  }

  translateEvent(event: DdpEvent): Translation {
    if (event.collection !== TEAMS_EVENTS) return { kind: 'ignore' };
    const resource = (event.args[0] ?? {}) as Doc;
    switch (event.eventKey) {
      case 'room': {
        const room = this.toRoom(resource);
        return room ? { kind: 'change', change: { type: 'room', doc: room } } : { kind: 'ignore' };
      }
      case 'subscription': {
        const sub = this.toSubscription(resource);
        return sub ? { kind: 'change', change: { type: 'subscription', doc: sub } } : { kind: 'ignore' };
      }
      case 'NewMessage':
      case 'MessageUpdate': {
        const rid = conversationOf(resource), id = str(resource, 'id');
        if (rid && id && deleted(resource)) {
          this.threads.drop(messageId(rid, id));
          return { kind: 'change', change: { type: 'message-deleted', id: messageId(rid, id) } };
        }
        const message = this.toMessage(resource);
        return message ? { kind: 'change', change: { type: 'message', doc: message } } : { kind: 'silence' };
      }
      case THREAD_COUNTERS: {
        const root = str(resource, 'id');
        return root ? { kind: 'change', change: { type: 'thread-counters', id: root, ...this.threads.counters(root) } } : { kind: 'ignore' };
      }
      default:
        return { kind: 'silence' };
    }
  }
}

export class TeamsSync {
  /** The backward link past the oldest page read per room, and that page's oldest id. */
  private readonly older = new Map<string, { link: string; oldest: number }>();
  /** The newest server id read per room, for a catch-up. */
  private readonly newest = new Map<string, number>();
  private readonly client: TeamsClient;
  private readonly rooms: TeamsRooms;
  private readonly threads: TeamsThreads;

  constructor(client: TeamsClient, rooms: TeamsRooms, threads: TeamsThreads = new TeamsThreads()) {
    this.client = client;
    this.rooms = rooms;
    this.threads = threads;
  }

  /** Every chat and channel, raw, tagged with its team. */
  private async entries(): Promise<Doc[]> {
    const snapshot = await this.client.snapshot();
    const out: Doc[] = [];
    this.rooms.entries.clear();
    for (const chat of Array.isArray(snapshot.chats) ? (snapshot.chats as Doc[]) : []) {
      const rid = str(chat, 'id');
      if (!rid) continue;
      this.rooms.entries.set(rid, { entry: chat, team: null });
      out.push({ ...chat, __team: null });
    }
    for (const team of Array.isArray(snapshot.teams) ? (snapshot.teams as Doc[]) : []) {
      const id = str(team, 'id'), name = str(team, 'displayName');
      if (!id || !name) continue;
      for (const channel of Array.isArray(team.channels) ? (team.channels as Doc[]) : []) {
        const rid = str(channel, 'id');
        if (!rid) continue;
        this.rooms.entries.set(rid, { entry: channel, team: { id, name } });
        out.push({ ...channel, __team: { id, name } });
      }
    }
    return out;
  }

  async catchUpGlobal(engine: SyncEngine, isDiscarded: () => boolean): Promise<void> {
    const entries = await this.entries();
    if (isDiscarded()) return;
    await engine.ingestRooms(entries);
    await engine.ingestSubscriptions(entries);
  }

  async reconcile(engine: SyncEngine, isDiscarded: () => boolean): Promise<void> {
    const entries = await this.entries();
    if (isDiscarded() || entries.length === 0) return;
    const store = engine.syncStore;
    await store.purgeMissingRooms(entries.map((e) => str(e, 'id')!).filter(Boolean), await store.listKnownRids());
  }

  private async page(url: string, rid: string): Promise<{ messages: Doc[]; older: string | null }> {
    const body = (await this.client.chat('GET', url)).body;
    const messages = (Array.isArray(body.messages) ? (body.messages as Doc[]) : []).map((m) => ({ ...m, __rid: rid }));
    const older = (body._metadata as Doc | undefined)?.backwardLink;
    return { messages, older: typeof older === 'string' ? older : null };
  }

  private remember(rid: string, messages: Doc[], older: string | null): void {
    const ids = messages.map((m) => int(m, 'id')).filter((n): n is number => n !== null);
    if (ids.length === 0) return;
    const top = Math.max(...ids);
    if ((this.newest.get(rid) ?? 0) < top) this.newest.set(rid, top);
    if (older) this.older.set(rid, { link: older, oldest: Math.min(...ids) });
    else this.older.delete(rid);
  }

  /** Stores a page, then sets the reply count of each post a reply of it is under. */
  private async ingest(engine: SyncEngine, rid: string, messages: Doc[]): Promise<void> {
    const posts = new Set<string>();
    for (const m of messages) {
      const id = str(m, 'id');
      if (id && deleted(m)) {
        const post = this.threads.drop(messageId(rid, id));
        if (post) posts.add(post);
        await engine.syncStore.deleteMessage(messageId(rid, id));
      }
      const root = id ? rootOf(m, id) : null;
      if (root) posts.add(messageId(rid, root));
    }
    await engine.ingestMessages(messages);
    for (const post of posts) {
      const { count, last } = this.threads.counters(post);
      await engine.syncStore.updateThreadCounters(post, count, last);
    }
  }

  /** The newest page, or the page before `latest` (ms), walking back through the kept links. */
  async loadHistory(engine: SyncEngine, rid: string, latest?: string): Promise<{ oldest: number | null }> {
    const bound = latest === undefined ? null : Date.parse(latest);
    const kept = this.older.get(rid);
    let url = bound !== null && kept && kept.oldest <= bound ? await this.client.trusted(kept.link) : null;
    url ??= await this.client.conversation(rid, ['messages'], `${VIEW}&pageSize=${TEAMS_HISTORY_PAGE}`);
    for (let n = 0; n < OLDER_PAGES; n++) {
      const { messages, older } = await this.page(url, rid);
      const below = bound === null ? messages : messages.filter((m) => (int(m, 'id') ?? Infinity) < bound);
      this.remember(rid, messages, older);
      const next = below.length === 0 && messages.length > 0 ? await this.client.trusted(older) : null;
      if (next) { url = next; continue; }
      await this.ingest(engine, rid, below);
      const ids = below.map((m) => int(m, 'id')).filter((n): n is number => n !== null);
      return { oldest: ids.length > 0 ? Math.min(...ids) : null };
    }
    return { oldest: null };
  }

  /** Teams pages backward only: a bounded window of the past is not offered. */
  async range(): Promise<Doc[]> {
    throw new TeamsError('history_range_not_supported');
  }

  /** What arrived since the room's newest read message; a full page replaces the stored ones. */
  async catchUpRoom(engine: SyncEngine, rid: string, isDiscarded: () => boolean): Promise<void> {
    const since = this.newest.get(rid) ?? (await engine.syncStore.lastMessageUpdatedAt(rid));
    if (since === null || isDiscarded()) return;
    const { messages } = await this.page(await this.client.conversation(rid, ['messages'], `${VIEW}&pageSize=${TEAMS_HISTORY_PAGE}&startTime=${since}`), rid);
    if (isDiscarded()) return;
    if (messages.length < TEAMS_HISTORY_PAGE) {
      this.remember(rid, messages, this.older.get(rid)?.link ?? null);
      await this.ingest(engine, rid, messages);
      return;
    }
    const newest = await this.page(await this.client.conversation(rid, ['messages'], `${VIEW}&pageSize=${TEAMS_HISTORY_PAGE}`), rid);
    if (isDiscarded()) return;
    await engine.syncStore.clearRoomMessages(rid);
    this.remember(rid, newest.messages, newest.older);
    await this.ingest(engine, rid, newest.messages);
  }

  /** A channel thread's root and replies, from the thread-scoped conversation. */
  async loadThread(engine: SyncEngine, threadId: string): Promise<void> {
    const target = splitId(threadId);
    if (!target) return;
    const root = await this.fetch(threadId);
    if (root) await engine.ingestMessages([root]);
    const scoped = `${target.rid};messageid=${target.server}`;
    const { messages } = await this.page(await this.client.conversation(scoped, ['messages'], `${VIEW}&pageSize=${TEAMS_HISTORY_PAGE}`), target.rid);
    await this.ingest(engine, target.rid, messages);
  }

  /** The newest message the room itself shows, for its preview once the previewed one is deleted. */
  async newestShown(rid: string): Promise<Doc | null | undefined> {
    try {
      const { messages } = await this.page(await this.client.conversation(rid, ['messages'], `${VIEW}&pageSize=${PREVIEW_LOOKBACK}`), rid);
      return messages.find((m) => {
        const id = str(m, 'id');
        return id !== null && !deleted(m) && PREVIEWED.has(str(m, 'messagetype') ?? '') && rootOf(m, id) === null;
      }) ?? null;
    } catch {
      return undefined;
    }
  }

  /** The service's copy of one message, tagged with its room, not stored. */
  async fetch(id: string): Promise<Doc | null> {
    const target = splitId(id);
    if (!target) return null;
    try {
      const body = (await this.client.chat('GET', await this.client.conversation(target.rid, ['messages', target.server], VIEW))).body;
      return { ...body, __rid: target.rid };
    } catch (e) {
      if (e instanceof TeamsError && e.status === 404) return null;
      throw e;
    }
  }
}
