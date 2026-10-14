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
import { SlackError } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { SLACK_HISTORY_PAGE, SlackHistory } from './history.ts';
import { SlackLive } from './live.ts';
import { SlackOutbox } from './outbox.ts';
import { SlackRtm } from './rtm.ts';
import { SlackTranslator } from './translator.ts';

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
  customEmojis: false,
  videoCall: false,
  search: false,
  threadTemplate: 'tmid',
};

export type SlackOptions = { fetch?: typeof fetch; listener?: Listener };

const unsupported = async (): Promise<never> => {
  throw new SlackError('unsupported');
};
const noSubscription = () => () => {};

export function createSlackProvider(session: Session, rest: RestClient, generateId: () => string, options: SlackOptions = {}): Provider {
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
      statuses: () => new Map(),
      subscribe: (fn) => directory.onChange(fn),
    },
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
