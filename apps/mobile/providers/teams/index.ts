/**
 * Assembles a Teams `Provider` for a session. Rooms, read state and history
 * come from the aggregator and the chat service, live updates over Trouter.
 * Text goes out through the outbox; edit, delete, react and mark read through
 * the actions. Files, threads, pins, saves, search, profiles, room info and
 * calls are still to come, and the capabilities hide them.
 */

import type { DdpEvent } from '../../lib/ddp.ts';
import { STREAM_NOTIFY_ROOM_TYPING, TYPING_ACTIVITY } from '../../lib/typing.ts';
import type { Session } from '../../lib/auth.ts';
import type { LocalMessage } from '../../lib/normalize.ts';
import type { Capabilities, Listener, Provider, ProviderError } from '../../lib/provider.ts';
import type { RestClient } from '../../lib/rest.ts';
import { TeamsError, TeamsTokens } from './auth.ts';
import { TeamsClient } from './client.ts';
import { TeamsMessageActions, TeamsOutbox } from './outbox.ts';
import { TEAMS_EVENTS, TEAMS_HISTORY_PAGE, TeamsRooms, TeamsSync, TeamsTranslator } from './sync.ts';
import { TeamsDirectory, conversationOf, deleted, mriOf, rootOf, str } from './translate.ts';
import { TeamsTrouter } from './trouter.ts';

type Doc = Record<string, unknown>;

export const TEAMS_CAPABILITIES: Capabilities = {
  editing: true,
  deletion: true,
  files: false,
  threads: true,
  reactions: true,
  marks: false,
  profile: false,
  roomInfo: false,
  roomSettings: false,
  roomRoleList: false,
  leaveRoom: false,
  roomFavorites: false,
  roomReads: false,
  quotes: false,
  alsoInRoom: false,
  voice: false,
  administration: false,
  reports: false,
  scheduledMessages: false,
  sending: true,
  typing: true,
  presence: false,
  push: false,
  e2ee: false,
  customEmojis: false,
  videoCall: false,
  search: false,
  threadTemplate: 'tmid',
};

export type TeamsProviderOptions = { fetch?: typeof fetch; listener?: Listener };

const refuse = (what: string) => () => Promise.reject(new TeamsError(`${what}_not_supported`));

export function createTeamsProvider(session: Session, rest: RestClient, generateId: () => string, options: TeamsProviderOptions = {}): Provider {
  const tokens = new TeamsTokens(session, { fetch: options.fetch });
  const client = new TeamsClient(tokens, { fetch: options.fetch, onRejected: () => rest.onTokenRejected?.(session.authToken) });
  const directory = new TeamsDirectory();
  directory.remember(session.userId, session.username);
  const rooms = new TeamsRooms();
  const sync = new TeamsSync(client, rooms);
  const translator = new TeamsTranslator(directory, session.userId);
  const newest = new Map<string, string>();
  const ingestOne = async (raw: Doc) => {
    const rid = str(raw, '__rid') ?? conversationOf(raw);
    const id = str(raw, 'id');
    if (rid && id && /^\d+$/.test(id) && Number(id) > Number(newest.get(rid)?.split('/').pop() ?? 0)) newest.set(rid, `${rid}/${id}`);
  };
  const expand = async (name: string, resource: Doc): Promise<DdpEvent[]> => {
    const rid = conversationOf(resource);
    if (!rid) return [];
    // A typing control message is not a message: it feeds the typing indicator.
    const control = str(resource, 'messagetype') ?? '';
    if (control === 'Control/Typing' || control === 'Control/ClearTyping') {
      if (mriOf(str(resource, 'from') ?? '') === session.userId) return [];
      const who = str(resource, 'imdisplayname') ?? directory.shown(mriOf(str(resource, 'from') ?? ''));
      const active = control === 'Control/Typing';
      return who ? [{ collection: STREAM_NOTIFY_ROOM_TYPING, eventKey: `${rid}/user-activity`, args: [who, active ? [TYPING_ACTIVITY] : []] }] : [];
    }
    const events: DdpEvent[] = [{ collection: TEAMS_EVENTS, eventKey: name, args: [{ ...resource, __rid: rid }] }];
    const id = str(resource, 'id');
    if (name === 'NewMessage' && !rooms.isPreview(rid, resource)) {
      await ingestOne({ ...resource, __rid: rid });
      const mine = mriOf(str(resource, 'from') ?? '') === session.userId;
      const entry = id !== null && rootOf(resource, id) !== null ? null : rooms.withLast(rid, resource, mine);
      if (entry) {
        events.push({ collection: TEAMS_EVENTS, eventKey: 'room', args: [entry] });
        events.push({ collection: TEAMS_EVENTS, eventKey: 'subscription', args: [entry] });
      }
    } else if (rooms.isPreview(rid, resource)) {
      const next = deleted(resource) ? await sync.newestShown(rid) : resource;
      const entry = next === undefined ? null : rooms.withPreview(rid, next);
      if (entry) events.push({ collection: TEAMS_EVENTS, eventKey: 'room', args: [entry] });
    }
    return events;
  };
  const listener = options.listener ?? new TeamsTrouter(tokens, expand, { fetch: options.fetch });
  let messageActions: TeamsMessageActions | null = null;
  const actionsFor = (ingest: (raw: Doc) => Promise<void>) => (messageActions ??= new TeamsMessageActions(client, ingest));
  let ingestLive: (raw: Doc) => Promise<void> = async () => {};

  return {
    identity: { kind: 'teams', origin: session.baseUrl, accountId: session.userId, instanceId: null, generation: null },
    describeError: describeTeamsError,
    capabilities: TEAMS_CAPABILITIES,
    listener,
    setTyping: (rid, active) => { void typingAction(client, directory, session, rid, active); },
    translator,
    actions: {
      roomInfo: refuse('room_info'),
      react: (rid, mid, emoji, put) => actionsFor(ingestLive).react(rid, mid, emoji, put),
      edit: (rid, mid, text) => actionsFor(ingestLive).edit(rid, mid, text),
      delete: (rid, mid) => actionsFor(ingestLive).delete(rid, mid),
      pin: refuse('pin'),
      unpin: refuse('pin'),
      star: refuse('star'),
      listPinned: async (): Promise<LocalMessage[]> => [],
      listStarred: async (): Promise<LocalMessage[]> => [],
      markRead: (rid) => actionsFor(ingestLive).markRead(rid, newest.get(rid) ?? null),
      openOrCreateDm: refuse('direct_message'),
    },
    displayNames: {
      names: () => directory.displayNames(),
      statuses: () => new Map(),
      subscribe: (fn) => directory.onChange(fn),
    },
    initialSubscriptions: () => [],
    roomSubscriptions: () => [],
    privateNote: () => null,
    loadHistory: async (engine, rid, _type, latest) => {
      const page = await sync.loadHistory(engine, rid, latest);
      return page;
    },
    historyRange: () => sync.range(),
    fetchMessage: (id) => sync.fetch(id),
    historyPage: TEAMS_HISTORY_PAGE,
    loadThread: async (engine, threadId, isDiscarded) => { if (!isDiscarded()) await sync.loadThread(engine, threadId); },
    createOutbox: (store, ingest) => {
      ingestLive = async (raw) => { await ingestOne(raw); await ingest(raw); };
      return new TeamsOutbox({ store, client, directory, me: { id: session.userId, username: session.username }, generateId, ingest: ingestLive });
    },
    createUploadQueue: () => { throw new TeamsError('upload_not_supported'); },
    catchUpGlobal: (engine, isDiscarded) => sync.catchUpGlobal(engine, isDiscarded),
    catchUpRoom: (engine, rid, isDiscarded) => sync.catchUpRoom(engine, rid, isDiscarded),
    reconcile: (engine, isDiscarded) => sync.reconcile(engine, isDiscarded),
  };
}

/** Tells the conversation I am typing, or stopped; a lost signal is harmless. */
export async function typingAction(client: TeamsClient, directory: TeamsDirectory, session: Session, rid: string, active: boolean): Promise<void> {
  try {
    const url = await client.conversation(rid, ['messages']);
    await client.chat('POST', url, {
      content: '', messagetype: active ? 'Control/Typing' : 'Control/ClearTyping',
      contenttype: 'Application/Message', imdisplayname: directory.shown(session.userId),
    });
  } catch {
    /* typing is best-effort */
  }
}

export function describeTeamsError(error: unknown, authenticated: boolean): ProviderError {
  if (error instanceof TeamsError) {
    return { code: error.code, status: error.status, requestId: null, retryAfter: error.retryAfter, rejectsSession: authenticated && error.rejectsSession, twoFactorChallenge: false };
  }
  return { code: 'connection_failed', status: 0, requestId: null, retryAfter: null, rejectsSession: false, twoFactorChallenge: false };
}
