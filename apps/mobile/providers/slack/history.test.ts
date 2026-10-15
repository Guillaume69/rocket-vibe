import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SyncEngine } from '../../lib/sync.ts';
import { memoryStore } from '../mattermost/testing.ts';
import { SlackClient } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { SlackHistory } from './history.ts';
import { COOKIE, TOKEN, fakeSlack, historyOf, message, type SlackCall, type SlackAnswer } from './testing.ts';
import { SlackTranslator } from './translator.ts';

/** 120 messages, three to a millisecond: every page boundary cuts through one. */
const ROOM = Array.from({ length: 120 }, (_, i) => message(`${1780000000 + Math.floor(i / 3)}.00000${i % 3}`));

function setup(route: (call: SlackCall) => SlackAnswer | undefined) {
  const server = fakeSlack((call) => route(call) ?? (call.method === 'users.info' ? { body: { ok: true, user: { id: call.args.user, name: 'alice' } } } : undefined));
  const client = new SlackClient(TOKEN, COOKIE, { fetch: server.fetcher });
  const directory = new SlackDirectory(client, 'https://test.slack.com');
  const local = memoryStore();
  const engine = new SyncEngine(local.store, new SlackTranslator(directory, 'U000'));
  return { server, client, directory, engine, history: new SlackHistory(client, directory), ...local };
}

test('history pages back by exact ts, through shared milliseconds, without gaps or repeats', async () => {
  const { server, engine, history, messages } = setup((call) => (call.method === 'conversations.history' ? { body: historyOf(ROOM, call.args) } : undefined));
  let page = await history.loadHistory(engine, 'C001');
  assert.equal(messages.size, 50);
  for (let n = 0; n < 5 && page.oldest !== null; n++) page = await history.loadHistory(engine, 'C001', new Date(page.oldest).toISOString());
  assert.equal(messages.size, 120);
  assert.ok([...messages.values()].every((m) => m.authorName === 'alice'));
  const reads = server.calls.filter((c) => c.method === 'conversations.history');
  assert.equal(reads[0]!.args.latest, undefined);
  assert.equal(reads[1]!.args.latest, '1780000023.000001');
  assert.equal(reads[1]!.args.inclusive, undefined);
  assert.equal(server.calls.filter((c) => c.method === 'users.info').length, 1);
});

test('a bound unknown to this session asks up to the end of its millisecond, inclusive', async () => {
  const { server, engine, history, messages } = setup((call) => (call.method === 'conversations.history' ? { body: historyOf(ROOM, call.args) } : undefined));
  await history.loadHistory(engine, 'C001', new Date(1780000010000).toISOString());
  const read = server.calls.find((c) => c.method === 'conversations.history')!;
  assert.deepEqual([read.args.latest, read.args.inclusive, read.args.limit], ['1780000010.000999', 'true', '50']);
  assert.ok(messages.has('C001:1780000010.000002'));
  assert.ok(!messages.has('C001:1780000011.000000'));
});

test('a range is one page between millisecond bounds, not ingested', async () => {
  const { server, history, messages } = setup((call) => (call.method === 'conversations.history' ? { body: historyOf(ROOM, call.args) } : undefined));
  const docs = await history.range('C001', 1780000005000, 1780000003000);
  assert.deepEqual(docs.map((m) => m.ts), ['1780000005.000002', '1780000005.000001', '1780000005.000000', '1780000004.000002', '1780000004.000001', '1780000004.000000', '1780000003.000002', '1780000003.000001', '1780000003.000000']);
  assert.ok(docs.every((m) => m.channel === 'C001'));
  assert.deepEqual([server.calls[0]!.args.latest, server.calls[0]!.args.oldest], ['1780000005.000999', '1780000003.000000']);
  assert.equal(messages.size, 0);
});

test('one message is fetched by its exact ts and nothing else is taken for it', async () => {
  const { history } = setup((call) => (call.method === 'conversations.history' ? { body: historyOf(ROOM, call.args) } : undefined));
  assert.equal((await history.fetch('C001:1780000002.000001'))?.ts, '1780000002.000001');
  assert.equal(await history.fetch('C001:1780000002.000009'), null);
  assert.equal(await history.fetch('not-an-id'), null);
});

test('a thread is read whole across pages, its repeated root kept once', async () => {
  const root = message('1780000000.000100', { thread_ts: '1780000000.000100', reply_count: 3, latest_reply: '1780000003.000000' });
  const replies = [1, 2, 3].map((n) => message(`178000000${n}.000000`, { thread_ts: '1780000000.000100', user: 'U002' }));
  const pages: Record<string, unknown>[] = [
    { ok: true, messages: [root, replies[0]], has_more: true, response_metadata: { next_cursor: 'p2' } },
    { ok: true, messages: [root, replies[1], replies[2]], has_more: false, response_metadata: { next_cursor: '' } },
  ];
  const { server, engine, history, messages } = setup((call) => (call.method === 'conversations.replies' ? { body: pages[call.args.cursor === 'p2' ? 1 : 0] } : undefined));
  await history.loadThread(engine, 'C001:1780000000.000100', () => false);
  assert.deepEqual(server.calls.filter((c) => c.method === 'conversations.replies').map((c) => [c.args.channel, c.args.ts, c.args.cursor]), [['C001', '1780000000.000100', undefined], ['C001', '1780000000.000100', 'p2']]);
  assert.equal(messages.size, 4);
  assert.equal(messages.get('C001:1780000000.000100')?.threadCount, 3);
  assert.ok(replies.every((r) => messages.get(`C001:${r.ts}`)?.threadId === 'C001:1780000000.000100'));
});
