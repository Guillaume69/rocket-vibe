/**
 * Assembles a Slack `Provider` for a session. Rooms, badges, history and
 * threads come over the Web API, live updates over the RTM socket. Text
 * goes out through the outbox (roots, replies, replies also in the room),
 * and edit, delete, react and mark read through the actions; files,
 * search, pins and rooms are still to come, and the capabilities hide them.
 */

import type { Session } from '../../lib/auth.ts';
import type { Capabilities, FileOutbox, Listener, Provider, ProviderError } from '../../lib/provider.ts';
import type { RestClient } from '../../lib/rest.ts';
import { slackClientFor } from './auth.ts';
import { SlackActions } from './actions.ts';
import { SlackCatchUp } from './catchUp.ts';
import { SlackError, record, type SlackClient } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { SLACK_HISTORY_PAGE, SlackHistory } from './history.ts';
import { SlackLive } from './live.ts';
import { SlackOutbox } from './outbox.ts';
import { SlackRtm } from './rtm.ts';
import { SLACK_FILES, SlackTranslator } from './translator.ts';
import { setMediaLease } from '../../lib/mediaAuth.ts';
import { slackCalls } from './calls.ts';
import type { CustomEmoji } from '../../lib/customEmojis.ts';

export const SLACK_CAPABILITIES: Capabilities = {
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
  alsoInRoom: true,
  voice: false,
  administration: false,
  reports: false,
  scheduledMessages: false,
  sending: true,
  typing: true,
  presence: false,
  push: false,
  e2ee: false,
  customEmojis: true,
  videoCall: true,
  search: false,
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

const unsupported = async (): Promise<never> => {
  throw new SlackError('unsupported');
};
const noSubscription = () => () => {};

export function createSlackProvider(session: Session, rest: RestClient, generateId: () => string, options: SlackOptions = {}): Provider {
  if (session.slackCookie) setMediaLease(SLACK_FILES, session.authToken, session.userId, { Authorization: `Bearer ${session.authToken}`, Cookie: `d=${session.slackCookie}` });
  const client = slackClientFor(session, { fetch: options.fetch, onRejected: () => rest.onTokenRejected?.(session.authToken) });
  const directory = new SlackDirectory(client, session.baseUrl);
  const roomNames = new Map<string, string>();
  const translator = new SlackTranslator(directory, session.userId, roomNames);
  const history = new SlackHistory(client, directory);
  const live = new SlackLive({ client, directory, history, myId: session.userId });
  const catchUp = new SlackCatchUp({ client, directory, history, roomNames, live, myId: session.userId });
  const rtm = options.listener ?? new SlackRtm(client, (frame) => live.expand(frame));
  const listener = rtm;
  const actions = new SlackActions({ client, directory, history, live });
  const files: FileOutbox = {
    progress: new Map(), subscribe: noSubscription, validate: unsupported,
    send: unsupported, process: async () => {}, retry: unsupported, discard: async () => {},
  };

  return {
    identity: { kind: 'slack', origin: session.baseUrl, accountId: session.userId, instanceId: null, generation: null },
    describeError: describeSlackError,
    capabilities: SLACK_CAPABILITIES,
    listener,
    translator,
    actions,
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
    createUploadQueue: () => files,
    catchUpGlobal: (engine, isDiscarded) => catchUp.global(engine, isDiscarded),
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
