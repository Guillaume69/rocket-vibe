/**
 * Assembles a Teams `Provider` for a session. Rooms, read state and history
 * come from the aggregator and the chat service, live updates over Trouter.
 * Text goes out through the outbox; edit, delete, react, pin and mark read
 * through the actions; calls open the conversation in Teams itself. The
 * pinned/saved panel and saves are still to come, and the capabilities hide them.
 */

import type { DdpEvent } from '@rocket-vibe/provider-api/ddp';
import type { CallSignal } from '@rocket-vibe/provider-api/calls';
import { setDownloadResolver } from '@rocket-vibe/provider-api/downloadResolver';
import { setMediaLease } from '@rocket-vibe/provider-api/mediaAuth';
import { STREAM_NOTIFY_ROOM_TYPING, TYPING_ACTIVITY } from '@rocket-vibe/provider-api/typing';
import { availabilityStatus, presenceEvents, readPresence, statusAvailability } from './presence.ts';
import type { Session, TokenRejection } from '@rocket-vibe/provider-api/session';
import type { LocalMessage } from '@rocket-vibe/provider-api/rows';
import type { SyncEngine } from '@rocket-vibe/provider-api/sync';
import { NOTES_CONFLICT, type Capabilities, type EditableSettings, type Listener, type MemberPage, type Provider, type ProviderError, type RoomInformation, type RoomNotes, type RoomSettingsChange } from '@rocket-vibe/provider-api/provider';
import { TeamsError, TeamsTokens } from './auth.ts';
import { TeamsClient } from './client.ts';
import { TeamsMessageActions, TeamsOutbox } from './outbox.ts';
import { TeamsUploadQueue } from './uploads.ts';
import { teamsCalls } from './calls.ts';
import { NOTES_CREATED, NOTES_SAVE_CONFLICT, notesEdit, notesPage, notesSubmit, readNotes, type NotesPage, type NotesText } from './notes.ts';
import { TEAMS_EVENTS, TEAMS_HISTORY_PAGE, THREAD_COUNTERS, TeamsRooms, TeamsSync, TeamsThreads, TeamsTranslator } from './sync.ts';
import { TeamsDirectory, channelRoom, chatRoom, conversationOf, conversationTopic, deleted, groupThread, isGraphShare, isGroupChat, mriOf, newGroupChat, newOneOnOne, oneOnOneId, people, profileFields, rootOf, rosterPage, searchHits, str, toMessage } from './translate.ts';
import { CALL_COLLECTION, TeamsTrouter, type CallPush } from './trouter.ts';
import { teamsReadReceipts } from './receipts.ts';

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

/** The chat's notes page, named by the newest `FileAdd` event among the chat's
 *  newest `PINNED_LOOKBACK` messages; `null` when the chat has none. */
async function notesPageOf(client: TeamsClient, directory: TeamsDirectory, rid: string): Promise<NotesPage | null> {
  const url = await client.conversation(rid, ['messages'], `view=msnp24Equivalent%7CsupportsMessageProperties&pageSize=${PINNED_LOOKBACK}`);
  const body = (await client.chat('GET', url)).body;
  const created = (Array.isArray(body.messages) ? (body.messages as Doc[]) : [])
    .map((m) => toMessage(rid, m, directory))
    .filter((m): m is LocalMessage => m?.systemType === NOTES_CREATED && typeof m.text === 'string')
    .sort((a, b) => b.ts - a.ts)[0];
  return created?.text ? notesPage(created.text) : null;
}

/** The page read whole: its latest snapshot, then the operations after it. */
async function notesRead(client: TeamsClient, page: NotesPage): Promise<NotesText> {
  const snapshot = await client.notesStream(page, '/snapshots/trees/latest?ump=1');
  const latest = typeof snapshot.latestSequenceNumber === 'number' ? snapshot.latestSequenceNumber : 0;
  // The service refuses an open range ("must specify 'AND' filter").
  const later = await client
    .notesStream(page, `?ump=1&filter=sequenceNumber%20ge%20${latest + 1}%20and%20sequenceNumber%20le%20${latest + 5000}`)
    .then((b) => (Array.isArray(b.value) ? b.value : []))
    .catch(() => []);
  const text = readNotes(snapshot, later);
  if (text === null) throw new TeamsError('notes_format');
  return text;
}

const asNotes = (text: NotesText): RoomNotes =>
  ({ markdown: text.markdown, revision: String(text.sequence), editable: true, updatedBy: text.updatedBy, updatedAt: text.updatedAt });

/** A chat's notes; a chat without a page reads as empty. Mirrors `TeamsSync::notes`. */
export async function teamsNotes(client: TeamsClient, directory: TeamsDirectory, rid: string): Promise<RoomNotes> {
  const page = await notesPageOf(client, directory, rid);
  if (page === null) return { markdown: '', revision: '0', editable: false, updatedBy: null, updatedAt: null };
  return asNotes(await notesRead(client, page));
}

/** Saves a chat's notes over `revision`, rewriting the paragraphs that changed
 *  through Fluid's delta stream; a page changed since fails with
 *  `NOTES_CONFLICT`. Mirrors `TeamsSync::save_notes`. */
export async function saveTeamsNotes(client: TeamsClient, directory: TeamsDirectory, me: string, rid: string, markdown: string, revision: string): Promise<RoomNotes> {
  const page = await notesPageOf(client, directory, rid);
  if (page === null) throw new TeamsError('notes_none');
  const current = await notesRead(client, page);
  if (String(current.sequence) !== revision) throw new TeamsError(NOTES_CONFLICT);
  const author = { id: me, name: directory.shown(me), timestamp: Date.now(), dataSource: 0 };
  let ops: ReturnType<typeof notesEdit>;
  try {
    ops = notesEdit(current, markdown, author);
  } catch (e) {
    throw new TeamsError(e instanceof Error ? e.message : 'notes_save');
  }
  if (ops.length === 0) return asNotes(current);
  const [session, push] = await Promise.all([client.notesJoin(page), client.notesPush()]);
  let sequenced: number;
  try {
    sequenced = await notesSubmit(session, push, current, ops);
  } catch (e) {
    throw new TeamsError(e instanceof Error && e.message === NOTES_SAVE_CONFLICT ? NOTES_CONFLICT : 'notes_save');
  }
  // The op stream serves a sequenced op a moment after the socket confirms it.
  for (let attempt = 0; attempt < 10; attempt++) {
    const text = await notesRead(client, page);
    if (text.sequence >= sequenced) return asNotes(text);
    await new Promise((r) => setTimeout(r, 700));
  }
  return asNotes(await notesRead(client, page));
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
  quotes: true,
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
  notes: true,
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
      if (!rooms.entries.has(rid)) await sync.adopt(rid, resource);
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
  // Read and watched: Teams pushes the changes of the people subscribed only.
  const loadPresence = async () => {
    const mris = [...directory.displayNames().keys()];
    const route = listener instanceof TeamsTrouter ? listener.presenceRoute() : null;
    if (route) await client.subscribePresence(route.uri, route.registration, mris).catch(() => {});
    return readPresence(client, mris);
  };
  const listener = options.listener ?? new TeamsTrouter(tokens, expand, {
    fetch: options.fetch,
    refreshPresence: async () => presenceEvents(await loadPresence()),
    announce: (registration, online) => client.announceEndpoint(registration, online),
  });
  let keptOnline = true;
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

  const calls = teamsCalls(client, rooms, session.teamsTenantId ?? '', session.userId);
  /** The `reject` link of each ringing call, by the call id the prompt declines. */
  const declines = new Map<string, string>();

  return {
    identity: { kind: 'teams', origin: session.baseUrl, accountId: session.userId, instanceId: null, generation: null },
    describeError: describeTeamsError,
    capabilities: TEAMS_CAPABILITIES,
    calls: { ...calls, decline: async (id: string) => { const link = declines.get(id); declines.delete(id); if (link) await client.declineCall(link); } },
    callSignal: (event: DdpEvent) => {
      if (event.collection !== CALL_COLLECTION) return null;
      const signal = callSignal(event.args[0] as CallPush, session.userId);
      if (signal?.kind === 'ring') {
        const push = event.args[0] as Extract<CallPush, { kind: 'ring' }>;
        if (push.reject) declines.set(signal.callId, push.reject);
      }
      return signal;
    },
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
        const channel = known?.team && str(known.entry, 'groupId') && str(known.entry, 'substrateGroupId');
        return channel || (known && !known.team && isGroupChat(known.entry)) ? { name: true, texts: false, readOnly: false } : null;
      },
      saveRoomSettings: async (rid: string, fields: RoomSettingsChange): Promise<void> => {
        const known = rooms.entries.get(rid);
        if (fields.name === undefined) return;
        if (known && !known.team && isGroupChat(known.entry)) {
          await client.setTopic(rid, fields.name);
          known.entry.title = fields.name;
          if (engine) await engine.ingestSubscriptions([{ ...known.entry, __team: null }]);
          return;
        }
        const group = known?.team ? str(known.entry, 'groupId') : null;
        const oid = known?.team ? str(known.entry, 'substrateGroupId') : null;
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
      roomNotes: (rid) => teamsNotes(client, directory, rid),
      saveRoomNotes: (rid, markdown, revision) => saveTeamsNotes(client, directory, session.userId, rid, markdown, revision),
      listStarred: async (): Promise<LocalMessage[]> => [],
      markRead: async (rid) => {
        const marked = await actionsFor(ingestLive).markRead(rid, newest.get(rid) ?? null, rooms.lastId(rid));
        const entry = marked === null ? null : rooms.readUpTo(rid, marked);
        if (entry && engine) await engine.ingestSubscriptions([entry]);
      },
      openOrCreateGroupDm: async (people) => {
        const others = people.map((p) => p.uid ?? '');
        if (others.length < 2 || others.some((mri) => !mri.startsWith('8:'))) throw new TeamsError('group_chat_unknown_person');
        const rid = await client.createGroupChat(groupThread(session.userId, others));
        const chat = newGroupChat(rid, session.userId, others, Date.now());
        rooms.open(chat);
        const raw = { ...chat, __team: null };
        if (engine) await engine.ingestSubscriptions([raw]);
        return { rid, rawRoom: raw };
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
    readReceipts: teamsReadReceipts(client, directory),
    keepOnline: {
      get: () => keptOnline,
      set: (on: boolean) => {
        keptOnline = on;
        (listener as Partial<TeamsTrouter>).setKeepOnline?.(on);
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
    loadPresence,
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

/** A call Teams pushed as the ring signal the app's ringer reads: a ring on
 *  the conversation it comes from (a 1:1 by both ids, a group by the thread
 *  the push names), whose call id opens that conversation in the call screen,
 *  where Teams' own client answers it. Mirrors `Session::teams_call`. */
export function callSignal(push: CallPush, me: string): CallSignal | null {
  if (push.kind === 'moved') return { kind: 'rung-over' };
  if (push.callerMri === me) return null;
  const rid = push.thread ?? (push.multiParty ? null : oneOnOneId(me, push.callerMri));
  if (rid === null) return null;
  return { kind: 'ring', rid, messageId: push.callId, callId: rid, callerId: push.callerMri, callerName: push.callerName };
}
