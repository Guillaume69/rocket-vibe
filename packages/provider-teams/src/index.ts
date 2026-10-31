/**
 * Assembles a Teams `Provider` for a session. Rooms, read state and history
 * come from the aggregator and the chat service, live updates over Trouter.
 * Text goes out through the outbox; edit, delete, react, pin and mark read
 * through the actions; calls open the conversation in Teams itself. The
 * pinned/saved panel and saves are still to come, and the capabilities hide them.
 */

import type { DdpEvent } from '@rocket-vibe/provider-api/ddp';
import { setDownloadResolver } from '@rocket-vibe/provider-api/downloadResolver';
import { setMediaLease } from '@rocket-vibe/provider-api/mediaAuth';
import { STREAM_NOTIFY_ROOM_TYPING, TYPING_ACTIVITY } from '@rocket-vibe/provider-api/typing';
import { availabilityStatus, readPresence, statusAvailability } from './presence.ts';
import type { Session, TokenRejection } from '@rocket-vibe/provider-api/session';
import type { LocalMessage } from '@rocket-vibe/provider-api/rows';
import type { SyncEngine } from '@rocket-vibe/provider-api/sync';
import type { Capabilities, EditableSettings, Listener, MemberPage, Provider, ProviderError, RoomInformation, RoomSettingsChange } from '@rocket-vibe/provider-api/provider';
import { TeamsError, TeamsTokens } from './auth.ts';
import { TeamsClient } from './client.ts';
import { TeamsMessageActions, TeamsOutbox } from './outbox.ts';
import { TeamsUploadQueue } from './uploads.ts';
import { teamsCalls } from './calls.ts';
import { TEAMS_EVENTS, TEAMS_HISTORY_PAGE, THREAD_COUNTERS, TeamsRooms, TeamsSync, TeamsThreads, TeamsTranslator } from './sync.ts';
import { TeamsDirectory, channelRoom, chatRoom, conversationOf, conversationTopic, deleted, isGraphShare, mriOf, newOneOnOne, people, profileFields, rootOf, rosterPage, searchHits, str, toMessage } from './translate.ts';
import { TeamsTrouter } from './trouter.ts';

type Doc = Record<string, unknown>;

const PINNED_LOOKBACK = 200;

/** A room's pinned messages among its newest `PINNED_LOOKBACK`, newest first:
 *  Teams has no list of them, its web app filters the messages it holds on
 *  `properties.pinned`. Mirrors `TeamsSync::pinned` in the desktop core. */
export async function teamsPinned(client: TeamsClient, directory: TeamsDirectory, rid: string): Promise<LocalMessage[]> {
  const url = await client.conversation(rid, ['messages'], `view=msnp24Equivalent%7CsupportsMessageProperties&pageSize=${PINNED_LOOKBACK}`);
  const body = (await client.chat('GET', url)).body;
  return (Array.isArray(body.messages) ? (body.messages as Doc[]) : [])
    .map((m) => toMessage(rid, m, directory))
    .filter((m): m is LocalMessage => m?.pinned === true)
    .sort((a, b) => b.ts - a.ts);
}

export const TEAMS_CAPABILITIES: Capabilities = {
  editing: true,
  deletion: true,
  files: true,
  threads: true,
  reactions: true,
  marks: true,
  stars: false,
  profile: true,
  roomInfo: true,
  roomSettings: true,
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
  directMessages: true,
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

export function createTeamsProvider(session: Session, rest: TokenRejection, generateId: () => string, options: TeamsProviderOptions = {}): Provider {
  // Images on Teams' object store answer to the skype token in asyncgw's own
  // form; the lease follows every renewal of that token.
  const tokens = new TeamsTokens(session, {
    fetch: options.fetch,
    onSkype: (skype, routes) => {
      if (routes.ams) setMediaLease(routes.ams, session.authToken, session.userId, { Authorization: `skype_token ${skype}` });
    },
  });
  const client = new TeamsClient(tokens, {
    fetch: options.fetch,
    onRejected: () => rest.onTokenRejected?.(session.authToken),
    me: session.userId,
    isChat: (rid) => rooms.entries.has(rid) && !rooms.entries.get(rid)?.team,
  });
  const directory = new TeamsDirectory();
  directory.remember(session.userId, session.username);
  // Teams file downloads resolve a SharePoint share to its pre-signed Graph
  // url just before the transfer; registered for the message row to reach.
  setDownloadResolver(session.baseUrl.replace(/\/+$/, ''), (url) => (isGraphShare(url) ? client.downloadUrl(url).catch(() => url) : Promise.resolve(url)));
  const rooms = new TeamsRooms();
  const threads = new TeamsThreads();
  const sync = new TeamsSync(client, rooms, threads, directory, session.userId);
  const translator = new TeamsTranslator(directory, session.userId, threads);
  const newest = new Map<string, string>();
  let engine: SyncEngine | null = null;
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
    const post = id === null ? null : rootOf(resource, id);
    if (post !== null) events.push({ collection: TEAMS_EVENTS, eventKey: THREAD_COUNTERS, args: [{ id: `${rid}/${post}` }] });
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
    calls: teamsCalls(client, rooms, session.teamsTenantId ?? '', session.userId),
    listener,
    setTyping: (rid, active) => { void typingAction(client, directory, session, rid, active); },
    translator,
    actions: {
      async roomInfo(rid: string): Promise<RoomInformation> {
        const cached = rooms.entries.get(rid);
        const room = cached
          ? cached.team
            ? channelRoom(cached.entry, null, directory)
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
      editableSettings: async (rid: string): Promise<EditableSettings | null> => {
        const known = rooms.entries.get(rid);
        return known?.team && str(known.entry, 'groupId') && str(known.entry, 'substrateGroupId') ? { name: true, texts: false, readOnly: false } : null;
      },
      saveRoomSettings: async (rid: string, fields: RoomSettingsChange): Promise<void> => {
        const known = rooms.entries.get(rid);
        const group = known?.team ? str(known.entry, 'groupId') : null;
        const oid = known?.team ? str(known.entry, 'substrateGroupId') : null;
        if (fields.name === undefined) return;
        if (!known || !group || !oid) throw new TeamsError('team_not_found');
        await client.rename(group, oid, session.teamsTenantId ?? '', fields.name);
        known.entry.displayName = fields.name;
      },
      listMembers: async (rid: string, filter: string): Promise<MemberPage> =>
        rosterPage(await client.roster(rid).catch(() => ({}) as Doc), directory, filter),
      react: (rid, mid, emoji, put) => actionsFor(ingestLive).react(rid, mid, emoji, put),
      edit: (rid, mid, text) => actionsFor(ingestLive).edit(rid, mid, text),
      delete: (rid, mid) => actionsFor(ingestLive).delete(rid, mid),
      pin: (rid, mid) => pinAction(rid, mid, true),
      unpin: (rid, mid) => pinAction(rid, mid, false),
      star: refuse('star'),
      listPinned: (rid) => teamsPinned(client, directory, rid),
      listStarred: async (): Promise<LocalMessage[]> => [],
      markRead: async (rid) => {
        const marked = await actionsFor(ingestLive).markRead(rid, newest.get(rid) ?? null, rooms.lastId(rid));
        const entry = marked === null ? null : rooms.readUpTo(rid, marked);
        if (entry && engine) await engine.ingestSubscriptions([entry]);
      },
      openOrCreateDm: async (_name: string, uid?: string) => {
        const mri = uid ?? '';
        const chat = newOneOnOne(session.userId, mri, Date.now());
        const rid = chat ? str(chat, 'id') : null;
        if (!chat || !rid) throw new TeamsError('direct_message_unknown_person');
        const known = rooms.entries.get(rid);
        if (known) return { rid, rawRoom: { ...known.entry, __team: known.team } };
        rooms.open(chat);
        const raw = { ...chat, __team: null };
        if (engine) await engine.ingestSubscriptions([raw]);
        return { rid, rawRoom: raw };
      },
    },
    searchPeople: async (query) =>
      people(await client.searchPeople(query), session.userId).map((p) => {
        directory.remember(p.mri, p.name);
        return { id: p.mri, name: p.name, detail: p.upn ?? p.name };
      }),
    displayNames: {
      names: () => directory.displayNames(),
      statuses: () => new Map(),
      mentions: () => directory.mentionNames(),
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
      const mri = target.uid ?? (target.username !== undefined ? directory.mriOfToken(target.username) : null) ?? '';
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
    catchUpGlobal: (current, isDiscarded) => { engine = current; return sync.catchUpGlobal(current, isDiscarded); },
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
