import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PRESENCE_EVENT, PresenceEngine, STREAM_NOTIFY_LOGGED } from './presence.ts';
import { RestClient } from './rest.ts';

const event = (args: unknown[]) => ({
  collection: STREAM_NOTIFY_LOGGED,
  eventKey: PRESENCE_EVENT,
  args,
});

/** Real REST client, mocked fetch: exercises the URL actually built. */
function fakeClient(reply: (url: string) => unknown) {
  const urls: string[] = [];
  const client = new RestClient('http://x', {
    fetch: async (url) => {
      urls.push(String(url));
      const body = reply(String(url));
      if (body instanceof Error) throw body;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => {},
  });
  return { client, urls };
}

describe('PresenceEngine: stream', () => {
  test('a user-status event updates the status and notifies', () => {
    const engine = new PresenceEngine();
    let notifications = 0;
    engine.onChange(() => notifications++);

    engine.apply(event([['u1', 'bob', 3, '']]));
    assert.equal(engine.statusOf('u1'), 'busy');
    assert.equal(notifications, 1);

    engine.apply(event([['u1', 'bob', 0, '']]));
    assert.equal(engine.statusOf('u1'), 'offline');
  });

  test('foreign collection or key, unknown number, empty uid: silently ignored', () => {
    const engine = new PresenceEngine();
    let notifications = 0;
    engine.onChange(() => notifications++);

    engine.apply({ collection: 'stream-room-messages', eventKey: 'r1', args: [{}] });
    engine.apply({
      collection: STREAM_NOTIFY_LOGGED,
      eventKey: 'updateCustomUserStatus',
      args: [{}],
    });
    engine.apply(event([['u1', 'bob', 42, '']]));
    engine.apply(event([['', 'bob', 1, '']]));
    engine.apply(event(['not-an-array']));

    assert.equal(engine.statusOf('u1'), null);
    assert.equal(notifications, 0);
  });
});

describe('PresenceEngine: users.presence', () => {
  test('full snapshot, NEVER a from (local-clock cursor forbidden)', async () => {
    const engine = new PresenceEngine();
    const { client, urls } = fakeClient(() => ({
      users: [
        { _id: 'u1', status: 'online' },
        { _id: 'u2', status: 'busy' },
      ],
      full: true,
    }));

    await engine.load(client);
    await engine.load(client);
    assert.ok(urls.every((u) => !u.includes('from=')));
    assert.equal(engine.statusOf('u1'), 'online');
    assert.equal(engine.statusOf('u2'), 'busy');
  });

  test('a KNOWN uid absent from the snapshot goes offline; unknowns stay unknown', async () => {
    const engine = new PresenceEngine();
    engine.apply(event([['u1', 'bob', 1, '']]));
    const { client } = fakeClient(() => ({ users: [{ _id: 'u2', status: 'away' }], full: true }));

    await engine.load(client);
    assert.equal(engine.statusOf('u1'), 'offline', 'the snapshot only includes non-offline users');
    assert.equal(engine.statusOf('u2'), 'away');
    assert.equal(engine.statusOf('u3'), null, 'never seen: still unknown');
  });

  test('a STREAM event arriving during the request wins over the snapshot', async () => {
    const engine = new PresenceEngine();
    let deliver: () => void = () => {};
    const { client } = fakeClient(() => ({ users: [{ _id: 'u1', status: 'online' }] }));
    // The event is slipped in between the request leaving and its response:
    // the fake fetch is synchronous, so a control promise is used.
    const slowClient = {
      get: async (...args: unknown[]) => {
        await new Promise<void>((r) => {
          deliver = r;
        });
        return (client.get as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    } as unknown as typeof client;

    const loading = engine.load(slowClient);
    await Promise.resolve(); // lets `snapshot` take its threshold and leave
    engine.apply(event([['u1', 'bob', 0, '']])); // offline, FRESHER
    deliver();
    await loading;

    assert.equal(engine.statusOf('u1'), 'offline', 'the (older) snapshot does not regress u1');
  });

  test('REST failure: silent, the known state survives (graceful degradation)', async () => {
    const engine = new PresenceEngine();
    engine.apply(event([['u1', 'bob', 1, '']]));
    const { client } = fakeClient(() => new TypeError('Network request failed'));

    await engine.load(client); // must not throw
    assert.equal(engine.statusOf('u1'), 'online');
  });
});

describe('PresenceEngine: invalidation', () => {
  test('invalidate makes EVERYTHING unknown and notifies', () => {
    // The contract of the module header: "a stale presence shown from a cache
    // is worse than no presence at all". It was only kept against
    // persistence; in memory, the green dot from before the tunnel stayed on
    // screen until the next connection setup.
    const engine = new PresenceEngine();
    engine.apply(event([['u1', 'bob', 1, '']]));
    engine.apply(event([['u2', 'ana', 2, '']]));
    let notifications = 0;
    engine.onChange(() => notifications++);

    engine.invalidate();

    assert.equal(engine.statusOf('u1'), null, 'the UI shows nothing any more, instead of lying');
    assert.equal(engine.statusOf('u2'), null);
    assert.equal(notifications, 1, 'mounted screens must redraw');
  });

  test('invalidate with nothing to forget does not wake screens', () => {
    const engine = new PresenceEngine();
    let notifications = 0;
    engine.onChange(() => notifications++);
    engine.invalidate();
    engine.invalidate();
    assert.equal(notifications, 0, 'a network flap on a silent app redraws nothing');
  });

  test('a snapshot SENT before the invalidation does not revive cleared statuses', async () => {
    // Real race: the socket dies while `users.presence` is in flight. Its
    // response describes the world BEFORE the cut; applying it would restore
    // exactly the dots the invalidation had just turned off.
    const engine = new PresenceEngine();
    let deliver: () => void = () => {};
    const { client } = fakeClient(() => ({
      users: [
        { _id: 'u1', status: 'online' },
        { _id: 'u2', status: 'away' },
      ],
    }));
    const slowClient = {
      get: async (...args: unknown[]) => {
        await new Promise<void>((r) => {
          deliver = r;
        });
        return (client.get as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    } as unknown as typeof client;

    const loading = engine.load(slowClient);
    await Promise.resolve(); // the request has left
    engine.invalidate(); // the transport dies
    deliver();
    await loading;

    assert.equal(engine.statusOf('u1'), null, 'the snapshot from before the cut is dropped');
    assert.equal(engine.statusOf('u2'), null);
  });

  test('after invalidation, a NEW snapshot repopulates normally', async () => {
    const engine = new PresenceEngine();
    engine.apply(event([['u1', 'bob', 1, '']]));
    engine.invalidate();
    const { client } = fakeClient(() => ({ users: [{ _id: 'u1', status: 'away' }] }));

    await engine.load(client);
    assert.equal(engine.statusOf('u1'), 'away');
  });

  test('a STREAM event after the invalidation wins over the in-flight snapshot', async () => {
    // The sequence counter must stay MONOTONIC across the invalidation:
    // resetting it would make a fresh event look older than the threshold the
    // snapshot took, and the snapshot would overwrite it.
    const engine = new PresenceEngine();
    for (let i = 0; i < 5; i++) engine.apply(event([[`u${i}`, 'x', 1, '']]));
    let deliver: () => void = () => {};
    const { client } = fakeClient(() => ({ users: [{ _id: 'u1', status: 'online' }] }));
    const slowClient = {
      get: async (...args: unknown[]) => {
        await new Promise<void>((r) => {
          deliver = r;
        });
        return (client.get as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    } as unknown as typeof client;

    const loading = engine.load(slowClient);
    await Promise.resolve();
    engine.invalidate();
    engine.apply(event([['u1', 'bob', 0, '']])); // received AFTER, so true
    deliver();
    await loading;

    assert.equal(engine.statusOf('u1'), 'offline');
  });
});
