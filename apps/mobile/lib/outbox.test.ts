import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { OutboxEngine, idFromBytes, type OutboxEncryptor, type OutboxStore, type OutboxRow } from './outbox.ts';
import type { LocalMessage } from './normalize.ts';
import { RestClient } from './rest.ts';

function fakeStore(encrypted: ReadonlySet<string> = new Set()) {
  const outbox = new Map<string, OutboxRow>();
  const messages: LocalMessage[] = [];
  const store: OutboxStore = {
    insertOutbox: async (id, rid, text, threadId) =>
      void outbox.set(id, { id, rid, text, threadId, status: 'pending', attempts: 0, createdAt: Date.now() }),
    listToSend: async () => [...outbox.values()].filter((l) => l.status === 'pending'),
    markFailed: async (id, error) => {
      const l = outbox.get(id);
      if (l) {
        l.status = 'failed';
        l.attempts++;
        void error;
      }
    },
    rearm: async (id) => {
      const l = outbox.get(id);
      if (l?.status === 'failed') l.status = 'pending';
    },
    deleteOutbox: async (id) => void outbox.delete(id),
    upsertMessage: async (m) => void messages.push(m),
    deleteOptimisticMessage: async (id) => {
      const i = messages.findIndex((m) => m.id === id && m.updatedAt === 0);
      if (i !== -1) messages.splice(i, 1);
    },
    roomEncrypted: async (rid) => encrypted.has(rid),
  };
  return { store, outbox, messages };
}

/** Real REST client, simulated fetch: exercises the real serialisation. */
function fakeClient(
  reply: (body: Record<string, unknown>) => Promise<Response>,
  replyGet?: (url: string) => Promise<Response>,
) {
  const queries: Record<string, unknown>[] = [];
  const client = new RestClient('http://x', {
    fetch: async (url, init) => {
      if (init?.body === undefined) {
        // GET (chat.getMessage): not found by default.
        return replyGet
          ? replyGet(String(url))
          : ok({ success: false, error: 'not-found' });
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      queries.push(body);
      return reply(body);
    },
    sleep: async () => {},
  });
  return { client, queries };
}

const ok = (json: unknown) =>
  new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });

function testEngine(options: {
  reply: (body: Record<string, unknown>) => Promise<Response>;
  replyGet?: (url: string) => Promise<Response>;
  encrypted?: ReadonlySet<string>;
  encryptor?: OutboxEncryptor;
}) {
  const { store, outbox, messages } = fakeStore(options.encrypted);
  const { client, queries } = fakeClient(options.reply, options.replyGet);
  const ingested: Record<string, unknown>[] = [];
  let n = 0;
  const engine = new OutboxEngine({
    store,
    client,
    me: { id: 'u1', username: 'alice' },
    generateId: () => `generated-id-${++n}`.padEnd(24, '0'),
    ingest: async (doc) => void ingested.push(doc),
    encryptor: options.encryptor,
    now: () => 1000,
  });
  return { engine, outbox, messages, queries, ingested };
}

describe('idFromBytes', () => {
  test('24 hex digits, deterministic from the bytes', () => {
    const id = idFromBytes(new Uint8Array([0, 1, 255, 16, 32, 64, 128, 200, 9, 10, 11, 12]));
    assert.match(id, /^[0-9a-f]{24}$/);
    assert.equal(id, '0001ff10204080c8090a0b0c');
  });
});

describe('OutboxEngine', () => {
  test('send: optimistic display BEFORE the network, then send and reconciliation', async () => {
    const { engine, outbox, messages, queries, ingested } = testEngine({
      reply: async (body) => {
        const m = (body.message ?? {}) as Record<string, unknown>;
        return ok({ success: true, message: { ...m, ts: { $date: 2000 }, u: { _id: 'u1' } } });
      },
    });

    const id = await engine.send('r1', 'hello');

    assert.equal(messages.length, 1, 'the optimistic message is written to the database');
    assert.equal(messages[0].id, id);
    assert.equal(messages[0].updatedAt, 0, 'always overwritable by the server');

    assert.equal(queries.length, 1);
    const sent = (queries[0].message ?? {}) as Record<string, unknown>;
    assert.equal(sent._id, id, 'the server receives the SAME _id: its deduplication key');
    assert.equal(sent.msg, 'hello');

    assert.equal(outbox.size, 0, 'the queue is emptied on success');
    assert.equal(ingested.length, 1, 'the server document goes back through sync');
  });

  test('thread reply: `tmid` goes to the server, `threadId` persists for the replay (8.3)', async () => {
    const { engine, outbox, queries } = testEngine({
      reply: async (body) => {
        const m = (body.message ?? {}) as Record<string, unknown>;
        return ok({ success: true, message: { ...m, ts: { $date: 2000 }, u: { _id: 'u1' } } });
      },
    });
    await engine.send('r1', 'reply in the thread', 'thread-root-00000000000');
    const sent = (queries[0].message ?? {}) as Record<string, unknown>;
    assert.equal(sent.tmid, 'thread-root-00000000000');
    assert.equal(outbox.size, 0);

    // An ORDINARY message has no `tmid` key at all, not a null.
    await engine.send('r1', 'outside the thread');
    const ordinary = (queries[1].message ?? {}) as Record<string, unknown>;
    assert.ok(!('tmid' in ordinary));
  });

  test('network unreachable: the row STAYS pending, ready for the replay', async () => {
    const { engine, outbox } = testEngine({
      reply: async () => {
        throw new TypeError('Network request failed');
      },
    });
    await engine.send('r1', 'offline');
    const rows = [...outbox.values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending', 'not a failure: the network will come back');
  });

  test('server refusal: actionable failure, NO deletion', async () => {
    const { engine, outbox } = testEngine({
      reply: async () => ok({ success: false, error: 'error-not-allowed' }),
    });
    await engine.send('r1', 'refused');
    const rows = [...outbox.values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].attempts, 1);
  });

  test('a refused but ALREADY DELIVERED replay is reconciled, not marked failed', async () => {
    // Rocket.Chat 8.5 answers 400 on an already accepted `_id` (checked: "Cannot
    // read properties of undefined (reading 'starred')"): no duplicate, but the
    // response is not a refusal, so ask chat.getMessage.
    const { engine, outbox } = testEngine({
      reply: async () =>
        ok({ success: false, error: "Cannot read properties of undefined (reading 'starred')" }),
      replyGet: async (url) => {
        const id = new URL(url).searchParams.get('msgId');
        return ok({ success: true, message: { _id: id } });
      },
    });
    await engine.send('r1', 'replayed after a crash');
    assert.equal(outbox.size, 0, 'delivered = reconciled');
  });

  test('the "already delivered" document is INGESTED: the server version replaces the optimistic one', async () => {
    const { engine, ingested } = testEngine({
      reply: async () => ok({ success: false, error: 'starred…' }),
      replyGet: async (url) => {
        const id = new URL(url).searchParams.get('msgId');
        return ok({ success: true, message: { _id: id, msg: 'server version' } });
      },
    });
    await engine.send('r1', 'x');
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].msg, 'server version');
  });

  /**
   * The "already delivered?" check can itself fail, and "I could not ask" is
   * NOT "the server says no". Concluding failure on a dead network shows "not
   * sent" on a message the server may have accepted; the user types it again
   * and gets two.
   */
  test('check impossible (dead network): the row stays pending, not failed', async () => {
    const { engine, outbox } = testEngine({
      reply: async () => ok({ success: false, error: 'starred…' }),
      replyGet: async () => {
        throw new TypeError('Network request failed');
      },
    });
    await engine.send('r1', 'maybe delivered');
    const rows = [...outbox.values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending', 'when in doubt, do not condemn');
    assert.equal(rows[0].attempts, 0, 'and do not use up an attempt');
  });

  /**
   * `chat.getMessage` is under the same 10/min REST limit as `chat.sendMessage`
   * (CLAUDE.md): a burst of sends exhausts the quota and ALL checks fall back
   * to 429, after `RestClient`'s three retries.
   */
  test('rate-limited check (429): the row stays pending', async () => {
    let gets = 0;
    const { engine, outbox } = testEngine({
      reply: async () => ok({ success: false, error: 'starred…' }),
      replyGet: async () => {
        gets++;
        return new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json' } });
      },
    });
    await engine.send('r1', 'quota exhausted');
    assert.ok(gets > 1, 'RestClient does retry the 429 before giving up');
    assert.equal([...outbox.values()][0]?.status, 'pending');
  });

  test('the server answering "this message does not exist" IS a failure', async () => {
    const { engine, outbox } = testEngine({
      reply: async () => ok({ success: false, error: 'starred…' }),
      // A clear HTTP answer: the server spoke, the message is not there.
      replyGet: async () => ok({ success: false, error: 'error-invalid-message' }),
    });
    await engine.send('r1', 'really refused');
    assert.equal([...outbox.values()][0]?.status, 'failed', 'a server verdict decides');
  });

  test('discard deletes the outbox row AND the optimistic message', async () => {
    const { engine, outbox, messages } = testEngine({
      reply: async () => ok({ success: false, error: 'final refusal' }),
    });
    const id = await engine.send('r1', 'doomed');
    assert.equal([...outbox.values()][0]?.status, 'failed');

    await engine.discard(id);
    assert.equal(outbox.size, 0);
    assert.equal(messages.length, 0, 'the optimistic message must not haunt the room');
  });

  test('a send during the flush is picked up by a rerun, not forgotten', async () => {
    // Real race: send('b') while the POST of 'a' is in flight.
    // Without a rerun, 'b' would stay "⏳" until the next trigger.
    const valve: { open: (() => void) | null } = { open: null };
    let first = true;
    const { engine, queries, outbox } = testEngine({
      reply: (body) => {
        const m = (body.message ?? {}) as Record<string, unknown>;
        if (!first) return Promise.resolve(ok({ success: true, message: m }));
        first = false;
        return new Promise((resolve) => {
          valve.open = () => resolve(ok({ success: true, message: m }));
        });
      },
    });

    const p1 = engine.send('r1', 'a');
    await new Promise((r) => setImmediate(r)); // 'a' reaches the network
    const p2 = engine.send('r1', 'b'); // while 'a' is in flight
    await new Promise((r) => setImmediate(r));
    valve.open?.();
    await Promise.all([p1, p2]);

    assert.equal(queries.length, 2, "the rerun sent 'b'");
    assert.equal(outbox.size, 0);
  });

  test('the replay leaves failures alone; only retry(id) resends one', async () => {
    let refuse = true;
    const { engine, outbox, queries } = testEngine({
      reply: async (body) => {
        if (refuse) return ok({ success: false, error: 'temporary' });
        const m = (body.message ?? {}) as Record<string, unknown>;
        return ok({ success: true, message: m });
      },
    });
    const id = await engine.send('r1', 'a');
    assert.equal([...outbox.values()][0]?.status, 'failed');

    refuse = false;
    await engine.process();
    assert.equal(queries.length, 1, 'a failed row costs nothing on the next passes');
    assert.equal([...outbox.values()][0]?.status, 'failed');

    await engine.retry(id);
    assert.equal(outbox.size, 0, 'the explicit retry delivered it');
  });

  test('a refused message does not hold back the next one', async () => {
    const { engine, outbox, queries } = testEngine({
      reply: async (body) => {
        const m = (body.message ?? {}) as Record<string, unknown>;
        if (m.rid === 'read-only') return ok({ success: false, error: 'error-not-allowed' });
        return ok({ success: true, message: m });
      },
    });
    for (let i = 0; i < 5; i++) await engine.send('read-only', `refused ${i}`);
    const before = queries.length;
    await engine.send('r1', 'fresh');
    assert.equal(queries.length - before, 1, 'one call for the new message, none for the failures');
    assert.equal([...outbox.values()].filter((l) => l.status === 'failed').length, 5);
    assert.equal([...outbox.values()].some((l) => l.rid === 'r1'), false);
  });

  test('a server error during the check (502) keeps the row pending', async () => {
    const { engine, outbox } = testEngine({
      reply: async () => new Response('<html>Bad Gateway</html>', { status: 502 }),
      replyGet: async () => new Response('<html>Bad Gateway</html>', { status: 502 }),
    });
    await engine.send('r1', 'during a restart');
    assert.equal([...outbox.values()][0]?.status, 'pending', 'a proxy error is no refusal');
  });

  test('two concurrent process() calls do not double the requests', async () => {
    // Object property, not a local variable: TypeScript does not see the
    // assignment made in the promise executor.
    const valve: { open: (() => void) | null } = { open: null };
    const { engine, queries } = testEngine({
      reply: (body) =>
        new Promise((resolve) => {
          valve.open = () => {
            const m = (body.message ?? {}) as Record<string, unknown>;
            resolve(ok({ success: true, message: m }));
          };
        }),
    });
    const p1 = engine.send('r1', 'x');
    // Let the first pass reach the network (and block on the valve).
    await new Promise((r) => setImmediate(r));
    // While the send is in flight, a second pass must do nothing, and above
    // all not block: it is only awaited after opening the valve.
    const p2 = engine.process();
    valve.open?.();
    await Promise.all([p1, p2]);
    assert.equal(queries.length, 1);
  });
});

describe('OutboxEngine, encrypted room', () => {
  const echo = async (body: Record<string, unknown>) => {
    const m = (body.message ?? {}) as Record<string, unknown>;
    return ok({ success: true, message: { ...m, ts: { $date: 2000 }, u: { _id: 'u1' } } });
  };
  const encryptor: OutboxEncryptor = {
    encrypt: (rid, payload) => ({
      algorithm: 'rc.v2.aes-sha2',
      kid: `kid-${rid}`,
      iv: 'aXY=',
      ciphertext: Buffer.from(JSON.stringify(payload)).toString('base64'),
    }),
  };

  test('the text leaves encrypted, never in plaintext, with its mentions and thread', async () => {
    const { engine, messages, queries, outbox } = testEngine({ reply: echo, encrypted: new Set(['p1']), encryptor });

    await engine.send('p1', 'hi @bob', 'root');

    assert.equal(messages[0].systemType, 'e2e', 'the optimistic message is an encrypted message…');
    assert.equal(messages[0].text, 'hi @bob', '…shown in plaintext locally');
    const sent = (queries[0].message ?? {}) as Record<string, unknown>;
    assert.equal(sent.msg, undefined, 'no plaintext on the network');
    assert.equal(sent.t, 'e2e');
    assert.equal(sent.e2e, 'pending');
    assert.equal(sent.tmid, 'root');
    const content = sent.content as { kid: string; ciphertext: string };
    assert.equal(content.kid, 'kid-p1');
    assert.deepEqual(JSON.parse(Buffer.from(content.ciphertext, 'base64').toString()), { msg: 'hi @bob' });
    assert.deepEqual(sent.e2eMentions, { e2eUserMentions: ['@bob'], e2eChannelMentions: [] });
    assert.equal(outbox.size, 0);
  });

  test('locked: the row waits without failing, the other rooms go out', async () => {
    let key = false;
    const { engine, queries, outbox } = testEngine({
      reply: echo,
      encrypted: new Set(['p1']),
      encryptor: { encrypt: (rid, payload) => (key ? encryptor.encrypt(rid, payload) : null) },
    });

    await engine.send('p1', 'secret');
    await engine.send('r2', 'public');

    assert.deepEqual(queries.map((r) => (r.message as { rid: string }).rid), ['r2']);
    assert.equal(outbox.size, 1);
    assert.equal([...outbox.values()][0].status, 'pending');

    key = true;
    await engine.process();
    assert.equal(queries.length, 2);
    assert.equal(outbox.size, 0);
  });

  test('without an encryptor, an encrypted room receives nothing', async () => {
    const { engine, queries, outbox } = testEngine({ reply: echo, encrypted: new Set(['p1']) });
    await engine.send('p1', 'secret');
    assert.equal(queries.length, 0);
    assert.equal(outbox.size, 1);
  });
});
