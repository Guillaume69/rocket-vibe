/**
 * Assembles a Teams `Provider` for a session. Rooms, read state and history
 * come from the aggregator and the chat service, live updates over Trouter.
 * Text goes out through the outbox; edit, delete, react, pin and mark read
 * through the actions; calls open the conversation in Teams itself. The
 * pinned/saved panel and saves are still to come, and the capabilities hide them.
 */

import type { DdpEvent } from '../../lib/ddp.ts';
import { setDownloadResolver } from '../../lib/downloadResolver.ts';
import { STREAM_NOTIFY_ROOM_TYPING, TYPING_ACTIVITY } from '../../lib/typing.ts';
import { availabilityStatus, readPresence, statusAvailability } from './presence.ts';
import type { Session } from '../../lib/auth.ts';
import type { LocalMessage } from '../../lib/normalize.ts';
import type { Capabilities, Listener, MemberPage, Provider, ProviderError, RoomInformation } from '../../lib/provider.ts';
import type { RestClient } from '../../lib/rest.ts';
import { TeamsError, TeamsTokens } from './auth.ts';
import { TeamsClient } from './client.ts';
import { TeamsMessageActions, TeamsOutbox } from './outbox.ts';
import { TeamsUploadQueue } from './uploads.ts';
import { teamsCalls } from './calls.ts';
import { TEAMS_EVENTS, TEAMS_HISTORY_PAGE, TeamsRooms, TeamsSync, TeamsTranslator } from './sync.ts';
import { TeamsDirectory, channelRoom, chatRoom, conversationOf, conversationTopic, deleted, isGraphShare, mriOf, profileFields, rootOf, rosterPage, searchHits, str } from './translate.ts';
import { TeamsTrouter } from './trouter.ts';

type Doc = Record<string, unknown>;

export const TEAMS_CAPABILITIES: Capabilities = {
  editing: true,
  deletion: true,
  files: true,
  threads: true,
  reactions: true,
  marks: false,
  pins: true,
  profile: true,
  roomInfo: true,
  roomSettings: false,
  roomRoleList: true,
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
  presence: true,
  push: false,
  e2ee: false,
  customEmojis: false,
  videoCall: true,
  search: true,
  threadTemplate: 'tmid',
};

export type TeamsProviderOptions = { fetch?: typeof fetch; listener?: Listener };

const refuse = (what: string) => () => Promise.reject(new TeamsError(`${what}_not_supported`));

export function createTeamsProvider(session: Session, rest: RestClient, generateId: () => string, options: TeamsProviderOptions = {}): Provider {
  const tokens = new TeamsTokens(session, { fetch: options.fetch });
  const client = new TeamsClient(tokens, { fetch: options.fetch, onRejected: () => rest.onTokenRejected?.(session.authToken) });
  const directory = new TeamsDirectory();
  directory.remember(session.userId, session.username);
  // Teams file downloads resolve a SharePoint share to its pre-signed Graph
  // url just before the transfer; registered for the message row to reach.
  setDownloadResolver(session.baseUrl.replace(/\/+$/, ''), (url) => (isGraphShare(url) ? client.downloadUrl(url).catch(() => url) : Promise.resolve(url)));
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
  // Pins are channel-scoped under the parent team; a chat (group or 1:1) has no
  // team here and cannot be pinned through this surface.
  const pinAction = (rid: string, mid: string, on: boolean): Promise<void> => {
    const team = rooms.entries.get(rid)?.team?.id;
    if (!team) return Promise.reject(new TeamsError('pin_requires_channel'));
    return actionsFor(ingestLive).setPinned(team, rid, mid, on);
  };

  return {
    identity: { kind: 'teams', origin: session.baseUrl, accountId: session.userId, instanceId: null, generation: null },
    describeError: describeTeamsError,
    capabilities: TEAMS_CAPABILITIES,
    calls: teamsCalls(client, rooms, session.teamsTenantId ?? ''),
    listener,
    setTyping: (rid, active) => { void typingAction(client, directory, session, rid, active); },
    translator,
    actions: {
      async roomInfo(rid: string): Promise<RoomInformation> {
        const cached = rooms.entries.get(rid);
        const room = cached
          ? cached.team
            ? channelRoom(cached.entry, directory)
            : chatRoom(session.userId, cached.entry, directory)
          : null;
        const doc = await client.roomDocument(rid).catch(() => ({}) as Doc);
        const roster = await client.roster(rid).catch(() => null);
        return {
          id: rid,
          name: room?.displayName ?? room?.name ?? '',
          type: room?.type ?? 'c',
          description: null,
          topic: conversationTopic(doc),
          announcement: null,
          members: roster ? rosterPage(roster, directory, '').total : null,
          readOnly: false,
        };
      },
      listMembers: async (rid: string, filter: string): Promise<MemberPage> =>
        rosterPage(await client.roster(rid).catch(() => ({}) as Doc), directory, filter),
      react: (rid, mid, emoji, put) => actionsFor(ingestLive).react(rid, mid, emoji, put),
      edit: (rid, mid, text) => actionsFor(ingestLive).edit(rid, mid, text),
      delete: (rid, mid) => actionsFor(ingestLive).delete(rid, mid),
      pin: (rid, mid) => pinAction(rid, mid, true),
      unpin: (rid, mid) => pinAction(rid, mid, false),
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
    loadPresence: () => readPresence(client, [...directory.displayNames().keys()]),
    ownActivity: {
      read: async () => {
        const [me] = await client.getPresence([session.userId]);
        return availabilityStatus(me ? str(me.presence as Doc, 'availability') : null);
      },
      set: async (status) => { await client.setPresence(statusAvailability(status)); return status; },
    },
    async readProfile(target) {
      const mri = target.uid ?? '';
      if (!mri) return undefined;
      const rows = await client.profiles([mri]).catch(() => [] as Doc[]);
      const row = rows.find((r) => (str(r, 'mri') ?? '').toLowerCase() === mri.toLowerCase()) ?? rows[0];
      return profileFields(mri, row, directory);
    },
    searchMessages: async (rid: string, text: string): Promise<LocalMessage[]> => {
      const body = await client.search(text).catch(() => ({}) as Doc);
      return searchHits(body, rid, directory);
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
    createUploadQueue: (store, transport, ingest, hooks) =>
      new TeamsUploadQueue({ store, client, transport, directory, me: session.userId, generateId, ingest, deleteLocalFile: hooks?.deleteLocalFile }),
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
