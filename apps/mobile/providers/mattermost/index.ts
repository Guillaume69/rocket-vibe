/**
 * Assembles a Mattermost (or kChat) `Provider` for a session. One driver, two
 * kinds: kChat is Infomaniak's Mattermost with a bearer-only login, Pusher in
 * place of the WebSocket, and its own route for deleted posts. Everything else
 * (REST, translation, actions, outboxes) is shared.
 */

import type { Session } from '../../lib/auth.ts';
import { setMediaBearer } from '../../lib/mediaAuth.ts';
import type { CustomEmoji } from '../../lib/customEmojis.ts';
import type { DdpEvent } from '../../lib/ddp.ts';
import type { LocalMessage } from '../../lib/normalize.ts';
import type { Capabilities, FileOutbox, Ingest, Listener, Outbox, Provider, ProviderError } from '../../lib/provider.ts';
import type { RestClient } from '../../lib/rest.ts';
import type { OutboxStore } from '../../lib/outbox.ts';
import type { UploadStore } from '../../lib/uploadQueue.ts';
import type { TransportUpload } from '../../lib/upload.ts';
import { MmActions } from './actions.ts';
import { MmCategories } from './categories.ts';
import { kmeetCalls } from './kmeet.ts';
import { mattermostSidebarSettings } from './sidebarSettings.ts';
import { MmCatchUp } from './catchUp.ts';
import { MmClient, MmError } from './client.ts';
import { MmDirectory, toMmUser } from './directory.ts';
import { MM_HISTORY_PAGE, MmHistory, ordered } from './history.ts';
import { KchatPusher } from './pusher.ts';
import { MmLive } from './live.ts';
import { MmOutbox } from './outbox.ts';
import { MmSocket } from './socket.ts';
import { MM_ROOM, MmTranslator, record } from './translator.ts';
import { MmUploadQueue } from './uploads.ts';

export const MATTERMOST_CAPABILITIES: Capabilities = {
  editing: true,
  deletion: true,
  files: true,
  threads: true,
  reactions: true,
  marks: true,
  profile: true,
  roomInfo: true,
  roomFavorites: true,
  typing: true,
  presence: true,
  push: false,
  e2ee: false,
  customEmojis: true,
  videoCall: false,
  search: true,
  threadTemplate: 'root_id',
};

export type MattermostOptions = {
  fetch?: typeof fetch;
  listener?: Listener;
};

export function createMattermostProvider(
  session: Session,
  rest: RestClient,
  generateId: () => string,
  options: MattermostOptions = {},
): Provider {
  const kchat = session.kind === 'kchat';
  setMediaBearer(session.baseUrl, session.authToken);
  const client = new MmClient(session.baseUrl, session.authToken, {
    fetch: options.fetch,
    plainErrors: kchat,
    onTokenRejected: (token) => rest.onTokenRejected?.(token),
  });
  const directory = new MmDirectory(client);
  directory.remember({ id: session.userId, username: session.username, displayName: null, lastPictureUpdate: null });
  const categories = new MmCategories(client, session.userId);
  const live = new MmLive(client, directory, session.userId, categories);
  const translator = new MmTranslator(directory, session.userId, categories);
  const history = new MmHistory(client, live);
  const catchUp = new MmCatchUp({ client, directory, live, history, categories, myId: session.userId, deletedRoute: kchat });
  const actions = new MmActions({ client, directory, live, translator, myId: session.userId, categories });
  const expand = (name: string, data: Record<string, unknown>, broadcast: Record<string, unknown>) =>
    live.expand(name, data, broadcast);
  const listener =
    options.listener ??
    (kchat
      ? new KchatPusher(client, expand)
      : new MmSocket(`${session.baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '')}/api/v4/websocket`, expand));

  return {
    identity: { kind: session.kind, origin: session.baseUrl, accountId: session.userId, instanceId: null, generation: null },
    describeError: describeMmError,
    capabilities: kchat ? { ...MATTERMOST_CAPABILITIES, videoCall: true } : MATTERMOST_CAPABILITIES,
    calls: kchat ? kmeetCalls(client) : undefined,
    sidebarSettings: mattermostSidebarSettings(client, session.userId),
    listener,
    translator,
    actions,
    async searchMessages(rid: string, text: string): Promise<LocalMessage[]> {
      const teamId = await teamOf(client, live, rid);
      if (teamId === null) return [];
      const list = await client.post<Record<string, unknown>>(`/teams/${teamId}/posts/search`, {
        body: { terms: text, is_or_search: false, page: 0, per_page: 60 },
      });
      const posts = ordered(list as Parameters<typeof ordered>[0]).filter((p) => p.channel_id === rid);
      await live.ensureAuthors(posts);
      return posts.map((p) => translator.toMessage(p)).filter((m): m is LocalMessage => m !== null);
    },
    async loadPresence() {
      const ids = directory.knownIds();
      if (ids.length === 0) return [];
      const list = await client.post<unknown>('/users/status/ids', { body: ids });
      return (Array.isArray(list) ? list : []).flatMap((raw) => {
        const s = record(raw);
        const status = s?.status === 'dnd' ? 'busy' : s?.status;
        return typeof s?.user_id === 'string' && (status === 'online' || status === 'away' || status === 'busy' || status === 'offline')
          ? [{ user: { id: s.user_id }, status }]
          : [];
      });
    },
    displayNames: {
      names: () => directory.displayNames(),
      statuses: () => directory.statusEmojis(),
      subscribe: (listener) => directory.onChange(listener),
    },
    async listCustomEmojis() {
      const out: CustomEmoji[] = [];
      for (const raw of await client.pages<unknown>('/emoji')) {
        const e = record(raw);
        if (typeof e?.id !== 'string' || typeof e.name !== 'string') continue;
        out.push({ name: e.name, extension: 'png', aliases: [], uri: client.url(`/emoji/${e.id}/image`) });
      }
      return out;
    },
    async readProfile(target) {
      const raw = target.uid
        ? await client.get<Record<string, unknown>>(`/users/${target.uid}`)
        : await client.get<Record<string, unknown>>(`/users/username/${encodeURIComponent(target.username ?? '')}`);
      const user = toMmUser(raw);
      if (user === null) return undefined;
      directory.remember(user);
      const named = directory.user(user.id) ?? user;
      const roles = String(raw.roles ?? '').split(/\s+/).includes('system_admin') ? ['admin'] : [];
      return { _id: user.id, username: user.username, name: named.displayName, roles, bio: typeof raw.position === 'string' && raw.position !== '' ? raw.position : null };
    },
    initialSubscriptions: () => [],
    roomSubscriptions: (rid: string) => [[MM_ROOM, rid]],
    privateNote(event: DdpEvent) {
      if (event.collection !== 'ephemeral_message') return null;
      const post = record(record(event.args[0])?.post);
      if (post === null || typeof post.channel_id !== 'string' || typeof post.message !== 'string') return null;
      return { rid: post.channel_id, text: post.message };
    },
    loadHistory: (engine, rid, _type, latest) => history.loadHistory(engine, rid, latest),
    historyRange: (rid, _type, latest, oldest) => history.range(rid, latest, oldest),
    fetchMessage: (id) => history.fetch(id),
    historyPage: MM_HISTORY_PAGE,
    loadThread: (engine, threadId, isDiscarded) => history.loadThread(engine, threadId, isDiscarded),
    createOutbox(store: OutboxStore, ingest: Ingest): Outbox {
      return new MmOutbox({ store, client, me: { id: session.userId, username: session.username }, generateId, ingest });
    },
    createUploadQueue(
      store: UploadStore,
      transport: TransportUpload,
      ingest: Ingest,
      hooks?: { deleteLocalFile?: (uri: string) => Promise<void>; refreshRoom?: (rid: string) => Promise<void> },
    ): FileOutbox {
      return new MmUploadQueue({
        store,
        client,
        transport,
        generateId,
        myId: session.userId,
        ingest,
        deleteLocalFile: hooks?.deleteLocalFile,
        refreshRoom: hooks?.refreshRoom,
      });
    },
    catchUpGlobal: (engine, isDiscarded) => catchUp.global(engine, isDiscarded),
    catchUpRoom: (engine, rid, isDiscarded) => catchUp.room(engine, rid, isDiscarded),
    reconcile: (engine, isDiscarded) => catchUp.reconcile(engine, isDiscarded),
  };
}

export function describeMmError(error: unknown, authenticated: boolean): ProviderError {
  if (error instanceof MmError) {
    return {
      code: error.id ?? 'server_error',
      status: error.status,
      requestId: null,
      retryAfter: null,
      rejectsSession: authenticated && error.rejectsToken,
      twoFactorChallenge: false,
    };
  }
  return { code: 'connection_failed', status: 0, requestId: null, retryAfter: null, rejectsSession: false, twoFactorChallenge: false };
}

/** A DM has no team: any team of mine searches it. */
async function teamOf(client: MmClient, live: MmLive, rid: string): Promise<string | null> {
  const known = live.channels.get(rid)?.team_id;
  if (typeof known === 'string' && known !== '') return known;
  const teams = await client.get<Record<string, unknown>[]>('/users/me/teams');
  const first = Array.isArray(teams) ? teams[0]?.id : undefined;
  return typeof first === 'string' ? first : null;
}
