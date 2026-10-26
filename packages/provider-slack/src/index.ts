/**
 * Assembles a Slack `Provider` for a session. Rooms, badges, history and
 * threads come over the Web API, live updates over the RTM socket. Text
 * goes out through the outbox (roots, replies, replies also in the room),
 * files through the upload queue, and edit, delete, react, mark read, pins
 * and saves through the actions, people found and direct conversations
 * opened from "New conversation"; creating rooms is still to come.
 */

import type { Session, TokenRejection } from '@rocket-vibe/provider-api/session';
import type { Capabilities, Listener, Provider, ProviderError } from '@rocket-vibe/provider-api/provider';
import { slackClientFor } from './auth.ts';
import { SlackActions } from './actions.ts';
import { slackActivity } from './activity.ts';
import { SlackCatchUp } from './catchUp.ts';
import { SlackError, record, type SlackClient } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { SLACK_HISTORY_PAGE, SlackHistory } from './history.ts';
import { SlackLive } from './live.ts';
import { SlackOutbox } from './outbox.ts';
import { SlackRtm } from './rtm.ts';
import { SlackSaved } from './saved.ts';
import { searchSlackMessages } from './search.ts';
import { SlackUploadQueue } from './uploads.ts';
import { SLACK_FILES, SlackTranslator } from './translator.ts';
import { setMediaLease } from '@rocket-vibe/provider-api/mediaAuth';
import { slackCalls } from './calls.ts';
import type { CustomEmoji } from '@rocket-vibe/provider-api/emojis';

export const SLACK_CAPABILITIES: Capabilities = {
  editing: true,
  deletion: true,
  files: true,
  threads: true,
  reactions: true,
  marks: true,
  profile: false,
  roomInfo: true,
  roomSettings: true,
  roomRoleList: false,
  leaveRoom: false,
  roomFavorites: false,
  roomReads: false,
  quotes: false,
  alsoInRoom: true,
  voice: false,
  administration: false,
  reports: false,
  scheduledMessages: false,
  sending: true,
  typing: true,
  presence: true,
  push: false,
  e2ee: false,
  customEmojis: true,
  videoCall: true,
  search: true,
  threadTemplate: 'tmid',
};

export type SlackOptions = { fetch?: typeof fetch; listener?: Listener };

/** Slack's custom emoji, read from `emoji.list`, aliases of another custom one followed. */
export async function slackCustomEmojis(client: SlackClient): Promise<CustomEmoji[]> {
  const list = record((await client.call('emoji.list')).emoji ?? {});
  const resolve = (name: string): string | null => {
    let value = list[name];
    for (let n = 0; n < 4 && typeof value === 'string' && value.startsWith('alias:'); n++) value = list[value.slice(6)];
    return typeof value === 'string' && value.startsWith(CUSTOM_EMOJI_ORIGIN) ? value : null;
  };
  return Object.keys(list).sort().flatMap((name) => {
    const uri = resolve(name);
    return uri === null ? [] : [{ name, extension: uri.split('?')[0]!.split('.').pop() ?? 'png', aliases: [], uri }];
  });
}

/** Where Slack serves a workspace's custom emoji, public like its avatars. */
export const CUSTOM_EMOJI_ORIGIN = 'https://emoji.slack-edge.com/';

export function createSlackProvider(session: Session, rest: TokenRejection, generateId: () => string, options: SlackOptions = {}): Provider {
  if (session.slackCookie) setMediaLease(SLACK_FILES, session.authToken, session.userId, { Authorization: `Bearer ${session.authToken}`, Cookie: `d=${session.slackCookie}` });
  const client = slackClientFor(session, { fetch: options.fetch, onRejected: () => rest.onTokenRejected?.(session.authToken) });
  const directory = new SlackDirectory(client, session.baseUrl);
  const roomNames = new Map<string, string>();
  const history = new SlackHistory(client, directory);
  const saved = new SlackSaved(client, history);
  const translator = new SlackTranslator(directory, session.userId, roomNames, saved.ids);
  const live = new SlackLive({ client, directory, history, myId: session.userId, roomNames });
  const catchUp = new SlackCatchUp({ client, directory, history, roomNames, live, myId: session.userId });
  const rtm = options.listener ?? new SlackRtm(client, (frame) => live.expand(frame));
  const listener = rtm;
  if (rtm instanceof SlackRtm) rtm.onLoss(() => live.presence.clear());
  const actions = new SlackActions({ client, directory, history, live, translator, saved });

  return {
    identity: { kind: 'slack', origin: session.baseUrl, accountId: session.userId, instanceId: null, generation: null },
    describeError: describeSlackError,
    capabilities: SLACK_CAPABILITIES,
    listener,
    translator,
    actions,
    ownActivity: slackActivity(client, session.userId),
    searchMessages: (rid, text) => searchSlackMessages({ client, history, translator }, rid, text),
    searchPeople: async (query) =>
      (await directory.searchPeople(query, session.userId)).map((user) => ({ id: user.id, name: user.username, detail: user.displayName ?? user.username })),
    async loadPresence() {
      if (rtm instanceof SlackRtm) rtm.watchPresence(live.presenceIds());
      const mine = await slackActivity(client, session.userId).read();
      live.presence.set(session.userId, mine);
      return [...live.presence].map(([id, status]) => ({ user: { id }, status }));
    },
    displayNames: {
      names: () => directory.displayNames(),
      statuses: () => directory.statusEmojis(),
      subscribe: (fn) => directory.onChange(fn),
    },
    listCustomEmojis: () => slackCustomEmojis(client),
    calls: slackCalls(session.slackTeamId ?? ''),
    initialSubscriptions: () => [],
    roomSubscriptions: () => [],
    setTyping: (channel, active) => {
      if (!(rtm instanceof SlackRtm)) return;
      if (active) rtm.sendTyping(channel);
      else rtm.stopTyping(channel);
    },
    privateNote: () => null,
    loadHistory: (engine, rid, _type, latest) => history.loadHistory(engine, rid, latest),
    historyRange: (rid, _type, latest, oldest) => history.range(rid, latest, oldest),
    fetchMessage: (id) => history.fetch(id),
    historyPage: SLACK_HISTORY_PAGE,
    loadThread: (engine, threadId, isDiscarded) => history.loadThread(engine, threadId, isDiscarded),
    createOutbox: (store, ingest) =>
      new SlackOutbox({ store, client, directory, me: { id: session.userId, username: session.username }, generateId, ingest }),
    createUploadQueue: (store, transport, ingest, hooks) =>
      new SlackUploadQueue({ store, client, directory, history, transport, generateId, ingest, fileSize: hooks?.fileSize, deleteLocalFile: hooks?.deleteLocalFile }),
    async catchUpGlobal(engine, isDiscarded) {
      await catchUp.global(engine, isDiscarded);
      if (isDiscarded()) return;
      // Saves are an internal list Slack may refuse: the stars then stay as they were.
      const moved = await saved.reset().catch(() => []);
      for (const event of moved) await engine.apply(event);
    },
    catchUpRoom: (engine, rid, isDiscarded) => catchUp.room(engine, rid, isDiscarded),
    reconcile: (engine, isDiscarded) => catchUp.reconcile(engine, isDiscarded),
  };
}

export function describeSlackError(error: unknown, authenticated: boolean): ProviderError {
  if (error instanceof SlackError) {
    return {
      code: error.code,
      status: error.status,
      requestId: null,
      retryAfter: error.retryAfter,
      rejectsSession: authenticated && error.rejectsSession,
      twoFactorChallenge: false,
    };
  }
  return { code: 'connection_failed', status: 0, requestId: null, retryAfter: null, rejectsSession: false, twoFactorChallenge: false };
}
