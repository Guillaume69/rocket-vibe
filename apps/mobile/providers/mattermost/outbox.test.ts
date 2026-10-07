import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { LocalMessage } from '../../lib/normalize.ts';
import type { OutboxRow, OutboxStore } from '../../lib/outbox.ts';
import { MmClient } from './client.ts';
import { MmOutbox } from './outbox.ts';
import { fakeServer, post, postList } from './testing.ts';

function outboxStore() {
  const rows = new Map<string, OutboxRow>();
  const messages = new Map<string, LocalMessage>();
  const store: OutboxStore = {
    insertOutbox: async (id, rid, text, threadId) => void rows.set(id, { id, rid, text, threadId, status: 'pending', attempts: 0 }),
    listToSend: async () => [...rows.values()].filter((r) => r.status === 'pending'),
    markFailed: async (id) => {
      const row = rows.get(id);
      if (row) row.status = 'failed';
    },
    deleteOutbox: async (id) => void rows.delete(id),
    upsertMessage: async (m) => void messages.set(m.id, m),
    deleteOptimisticMessage: async (id) => {
      if (messages.get(id)?.updatedAt === 0) messages.delete(id);
    },
    roomEncrypted: async () => false,
  };
  return { store, rows, messages };
}

function setup(route: Parameters<typeof fakeServer>[0]) {
  const server = fakeServer(route);
  const local = outboxStore();
  const ingested: Record<string, unknown>[] = [];
  const outbox = new MmOutbox({
    store: local.store,
    client: new MmClient(server.base, 'tok', { fetch: server.fetcher }),
    me: { id: 'u-me', username: 'me' },
    generateId: () => 'local1',
    ingest: async (doc) => void ingested.push(doc),
  });
  return { outbox, server, ingested, ...local };
}

describe('MmOutbox', () => {
  test('the local id leaves as pending_post_id; the real post replaces the optimistic row', async () => {
    const { outbox, server, ingested, rows, messages } = setup((call) =>
      call.method === 'POST' && call.path === '/posts' ? { status: 201, body: post('real1', { message: 'hi' }) } : undefined,
    );
    await outbox.send('ch1', 'hi', 'root1');
    const body = server.calls[0]?.body as Record<string, unknown>;
    assert.equal(body.pending_post_id, 'local1');
    assert.equal(body.root_id, 'root1');
    assert.equal(ingested[0]?.id, 'real1');
    assert.equal(rows.size, 0);
    assert.equal(messages.has('local1'), false);
  });

  test('unreachable network: the row waits, the optimistic message stays', async () => {
    const server = { fetcher: (async () => { throw new TypeError('Network request failed'); }) as typeof fetch };
    const local = outboxStore();
    const outbox = new MmOutbox({
      store: local.store,
      client: new MmClient('http://mm.test', 'tok', { fetch: server.fetcher }),
      me: { id: 'u-me', username: 'me' },
      generateId: () => 'local1',
      ingest: async () => {},
    });
    await outbox.send('ch1', 'hi');
    assert.equal(local.rows.get('local1')?.status, 'pending');
    assert.equal(local.messages.has('local1'), true);
  });

  test('a refusal is checked against the room: a post of mine with the same text means delivered', async () => {
    const { outbox, ingested, rows } = setup((call) => {
      if (call.method === 'POST') return { status: 500, body: { id: 'app.post.save.app_error', message: 'boom' } };
      return { body: postList([post('real1', { user_id: 'u-me', message: 'hi' })]) };
    });
    await outbox.send('ch1', 'hi');
    assert.equal(ingested[0]?.id, 'real1');
    assert.equal(rows.size, 0);
  });

  test('a refusal with nothing in the room marks the row failed', async () => {
    const { outbox, rows } = setup((call) =>
      call.method === 'POST' ? { status: 403, body: { id: 'api.context.permissions.app_error', message: 'no' } } : { body: postList([]) },
    );
    await outbox.send('ch1', 'hi');
    assert.equal(rows.get('local1')?.status, 'failed');
  });
});
