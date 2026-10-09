import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { withTransactionTrap } from './testStore.ts';
import { catchUpGlobal, catchUpRoom, reconcileRooms } from './catchUp.ts';
import { RestClient } from './rest.ts';
import { SyncEngine, type Store } from './sync.ts';
import { RcTranslator } from '../providers/rocketchat/translator.ts';

function fullFakeStore() {
  const cursors = new Map<string, number>();
  const deletedRooms: string[] = [];
  const deletedSubscriptions: string[] = [];
  const deletedMessages: string[] = [];
  const rooms: string[] = [];
  const subscriptions: string[] = [];
  const messages: string[] = [];
  const deletedBySubId: string[] = [];
  const purges: { alive: string[]; known: string[] }[] = [];
  const identities: { uid: string; username: string; avatarEtag: string | null }[] = [];
  const retentions: number[] = [];
  /** The rids "already in the database", mutable: the stream writes while the request is in flight. */
  const known: string[] = [];
  let lastLocal: number | null = null;
  // The trap replays the `db/store.ts` invariant: during a transaction,
  // only writes through the received `tx` go through; the store's own throw.
  const store: Store = withTransactionTrap({
    upsertMessage: async (m) => void messages.push(m.id),
    upsertRoom: async (s) => void rooms.push(s.rid),
    upsertSubscription: async (a) => void subscriptions.push(a.rid),
    deleteMessage: async (id) => void deletedMessages.push(id),
    deleteRoom: async (rid) => void deletedRooms.push(rid),
    deleteSubscription: async (rid) => void deletedSubscriptions.push(rid),
    deleteBySubId: async (subId) => void deletedBySubId.push(subId),
    listKnownRids: async () => [...known],
    purgeMissingRooms: async (alive, conn) => void purges.push({ alive, known: conn }),
    applyRetention: async (n) => void retentions.push(n),
    readCursor: async (scope, stream) => cursors.get(`${scope}|${stream}`) ?? null,
    writeCursor: async (scope, stream, value) => {
      const key = `${scope}|${stream}`;
      const current = cursors.get(key);
      if (current === undefined || value > current) cursors.set(key, value);
    },
    lastMessageUpdatedAt: async () => lastLocal,
    listRoomKeys: async () => [],
    messagesToDecrypt: async () => [],
    updateMessageText: async () => {},
    updateMessageMarks: async () => {},
    hideEncryptedMessages: async () => {},
    updateEncryptedPreview: async () => {},
    updateUserAvatar: async () => {},
    updateRoomAvatar: async () => {},
    saveIdentity: async (i) => void identities.push(i),
  });
  return {
    store,
    cursors,
    identities,
    rooms,
    subscriptions,
    messages,
    deletedRooms,
    deletedSubscriptions,
    deletedMessages,
    deletedBySubId,
    purges,
    retentions,
    known,
    setLastLocal: (v: number | null) => {
      lastLocal = v;
    },
  };
}

/**
 * Real client, simulated fetch: we check the REAL URL parameters.
 * `duringFlight` runs when the server answers: that is when the DDP stream
 * writes, behind the back of the response being received.
 */
function fakeClient(responses: Record<string, unknown>, duringFlight?: (path: string) => void) {
  const urls: string[] = [];
  const client = new RestClient('http://x', {
    fetch: async (url) => {
      const u = String(url);
      urls.push(u);
      const path = new URL(u).pathname.split('/api/v1/')[1];
      duringFlight?.(path ?? '');
      return new Response(JSON.stringify(responses[path] ?? { success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => {},
  });
  return { client, urls };
}

describe('catchUpGlobal', () => {
  test('without a cursor: full load (no updatedSince), then cursors set', async () => {
    const d = fullFakeStore();
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = fakeClient({
      'rooms.get': {
        update: [{ _id: 'r1', t: 'c', _updatedAt: { $date: 500 } }],
        remove: [],
      },
      'subscriptions.get': {
        update: [{ rid: 'r1', _updatedAt: { $date: 700 } }],
        remove: [],
      },
    });

    await catchUpGlobal(client, engine);

    assert.ok(!urls.some((u) => u.includes('updatedSince')), 'first pass = full');
    assert.deepEqual(d.rooms, ['r1']);
    assert.equal(d.cursors.get('*|rooms'), 500, 'cursor = largest INGESTED _updatedAt');
    assert.equal(d.cursors.get('*|subscriptions'), 700);
  });

  test('with a cursor: updatedSince is sent, the removes clean up', async () => {
    const d = fullFakeStore();
    d.cursors.set('*|rooms', 1000);
    d.cursors.set('*|subscriptions', 1000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = fakeClient({
      // Real projections of the 8.5 server: the rooms.get `remove[]` carries the
      // `_id` of the deleted ROOM; the subscriptions.get one carries the `_id`
      // of the SUBSCRIPTION (never the rid).
      'rooms.get': { update: [], remove: [{ _id: 'r-destroyed' }] },
      'subscriptions.get': { update: [], remove: [{ _id: 'sub-left' }] },
    });

    await catchUpGlobal(client, engine);

    const roomsUrl = urls.find((u) => u.includes('rooms.get'));
    assert.ok(
      roomsUrl?.includes(`updatedSince=${encodeURIComponent(new Date(1000).toISOString())}`),
      'the delta starts from the cursor',
    );
    assert.deepEqual(d.deletedRooms, ['r-destroyed']);
    assert.deepEqual(d.deletedBySubId, ['sub-left']);
    assert.equal(d.cursors.get('*|rooms'), 1000, 'nothing ingested: the cursor does not move');
  });

  test('MY avatar version is caught up through `me`: the only path after the app was closed', async () => {
    // Photo changed from another client while the app was asleep: no
    // stream announced it. Without this read, the old photo would stay
    // displayed until the next change.
    const d = fullFakeStore();
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client } = fakeClient({
      'rooms.get': { update: [], remove: [] },
      'subscriptions.get': { update: [], remove: [] },
      me: { _id: 'u1', username: 'alice', avatarETag: 'etag-fresh' },
    });

    await catchUpGlobal(client, engine);

    assert.deepEqual(d.identities, [{ uid: 'u1', username: 'alice', avatarEtag: 'etag-fresh', name: null }]);
  });

  test('a failing `me` does not fail the catch-up', async () => {
    const d = fullFakeStore();
    const engine = new SyncEngine(d.store, new RcTranslator());
    const client = new RestClient('http://x', {
      fetch: async (url) => {
        const path = new URL(String(url)).pathname.split('/api/v1/')[1];
        if (path === 'me') throw new Error('network down');
        return new Response(JSON.stringify({ update: [{ _id: 'r1', t: 'c' }], remove: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      sleep: async () => {},
    });

    await catchUpGlobal(client, engine);

    assert.deepEqual(d.rooms, ['r1'], 'the rooms go through anyway');
    assert.equal(d.identities.length, 0);
  });
});

/** Responses served IN ORDER: that is what lets us test pagination. */
function clientSequence(responses: (Record<string, unknown> | number)[]) {
  const urls: string[] = [];
  let i = 0;
  const client = new RestClient('http://x', {
    fetch: async (url) => {
      urls.push(String(url));
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      const status = typeof r === 'number' ? r : 200;
      const body = typeof r === 'number' ? { success: false, error: 'params' } : r;
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => {},
  });
  return { client, urls };
}

/** One cursor-mode page, as the 8.5 server returns it. */
const page = (updated: unknown[], next: string | null, deleted: unknown[] = []) => ({
  result: { updated, deleted, cursor: { next, previous: '0' } },
});

const msg = (id: string, update: number) => ({
  _id: id,
  rid: 'r1',
  msg: id,
  ts: { $date: update },
  u: { _id: 'u1' },
  _updatedAt: { $date: update },
});

describe('catchUpRoom', () => {
  test('without a cursor: does NOTHING, starting from the origin would download everything again', async () => {
    const d = fullFakeStore();
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = fakeClient({});
    await catchUpRoom(client, engine, 'r1');
    assert.equal(urls.length, 0);
  });

  test('cursor mode: type/next/count, and ESPECIALLY no lastUpdate', async () => {
    // `lastUpdate`, when present, WINS over `type`/`next`: the response
    // falls back to unbounded mode (1.85 MB measured). Its absence is the core of the
    // fix, not a formal detail.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 2000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = clientSequence([page([msg('m1', 2600)], null)]);

    await catchUpRoom(client, engine, 'r1');

    assert.ok(urls[0]?.includes('chat.syncMessages'));
    assert.ok(urls[0]?.includes('roomId=r1'));
    assert.ok(urls[0]?.includes('type=UPDATED'));
    assert.ok(urls[0]?.includes('next=2000'));
    assert.ok(urls[0]?.includes('count=50'));
    assert.ok(!urls[0]?.includes('lastUpdate'), `lastUpdate must be absent, saw ${urls[0]}`);
    assert.deepEqual(d.messages, ['m1']);
  });

  test('the cursor advances AFTER EACH page, the last one included', async () => {
    // That is what makes capping safe: interrupted at any
    // page, the next pass resumes where we stopped.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 1000);
    d.cursors.set('r1|messages-deleted', 9_000_000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const seen: (number | undefined)[] = [];
    const { client } = clientSequence([page([msg('m1', 1500)], '2000'), page([msg('m2', 2500)], null)]);
    const write = d.store.writeCursor.bind(d.store);
    d.store.writeCursor = async (scope, stream, v) => {
      if (stream === 'messages') seen.push(v);
      await write(scope, stream, v);
    };

    await catchUpRoom(client, engine, 'r1');

    // Page 1: the SERVER cursor (2000), not the largest ingested
    // `_updatedAt` (1500): only it resumes pagination, groups of ties included.
    // Page 2: `next: null`, there is no more server cursor to copy, so
    // we advance on what we ingested (2500).
    assert.deepEqual(seen, [2000, 2500]);
    assert.deepEqual(d.messages, ['m1', 'm2']);
  });

  test('two openings in a row: the second does NOT ask again for the same slice', async () => {
    // The symptom seen: leaving a room and coming back right away restarted a
    // catch-up of several seconds. The server returns `cursor.next = null` as soon
    // as nothing is left after the page, so the NOMINAL case, a lag that
    // fits in one page, had no server cursor to copy. The cursor
    // stayed frozen forever, the slice was requested again at each opening, and
    // it grew with every message posted since.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 1000);
    d.cursors.set('r1|messages-deleted', 9_000_000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = clientSequence([page([msg('m1', 1500)], null)]);

    await catchUpRoom(client, engine, 'r1');
    await catchUpRoom(client, engine, 'r1');

    const updates = urls.filter((u) => u.includes('type=UPDATED'));
    assert.equal(updates.length, 2, 'one request per opening');
    assert.ok(updates[0]?.includes('next=1000'));
    assert.ok(updates[1]?.includes('next=1500'), `the 2nd opening starts again from 1500, saw ${updates[1]}`);
  });

  test('cap: 2 pages at most, even if the server promises more', async () => {
    // Without a cap, an `_updatedAt` storm (username change → all
    // messages rewritten) would pull down 60 pages, i.e. 1.85 MB.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 1000);
    d.cursors.set('r1|messages-deleted', 9_000_000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    // Each page promises more: only the cap can stop the loop.
    const { client, urls } = clientSequence([
      page([msg('m1', 1500)], '2000'),
      page([msg('m2', 2500)], '3000'),
      page([msg('m3', 3500)], '4000'),
    ]);

    await catchUpRoom(client, engine, 'r1');

    const updates = urls.filter((u) => u.includes('type=UPDATED'));
    assert.equal(updates.length, 2, 'the 3rd page must not be requested');
    assert.deepEqual(d.messages, ['m1', 'm2']);
    assert.equal(d.cursors.get('r1|messages'), 3000, 'the rest is picked up at the next pass');
  });

  test('a cursor that does not advance stops the loop: no spinning in place', async () => {
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 5000);
    d.cursors.set('r1|messages-deleted', 9_000_000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = clientSequence([page([], '5000')]);

    await catchUpRoom(client, engine, 'r1');

    assert.equal(urls.filter((u) => u.includes('type=UPDATED')).length, 1);
  });

  test('deletions: first pass = the cursor is set, without fetching anything', async () => {
    // Otherwise we would pull down the room's whole trash since the origin.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 4000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = clientSequence([page([], null)]);

    await catchUpRoom(client, engine, 'r1');

    assert.equal(urls.filter((u) => u.includes('type=DELETED')).length, 0);
    assert.equal(d.cursors.get('r1|messages-deleted'), 4000);
  });

  test('deletions: next pass → messages deleted server-side go away', async () => {
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 4000);
    d.cursors.set('r1|messages-deleted', 4000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = clientSequence([
      page([], null),
      { result: { deleted: [{ _id: 'm-efface' }], cursor: { next: '5000', previous: '0' } } },
      { result: { deleted: [], cursor: { next: null, previous: '0' } } },
    ]);

    await catchUpRoom(client, engine, 'r1');

    const deletion = urls.filter((u) => u.includes('type=DELETED'));
    assert.ok(deletion[0]?.includes('next=4000'));
    assert.deepEqual(d.deletedMessages, ['m-efface']);
    assert.equal(d.cursors.get('r1|messages-deleted'), 5000);
  });

  test('deletions: the last page advances the cursor on `_deletedAt`', async () => {
    // Same trap as for updates: without this, the SAME deletions
    // were replayed at each opening of the room.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 4000);
    d.cursors.set('r1|messages-deleted', 4000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const erased = '2026-07-25T13:12:28.691Z'; // shape recorded on 8.5
    const { client } = clientSequence([
      page([], null),
      {
        result: {
          deleted: [{ _id: 'm-efface', _deletedAt: erased }],
          cursor: { next: null, previous: '0' },
        },
      },
    ]);

    await catchUpRoom(client, engine, 'r1');

    assert.deepEqual(d.deletedMessages, ['m-efface']);
    assert.equal(d.cursors.get('r1|messages-deleted'), Date.parse(erased));
  });

  test('abandoned between the response and the write: nothing is written', async () => {
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 2000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client } = clientSequence([page([msg('m1', 2500)], null)]);
    await catchUpRoom(client, engine, 'r1', () => true);
    assert.equal(d.messages.length, 0);
  });

  test('a timeout PROPAGATES without switching to unbounded mode', async () => {
    // The fallback must only trigger on rejected parameters (400).
    // Switching to `lastUpdate` because the network falters would bring back
    // exactly the megabytes we are trying to avoid.
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 1000);
    const engine = new SyncEngine(d.store, new RcTranslator());
    const urls: string[] = [];
    const client = new RestClient('http://x', {
      fetch: async (url) => {
        urls.push(String(url));
        throw new Error('timeout');
      },
    });

    await assert.rejects(() => catchUpRoom(client, engine, 'r1'));

    assert.ok(!urls.some((u) => u.includes('lastUpdate')), 'no fallback on a timeout');
    assert.equal(d.cursors.get('r1|messages'), 1000, 'cursor intact: resuming is exact');
  });

  describe('fallback on a server without cursor mode (< 7.5)', () => {
    const day = 24 * 60 * 60 * 1000;

    test('400 on the first page → lastUpdate, window brought back to 24 h', async () => {
      const now = 100 * day;
      const d = fullFakeStore();
      d.cursors.set('r1|messages', 2 * day); // 98 days behind
      const engine = new SyncEngine(d.store, new RcTranslator());
      const { client, urls } = clientSequence([400, { result: { updated: [] } }]);

      await catchUpRoom(client, engine, 'r1', () => false, () => now);

      const expected = encodeURIComponent(new Date(now - day).toISOString());
      assert.ok(urls[1]?.includes(`lastUpdate=${expected}`), `saw ${urls[1]}`);
    });

    test('a response WITHOUT cursor counts as a refusal: the server ignores the parameters', async () => {
      const d = fullFakeStore();
      d.cursors.set('r1|messages', 2000);
      const engine = new SyncEngine(d.store, new RcTranslator());
      const { client, urls } = clientSequence([
        { result: { updated: [] } },
        { result: { updated: [msg('m1', 2600)] } },
      ]);

      await catchUpRoom(client, engine, 'r1', () => false, () => 3000);

      assert.ok(urls[1]?.includes('lastUpdate'), `saw ${urls[1]}`);
      assert.deepEqual(d.messages, ['m1']);
    });

    test('the fallback fails → cursor RE-ANCHORED on the last local message', async () => {
      // Without cursor mode, the request is unbounded and times out on a big
      // backlog. Since the cursor only advances AFTER ingestion, it would stay
      // stuck → endless loop. Re-anchoring only applies to that path.
      const d = fullFakeStore();
      d.cursors.set('r1|messages', 1000);
      d.setLastLocal(9000);
      const engine = new SyncEngine(d.store, new RcTranslator());
      let first = true;
      const client = new RestClient('http://x', {
        fetch: async () => {
          if (first) {
            first = false;
            return new Response(JSON.stringify({ success: false }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          throw new Error('timeout');
        },
        sleep: async () => {},
      });

      await assert.rejects(() => catchUpRoom(client, engine, 'r1'));
      assert.equal(d.cursors.get('r1|messages'), 9000);
    });
  });
});

/**
 * Client whose every response is HELD until the test releases it. It is
 * the only way to observe concurrency: with immediate responses, everything
 * already runs in sequence and we would prove nothing.
 */
function heldClient(responses: (Record<string, unknown> | number)[]) {
  const urls: string[] = [];
  const gates: (() => void)[] = [];
  let i = 0;
  const client = new RestClient('http://x', {
    fetch: async (url) => {
      urls.push(String(url));
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      await new Promise<void>((open) => gates.push(open));
      if (r === 0) throw new Error('network down'); // 0 = transport failure
      const status = typeof r === 'number' ? r : 200;
      const body = typeof r === 'number' ? { success: false, error: 'params' } : r;
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => {},
  });
  /** Lets already settled promises run: never a delay. */
  const turn = () => new Promise<void>((r) => setImmediate(r));
  return {
    client,
    urls,
    turn,
    /** Opens the gates one after another, until none is left. */
    openAll: async () => {
      for (let watchdog = 0; watchdog < 50; watchdog++) {
        const gate = gates.shift();
        if (gate === undefined) {
          await turn();
          if (gates.length === 0) return;
          continue;
        }
        gate();
        await turn();
      }
    },
  };
}

describe('catchUpRoom: one pagination at a time per room', () => {
  /** An already primed store: cursors set on both streams. */
  function bench() {
    const d = fullFakeStore();
    d.cursors.set('r1|messages', 1000);
    d.cursors.set('r1|messages-deleted', 9_000_000);
    return { d, engine: new SyncEngine(d.store, new RcTranslator()) };
  }

  test('three concurrent requests do NOT start three paginations', async () => {
    // The defect seen: at each connection setup, `ui/sync.tsx` and the screen's
    // opening effect (woken by the `generation` bump that this same
    // connection setup just made) both started from the SAME cursor,
    // to ask again for the same slice.
    const { d, engine } = bench();
    const h = heldClient([page([], null)]);

    const requests = [
      catchUpRoom(h.client, engine, 'r1'),
      catchUpRoom(h.client, engine, 'r1'),
      catchUpRoom(h.client, engine, 'r1'),
    ];
    await h.turn();

    assert.equal(h.urls.length, 1, 'a single request in flight, not three');

    await h.openAll();
    await Promise.all(requests);
    assert.equal(d.cursors.get('r1|messages'), 1000);
  });

  test('but no request is SWALLOWED: the second gets its read', async () => {
    // This is the opposite constraint, and it wins. `lib/connectionSetup.ts` reads
    // TWICE per connection setup, and the second read, the one that starts once the
    // subscriptions are armed, is the only one guaranteeing nothing fell
    // between the two transports. Refusing it left a permanent gap: the
    // cursor had advanced, nothing asked for that window again.
    const { d, engine } = bench();
    const h = heldClient([page([], null)]);

    const p1 = catchUpRoom(h.client, engine, 'r1');
    await h.turn(); // the first pagination has started
    const p2 = catchUpRoom(h.client, engine, 'r1');

    await h.openAll();
    await Promise.all([p1, p2]);

    const updates = h.urls.filter((u) => u.includes('type=UPDATED'));
    assert.equal(updates.length, 2, 'the request that arrived midway did read');
    assert.equal(d.cursors.get('r1|messages'), 1000);
  });

  test('the chained pass starts from the ADVANCED cursor, not the same slice a second time', async () => {
    // That is what makes the guarantee cheap: the second read does not
    // paginate again, it checks. ~92 bytes measured when nothing moved.
    const { d, engine } = bench();
    const h = heldClient([page([msg('m1', 1500)], null)]);

    const p1 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();
    const p2 = catchUpRoom(h.client, engine, 'r1');

    await h.openAll();
    await Promise.all([p1, p2]);

    const updates = h.urls.filter((u) => u.includes('type=UPDATED'));
    assert.ok(updates[0]?.includes('next=1000'), `1st pass, saw ${updates[0]}`);
    assert.ok(updates[1]?.includes('next=1500'), `2nd pass on the new cursor, saw ${updates[1]}`);
    assert.deepEqual(d.messages, ['m1', 'm1'], 'idempotent: the 2nd re-ingests without duplicating');
  });

  test('passes do not INTERLEAVE: the second waits for the first to finish', async () => {
    const { engine } = bench();
    const h = heldClient([page([], null)]);

    const p1 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();
    const p2 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();

    assert.equal(h.urls.length, 1, 'the 2nd pass sent nothing while the 1st runs');

    await h.openAll();
    await Promise.all([p1, p2]);
  });

  test('a JOINED pass only gives up if ALL its requesters let go', async () => {
    // The joiner inherits the pass, not the first requester's abandonment:
    // a replayed effect (`generation` change) sets `canceled = true` on
    // the old pass right before starting the new one. Excluding oneself on the
    // first predicate alone would resolve a promise without having read anything.
    const { d, engine } = bench();
    const h = heldClient([page([msg('m1', 1500)], null)]);

    const p1 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();
    let unmounted = false;
    const p2 = catchUpRoom(h.client, engine, 'r1', () => unmounted);
    const p3 = catchUpRoom(h.client, engine, 'r1'); // joins p2's pass
    unmounted = true; // p2's screen goes away, p3's stays

    await h.openAll();
    await Promise.all([p1, p2, p3]);

    assert.equal(
      h.urls.filter((u) => u.includes('type=UPDATED')).length,
      2,
      'the joined pass did read',
    );
    assert.deepEqual(d.messages, ['m1', 'm1']);
  });

  test('… and it does give up when they ALL let go', async () => {
    // Proof by removing the previous test: without this case, `every` could
    // be a disguised `some` and nobody would notice.
    const { d, engine } = bench();
    const h = heldClient([page([msg('m1', 1500)], null)]);

    const p1 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();
    const p2 = catchUpRoom(h.client, engine, 'r1', () => true);
    const p3 = catchUpRoom(h.client, engine, 'r1', () => true);

    await h.openAll();
    await Promise.all([p1, p2, p3]);

    assert.deepEqual(d.messages, ['m1'], 'only the 1st pass wrote');
  });

  test('the failure of a pass does not cancel the request for the next one', async () => {
    const { d, engine } = bench();
    const h = heldClient([0, page([msg('m1', 1500)], null)]);

    const p1 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();
    const p2 = catchUpRoom(h.client, engine, 'r1');

    await h.openAll();
    await assert.rejects(() => p1, 'the failure stays the failure of ITS requester');
    await p2;

    assert.deepEqual(d.messages, ['m1'], 'the second read anyway');
  });

  test('a pass from a CLOSED session does not hold back the new one', async () => {
    // On an account or server switch, the previous client is put away and its
    // `isDiscarded` will stay true forever. Chaining behind it would make
    // the new session wait for nothing, until the 15 s timeout.
    const { engine } = bench();
    const old = heldClient([page([], null)]);
    const fresh = heldClient([page([], null)]);

    const p1 = catchUpRoom(old.client, engine, 'r1', () => true);
    await old.turn();
    const p2 = catchUpRoom(fresh.client, engine, 'r1');
    await fresh.turn();

    assert.equal(fresh.urls.length, 1, 'the new session reads right away');

    await old.openAll();
    await fresh.openAll();
    await Promise.all([p1, p2]);
  });

  test('once everything has settled, the next request starts a fresh pass', async () => {
    // Otherwise the entry would stay in the table forever and each opening would
    // chain behind a dead promise.
    const { engine } = bench();
    const h = heldClient([page([], null)]);

    await (async () => {
      const p = catchUpRoom(h.client, engine, 'r1');
      await h.openAll();
      await p;
    })();
    const before = h.urls.length;

    const p2 = catchUpRoom(h.client, engine, 'r1');
    await h.turn();
    assert.ok(h.urls.length > before, 'it started without waiting for anyone');

    await h.openAll();
    await p2;
  });
});

describe('reconcileRooms', () => {
  test('purges the rids missing from the live list of subscriptions', async () => {
    const d = fullFakeStore();
    d.known.push('r1', 'r2', 'rGhost');
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client, urls } = fakeClient({
      'subscriptions.get': { update: [{ rid: 'r1' }, { rid: 'r2' }] },
    });
    await reconcileRooms(client, engine);
    // Full: no updatedSince, we want the current state, not a delta.
    assert.match(urls[0], /\/subscriptions\.get(\?|$)/);
    assert.doesNotMatch(urls[0], /updatedSince/);
    assert.deepEqual(d.purges, [{ alive: ['r1', 'r2'], known: ['r1', 'r2', 'rGhost'] }]);
  });

  test('the snapshot of known rids is taken BEFORE the network request', async () => {
    const d = fullFakeStore();
    d.known.push('r1', 'r2');
    const engine = new SyncEngine(d.store, new RcTranslator());
    // The DDP stream writes a brand new DM during the round trip. It is neither
    // in the server's response (computed before it existed), nor in
    // the snapshot, so the purge must not be able to reach it.
    const { client } = fakeClient(
      { 'subscriptions.get': { update: [{ rid: 'r1' }] } },
      () => void d.known.push('rNew'),
    );
    await reconcileRooms(client, engine);
    assert.deepEqual(d.purges, [{ alive: ['r1'], known: ['r1', 'r2'] }]);
    assert.ok(!d.purges[0].known.includes('rNew'), 'the DM created in flight is out of reach');
  });


  test('an empty list purges NOTHING: guard against a total purge', async () => {
    const d = fullFakeStore();
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client } = fakeClient({ 'subscriptions.get': { update: [] } });
    await reconcileRooms(client, engine);
    assert.equal(d.purges.length, 0);
  });

  test('abandoned in flight: no purge', async () => {
    const d = fullFakeStore();
    const engine = new SyncEngine(d.store, new RcTranslator());
    const { client } = fakeClient({ 'subscriptions.get': { update: [{ rid: 'r1' }] } });
    await reconcileRooms(client, engine, () => true);
    assert.equal(d.purges.length, 0);
  });
});
