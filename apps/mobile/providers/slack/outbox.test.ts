import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { LocalMessage } from '../../lib/normalize.ts';
import type { OutboxRow, OutboxStore } from '../../lib/outbox.ts';
import { SlackClient } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { SlackOutbox, clientMsgId } from './outbox.ts';
import { COOKIE, TOKEN, fakeSlack, type SlackAnswer, type SlackCall } from './testing.ts';

function outboxStore() {
  const rows = new Map<string, OutboxRow>();
  const messages = new Map<string, LocalMessage>();
  const failures = new Map<string, string>();
  const store: OutboxStore = {
    enqueueMessage: async (m) => {
      rows.set(m.id, { id: m.id, rid: m.rid, text: m.text, threadId: m.threadId, shown: m.threadShown, status: 'pending', attempts: 0, createdAt: m.ts });
      messages.set(m.id, m);
    },
    listToSend: async () => [...rows.values()].filter((r) => r.status === 'pending'),
    markFailed: async (id, error) => {
      const row = rows.get(id);
      if (row) row.status = 'failed';
      failures.set(id, error);
    },
    rearm: async (id) => {
      const row = rows.get(id);
      if (row?.status === 'failed') row.status = 'pending';
    },
    deleteOutbox: async (id) => void rows.delete(id),
    upsertMessage: async (m) => void messages.set(m.id, m),
    deleteOptimisticMessage: async (id) => {
      if (messages.get(id)?.updatedAt === 0) messages.delete(id);
    },
    roomEncrypted: async () => false,
  };
  return { store, rows, messages, failures };
}

const NOW = 1_780_000_000_000;

function setup(route: (call: SlackCall) => SlackAnswer | undefined, now = NOW) {
  const server = fakeSlack(route);
  const local = outboxStore();
  const ingested: Record<string, unknown>[] = [];
  const client = new SlackClient(TOKEN, COOKIE, { fetch: server.fetcher, sleep: async () => {} });
  const directory = new SlackDirectory(client, 'https://test.slack.com');
  directory.remember({ id: 'U001', username: 'alice', displayName: null, avatar: null });
  const outbox = new SlackOutbox({
    store: local.store,
    client,
    directory,
    me: { id: 'U000', username: 'me' },
    generateId: () => 'local1',
    ingest: async (doc) => void ingested.push(doc),
    now: () => now,
  });
  return { outbox, server, ingested, ...local };
}

const posted = (ts: string, extra: Record<string, unknown> = {}) => ({ body: { ok: true, channel: 'C001', ts, message: { type: 'message', user: 'U000', text: 'hi', ts, ...extra } } });

describe('clientMsgId', () => {
  test('is a stable UUID v4 shape per row', () => {
    const id = clientMsgId('local1');
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(clientMsgId('local1'), id);
    assert.notEqual(clientMsgId('local2'), id);
  });
});

describe('SlackOutbox', () => {
  test('a root message goes out with its marker, in mrkdwn, and replaces the optimistic row', async () => {
    const { outbox, server, ingested, rows, messages } = setup((call) => (call.method === 'chat.postMessage' ? posted('1780000000.000100') : undefined));
    await outbox.send('C001', '**hi** @alice');
    const call = server.calls[0]!;
    assert.equal(call.method, 'chat.postMessage');
    assert.deepEqual([call.args.channel, call.args.text, call.args.client_msg_id], ['C001', '*hi* <@U001>', clientMsgId('local1')]);
    assert.equal(call.args.thread_ts, undefined);
    assert.equal(ingested[0]?.channel, 'C001');
    assert.equal(ingested[0]?.ts, '1780000000.000100');
    assert.equal(rows.size, 0);
    assert.equal(messages.size, 0);
  });

  test('a reply carries thread_ts, and reply_broadcast only when also sent to the room', async () => {
    const { outbox, server } = setup((call) => (call.method === 'chat.postMessage' ? posted('1780000000.000200') : undefined));
    await outbox.send('C001', 'in thread', 'C001:1780000000.000100');
    await outbox.send('C001', 'also in room', 'C001:1780000000.000100', null, undefined, true);
    assert.equal(server.calls[0]!.args.thread_ts, '1780000000.000100');
    assert.equal(server.calls[0]!.args.reply_broadcast, undefined);
    assert.equal(server.calls[1]!.args.reply_broadcast, 'true');
  });

  test('a refusal fails the row without looking it up', async () => {
    const { outbox, server, rows, failures } = setup((call) => (call.method === 'chat.postMessage' ? { body: { ok: false, error: 'is_archived' } } : undefined));
    await outbox.send('C001', 'hi');
    assert.equal(rows.get('local1')?.status, 'failed');
    assert.match(failures.get('local1')!, /is_archived/);
    assert.deepEqual(server.calls.map((c) => c.method), ['chat.postMessage']);
  });

  test('a lost answer finds the message by its marker and settles it', async () => {
    const { outbox, ingested, rows } = setup((call) => {
      if (call.method === 'chat.postMessage') return { status: 502 };
      if (call.method === 'conversations.history') {
        return { body: { ok: true, has_more: false, messages: [{ type: 'message', user: 'U000', ts: '1780000000.000300', text: 'hi', client_msg_id: clientMsgId('local1') }] } };
      }
      return undefined;
    });
    await outbox.send('C001', 'hi');
    assert.equal(rows.size, 0);
    assert.equal(ingested[0]?.ts, '1780000000.000300');
  });

  test('a lost answer with nothing found is delivery unknown, never replayed', async () => {
    const { outbox, server, rows, failures } = setup((call) => {
      if (call.method === 'chat.postMessage') return { status: 502 };
      if (call.method === 'conversations.history') return { body: { ok: true, has_more: false, messages: [] } };
      return undefined;
    });
    await outbox.send('C001', 'hi');
    await outbox.process();
    assert.equal(rows.get('local1')?.status, 'failed');
    assert.match(failures.get('local1')!, /could not be confirmed/);
    assert.equal(server.calls.filter((c) => c.method === 'chat.postMessage').length, 1);
  });

  test('a same-text message without my marker proves nothing', async () => {
    const { outbox, rows } = setup((call) => {
      if (call.method === 'chat.postMessage') return { status: 502 };
      if (call.method === 'conversations.history') {
        return { body: { ok: true, has_more: false, messages: [{ type: 'message', user: 'U000', ts: '1780000000.000300', text: 'hi', client_msg_id: 'someone-else' }] } };
      }
      return undefined;
    });
    await outbox.send('C001', 'hi');
    assert.equal(rows.get('local1')?.status, 'failed');
  });

  test('a row queued before a restart is looked for before any replay', async () => {
    const { outbox, server, rows } = setup((call) => {
      if (call.method === 'conversations.history') {
        return { body: { ok: true, has_more: false, messages: [{ type: 'message', user: 'U000', ts: '1780000000.000400', text: 'old', client_msg_id: clientMsgId('old1') }] } };
      }
      return undefined;
    });
    rows.set('old1', { id: 'old1', rid: 'C001', text: 'old', threadId: null, status: 'pending', attempts: 1, createdAt: NOW - 60_000 });
    await outbox.process();
    assert.equal(rows.size, 0);
    assert.deepEqual(server.calls.map((c) => c.method), ['conversations.history']);
  });

  test('a refused session leaves the row pending for after the sign-in', async () => {
    const { outbox, rows } = setup((call) => (call.method === 'chat.postMessage' ? { body: { ok: false, error: 'invalid_auth' } } : undefined));
    await outbox.send('C001', 'hi');
    assert.equal(rows.get('local1')?.status, 'pending');
  });
});
