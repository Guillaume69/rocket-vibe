/**
 * Assembles a Slack `Provider` for a session: read-only for now. Rooms,
 * badges, history and threads come over the Web API; every write, file,
 * search and live event is still to come, and the capabilities hide them.
 */

import type { Session } from '../../lib/auth.ts';
import type { Capabilities, FileOutbox, Listener, Outbox, Provider, ProviderActions, ProviderError } from '../../lib/provider.ts';
import type { RestClient } from '../../lib/rest.ts';
import { slackClientFor } from './auth.ts';
import { SlackCatchUp } from './catchUp.ts';
import { SlackError } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { SLACK_HISTORY_PAGE, SlackHistory } from './history.ts';
import { SlackIdleListener } from './listener.ts';
import { SlackTranslator } from './translator.ts';

export const SLACK_CAPABILITIES: Capabilities = {
  editing: false,
  deletion: false,
  files: false,
  threads: true,
  reactions: false,
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
  sending: false,
  typing: false,
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

export const SLACK_ACTIONS: ProviderActions = {
  roomInfo: unsupported,
  react: unsupported,
  edit: unsupported,
  delete: unsupported,
  pin: unsupported,
  unpin: unsupported,
  star: unsupported,
  listPinned: unsupported,
  listStarred: unsupported,
  markRead: unsupported,
  openOrCreateDm: unsupported,
};

export function createSlackProvider(session: Session, rest: RestClient, options: SlackOptions = {}): Provider {
  const client = slackClientFor(session, { fetch: options.fetch, onRejected: () => rest.onTokenRejected?.(session.authToken) });
  const directory = new SlackDirectory(client, session.baseUrl);
  const roomNames = new Map<string, string>();
  const translator = new SlackTranslator(directory, session.userId, roomNames);
  const history = new SlackHistory(client, directory);
  const catchUp = new SlackCatchUp({ client, directory, history, roomNames, myId: session.userId });
  const listener = options.listener ?? new SlackIdleListener();
  const outbox: Outbox = { send: unsupported, process: async () => {}, retry: unsupported, discard: async () => {} };
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
    actions: SLACK_ACTIONS,
    displayNames: {
      names: () => directory.displayNames(),
      statuses: () => new Map(),
      subscribe: (fn) => directory.onChange(fn),
    },
    initialSubscriptions: () => [],
    roomSubscriptions: () => [],
    privateNote: () => null,
    loadHistory: (engine, rid, _type, latest) => history.loadHistory(engine, rid, latest),
    historyRange: (rid, _type, latest, oldest) => history.range(rid, latest, oldest),
    fetchMessage: (id) => history.fetch(id),
    historyPage: SLACK_HISTORY_PAGE,
    loadThread: (engine, threadId, isDiscarded) => history.loadThread(engine, threadId, isDiscarded),
    createOutbox: () => outbox,
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
