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
    enqueueMessage: async (m) => {
      rows.set(m.id, { id: m.id, rid: m.rid, text: m.text, threadId: m.threadId, status: 'pending', attempts: 0, createdAt: m.ts });
      messages.set(m.id, m);
    },
    listToSend: async () => [...rows.values()].filter((r) => r.status === 'pending'),
    markFailed: async (id) => {
      const row = rows.get(id);
      if (row) row.status = 'failed';
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
    assert.equal(body.pending_post_id, 'u-me:3233');
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

  test('a refusal is checked against the durable operation marker', async () => {
    const { outbox, ingested, rows } = setup((call) => {
      if (call.method === 'POST') return { status: 500, body: { id: 'app.post.save.app_error', message: 'boom' } };
      return { body: postList([post('real1', { user_id: 'u-me', message: 'hi', create_at: Date.now(), props: { rocket_vibe_client_id: 'local1' } })]) };
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

describe('MmOutbox replays', () => {
  test('a send whose answer was lost is looked for before it goes out again', async () => {
    let created = false;
    let fail = true;
    const server = fakeServer((call) => {
      if (call.method === 'POST') {
        created = true;
        return { status: 201, body: post('real1', { user_id: 'u-me', message: 'hi', create_at: Date.now() }) };
      }
      return { body: postList(created ? [post('real1', { user_id: 'u-me', message: 'hi', create_at: Date.now(), props: { rocket_vibe_client_id: 'local1' } })] : []) };
    });
    // The server saved the post, the answer never came back.
    const lossy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await server.fetcher(input, init);
      if (fail && init?.method === 'POST') {
        fail = false;
        throw new TypeError('Network request failed');
      }
      return answer;
    }) as typeof fetch;
    const local = outboxStore();
    const ingested: Record<string, unknown>[] = [];
    const outbox = new MmOutbox({
      store: local.store,
      client: new MmClient(server.base, 'tok', { fetch: lossy }),
      me: { id: 'u-me', username: 'me' },
      generateId: () => 'local1',
      ingest: async (doc) => void ingested.push(doc),
    });
    await outbox.send('ch1', 'hi');
    assert.equal(local.rows.get('local1')?.status, 'pending');
    await outbox.process();
    assert.equal(server.calls.filter((c) => c.method === 'POST').length, 1, 'no second POST');
    assert.equal(ingested[0]?.id, 'real1');
    assert.equal(local.rows.size, 0);
  });

  test('a row queued before a restart is looked for first, and sent when absent', async () => {
    const { outbox, server, rows, ingested } = setup((call) =>
      call.method === 'POST' ? { status: 201, body: post('real2', { message: 'later' }) } : { body: postList([]) },
    );
    rows.set('old1', { id: 'old1', rid: 'ch1', text: 'later', threadId: null, status: 'pending', attempts: 0, createdAt: Date.now() - 60_000 });
    await outbox.process();
    assert.deepEqual(server.calls.map((c) => c.method), ['GET', 'POST']);
    assert.equal(ingested[0]?.id, 'real2');
  });
});

describe('MmOutbox while the first POST is being saved', () => {
  test('a replay answered "pending" stays pending, then the saved post is found', async () => {
    let saved = false;
    const server = fakeServer((call) => {
      if (call.method === 'POST') return { status: 500, body: { id: 'api.post.deduplicate_create_post.pending', message: 'pending' } };
      return { body: postList(saved ? [post('real1', { user_id: 'u-me', message: 'hi', create_at: Date.now(), props: { rocket_vibe_client_id: 'local1' } })] : []) };
    });
    const local = outboxStore();
    const ingested: Record<string, unknown>[] = [];
    const later: (() => void)[] = [];
    const outbox = new MmOutbox({
      store: local.store,
      client: new MmClient(server.base, 'tok', { fetch: server.fetcher }),
      me: { id: 'u-me', username: 'me' },
      generateId: () => 'local1',
      ingest: async (doc) => void ingested.push(doc),
      later: (run) => void later.push(run),
    });
    await outbox.send('ch1', 'hi');
    assert.equal(local.rows.get('local1')?.status, 'pending');
    assert.equal(later.length, 1);
    saved = true;
    later[0]!();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(server.calls.filter((c) => c.method === 'POST').length, 1, 'no second POST');
    assert.equal(ingested[0]?.id, 'real1');
    assert.equal(local.rows.size, 0);
  });
});

describe('MmOutbox after a refusal', () => {
  test('an older post of mine with the same text does not make a refused send delivered', async () => {
    const { outbox, ingested, rows } = setup((call) => {
      if (call.method === 'POST') return { status: 403, body: { id: 'api.post.create_post.archived', message: 'archived' } };
      return { body: postList([post('old', { user_id: 'u-me', message: 'ok', create_at: Date.now() - 3_600_000 })]) };
    });
    await outbox.send('ch1', 'ok');
    assert.equal(ingested.length, 0);
    assert.equal([...rows.values()][0]?.status, 'failed');
  });
});

test('a repeated message queued offline before restart is sent despite the earlier identical post', async () => {
  const { outbox, server, rows } = setup(call => call.method === 'POST'
    ? { body: post('new-real', { user_id: 'u-me', message: 'OK' }) }
    : { body: postList([post('old-real', { user_id: 'u-me', message: 'OK', create_at: Date.now() - 10_000, props: { rocket_vibe_client_id: 'previous-operation' } })]) });
  rows.set('new-operation', { id: 'new-operation', rid: 'ch1', text: 'OK', threadId: null, status: 'pending', attempts: 0, createdAt: Date.now() - 5000 });
  await outbox.process();
  assert.deepEqual(server.calls.map(call => call.method), ['GET', 'POST']);
  assert.deepEqual((server.calls[1].body as { props: unknown }).props, { rocket_vibe_client_id: 'new-operation' });
  assert.equal(rows.size, 0);
});

test('a legacy text match is kept as a visible failure and only an explicit retry resends', async () => {
  const { outbox, server, rows } = setup(call => call.method === 'POST'
    ? { body: post('new-real', { user_id: 'u-me', message: 'OK' }) }
    : { body: postList([post('old-real', { user_id: 'u-me', message: 'OK', create_at: Date.now() - 10_000 })]) });
  rows.set('legacy', { id: 'legacy', rid: 'ch1', text: 'OK', threadId: null, status: 'pending', attempts: 0, createdAt: Date.now() - 5000 });
  await outbox.process();
  assert.equal(rows.get('legacy')?.status, 'failed');
  assert.equal(server.calls.filter(call => call.method === 'POST').length, 0);
  await outbox.process();
  assert.equal(rows.size, 1, 'automatic replay leaves the uncertain row alone');
  await outbox.retry('legacy');
  assert.equal(server.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(rows.size, 0);
});

test('a full history page newer than the send cannot authorize an automatic replay', async () => {
  const { outbox, server, rows } = setup(() => ({ body: postList(Array.from({ length: 30 }, (_, i) =>
    post(`newer-${i}`, { create_at: Date.now(), message: 'unrelated' }))) }));
  rows.set('old', { id: 'old', rid: 'ch1', text: 'hello', threadId: null, status: 'pending', attempts: 0, createdAt: Date.now() - 3_600_000 });
  await outbox.process();
  assert.equal(rows.get('old')?.status, 'failed');
  assert.equal(server.calls.filter(call => call.method === 'POST').length, 0);
});
