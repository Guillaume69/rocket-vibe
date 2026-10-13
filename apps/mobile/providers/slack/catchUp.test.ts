import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SyncEngine } from '../../lib/sync.ts';
import { memoryStore } from '../mattermost/testing.ts';
import { SlackCatchUp } from './catchUp.ts';
import { SlackClient } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { SlackHistory } from './history.ts';
import { COOKIE, TOKEN, fakeSlack, historyOf, message, type SlackAnswer, type SlackCall } from './testing.ts';
import { SlackTranslator } from './translator.ts';

const ROSTER = [
  [{ id: 'C001', name: 'general', is_channel: true, updated: 1780000000000 }, { id: 'G001', name: 'secret', is_private: true }],
  [{ id: 'D001', is_im: true, user: 'U001' }, { id: 'G002', name: 'mpdm-me--alice-1', is_mpim: true, is_private: true }],
];
const COUNTS = {
  ok: true,
  channels: [{ id: 'C001', has_unreads: true, mention_count: 2, last_read: '1780000001.000000', latest: '1780000009.000000' }, { id: 'G001', has_unreads: false, mention_count: 0, last_read: '1780000002.000000', latest: '1780000002.000000' }],
  ims: [{ id: 'D001', has_unreads: true, mention_count: 0, last_read: '1780000003.000000', latest: '1780000010.000000' }],
  mpims: [{ id: 'G002', has_unreads: false, mention_count: 0, last_read: '0000000000.000000', latest: '1780000001.000000' }],
};
const USERS: Record<string, { id: string; name: string; profile: Record<string, string> }> = {
  U000: { id: 'U000', name: 'me', profile: { display_name: 'Me' } },
  U001: { id: 'U001', name: 'alice', profile: { real_name: 'Alice A', image_72: 'https://avatars.example/a.png' } },
};

function setup(route: (call: SlackCall) => SlackAnswer | undefined = () => undefined) {
  const server = fakeSlack((call) => {
    const own = route(call);
    if (own !== undefined) return own;
    if (call.method === 'users.conversations') {
      const page = call.args.cursor === 'next' ? 1 : 0;
      return { body: { ok: true, channels: ROSTER[page], response_metadata: { next_cursor: page === 0 ? 'next' : '' } } };
    }
    if (call.method === 'client.counts') return { body: COUNTS };
    if (call.method === 'users.info') return USERS[call.args.user!] ? { body: { ok: true, user: USERS[call.args.user!] } } : { body: { ok: false, error: 'user_not_found' } };
    if (call.method === 'conversations.history') return { body: historyOf([message(`1780000009.00000${call.args.channel === 'C001' ? 1 : 2}`, { text: `last in ${call.args.channel}` })], call.args) };
    return undefined;
  });
  const client = new SlackClient(TOKEN, COOKIE, { fetch: server.fetcher, sleep: async () => {} });
  const directory = new SlackDirectory(client, 'https://test.slack.com');
  const roomNames = new Map<string, string>();
  const history = new SlackHistory(client, directory);
  const local = memoryStore();
  const engine = new SyncEngine(local.store, new SlackTranslator(directory, 'U000', roomNames));
  return { server, engine, history, roomNames, catchUp: new SlackCatchUp({ client, directory, history, roomNames, myId: 'U000' }), ...local };
}

test('the global pass walks the roster cursor, maps client.counts and previews the recent rooms', async () => {
  const { server, engine, catchUp, rooms, subscriptions, roomNames } = setup();
  await catchUp.global(engine, () => false);
  const roster = server.calls.filter((c) => c.method === 'users.conversations');
  assert.deepEqual(roster.map((c) => c.args.cursor), [undefined, 'next']);
  assert.deepEqual([roster[0]!.args.types, roster[0]!.args.exclude_archived, roster[0]!.args.limit], ['public_channel,private_channel,mpim,im', 'true', '200']);
  assert.deepEqual([...rooms.keys()].sort(), ['C001', 'D001', 'G001', 'G002']);
  assert.deepEqual([rooms.get('D001')?.name, rooms.get('D001')?.displayName], ['alice', 'Alice A']);
  assert.equal(rooms.get('G002')?.displayName, 'Alice A');
  assert.equal(rooms.get('C001')?.lastMessage, 'last in C001');
  assert.equal(roomNames.get('C001'), 'general');
  const c001 = subscriptions.get('C001')!;
  assert.deepEqual([c001.alert, c001.unread, c001.mentions, c001.lastSeen], [true, 2, 2, 1780000001000]);
  const d001 = subscriptions.get('D001')!;
  assert.deepEqual([d001.alert, d001.unread, d001.mentions], [true, 1, 0]);
  assert.deepEqual([subscriptions.get('G001')?.unread, subscriptions.get('G002')?.lastSeen], [0, null]);
  assert.equal(server.calls.filter((c) => c.method === 'conversations.history').length, 4);
});

test('a roster cursor seen twice fails the pass before anything is written', async () => {
  const { engine, catchUp, rooms } = setup((call) => (call.method === 'users.conversations' ? { body: { ok: true, channels: ROSTER[0], response_metadata: { next_cursor: 'again' } } } : undefined));
  await assert.rejects(catchUp.global(engine, () => false), /pagination_loop/);
  assert.equal(rooms.size, 0);
});

test('client.counts failing leaves the rooms listed without badges', async () => {
  const { engine, catchUp, rooms, subscriptions } = setup((call) => (call.method === 'client.counts' ? { body: { ok: false, error: 'unknown_method' } } : undefined));
  await catchUp.global(engine, () => false);
  assert.equal(rooms.size, 4);
  assert.ok([...subscriptions.values()].every((s) => s.unread === 0 && s.mentions === 0 && !s.alert));
});

test('a room catches up forward from its newest exact ts', async () => {
  const room = [message('1780000001.000001'), message('1780000002.000002')];
  const { server, engine, history, catchUp, messages } = setup((call) => (call.method === 'conversations.history' ? { body: historyOf(room, call.args) } : undefined));
  await history.loadHistory(engine, 'C001');
  room.push(message('1780000002.000003'), message('1780000003.000000'));
  await catchUp.room(engine, 'C001', () => false);
  const pass = server.calls.filter((c) => c.method === 'conversations.history').at(-1)!;
  assert.deepEqual([pass.args.oldest, pass.args.inclusive], ['1780000002.000002', undefined]);
  assert.equal(messages.size, 4);
});

test('after a restart a room catches up from its stored millisecond, inclusive', async () => {
  const room = [message('1780000002.000002'), message('1780000002.000700')];
  const { server, engine, catchUp, messages, store } = setup((call) => (call.method === 'conversations.history' ? { body: historyOf(room, call.args) } : undefined));
  await catchUp.room(engine, 'C001', () => false);
  assert.equal(server.calls.length, 0);
  await engine.ingestMessages([{ ...message('1780000002.000002'), channel: 'C001' }]);
  assert.equal(await store.lastMessageUpdatedAt('C001'), 1780000002000);
  await catchUp.room(engine, 'C001', () => false);
  assert.deepEqual([server.calls[0]!.args.oldest, server.calls[0]!.args.inclusive], ['1780000002.000000', 'true']);
  assert.equal(messages.size, 2);
});

test('reconcile purges against the complete roster only', async () => {
  const { engine, catchUp, purges } = setup();
  await catchUp.reconcile(engine, () => false);
  assert.deepEqual(purges[0]?.alive, ['C001', 'G001', 'D001', 'G002']);
});
