import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  finishPendingLogouts,
  type PendingLogout,
  type LogoutQueue,
} from './deferredLogout.ts';
import { RestClient } from './rest.ts';

const ENTRY: PendingLogout = {
  baseUrl: 'https://x',
  userId: 'u1',
  authToken: 'jeton-mort-ou-vif',
  jetonPush: 'fcm-abc',
};

/** In-memory queue: we observe what is removed, and what remains. */
function file(entries: PendingLogout[]): LogoutQueue & { remaining: () => string[] } {
  let list = [...entries];
  return {
    list: async () => [...list],
    remove: async (baseUrl) => {
      list = list.filter((d) => d.baseUrl !== baseUrl);
    },
    remaining: () => list.map((d) => d.baseUrl),
  };
}

/**
 * Client whose every route returns what the table says. `null` = success (200),
 * a number = that HTTP status with a Rocket.Chat envelope.
 */
function clientThat(responses: Record<string, number | null>) {
  const calls: string[] = [];
  const create = (entry: PendingLogout) =>
    new RestClient(entry.baseUrl, {
      sleep: async () => {},
      now: () => 0,
      random: () => 0,
      fetch: (async (url: string | URL) => {
        const path = String(url).split('/api/v1/')[1] ?? '';
        calls.push(path);
        const status = responses[path] ?? null;
        if (status === 0) throw new TypeError('Network request failed');
        if (status === null) return Response.json({ success: true });
        return Response.json(
          { success: false, error: 'You must be logged in to do this.' },
          { status },
        );
      }) as unknown as typeof globalThis.fetch,
    });
  return { create, calls };
}

describe('finishPendingLogouts', () => {
  test('both actions succeed: the entry is settled', async () => {
    const f = file([ENTRY]);
    const { create, calls } = clientThat({});
    await finishPendingLogouts(f, create);
    assert.deepEqual(calls, ['push.token', 'logout'], 'the DELETE BEFORE the logout');
    assert.deepEqual(f.remaining(), [], 'nothing left to replay');
  });

  test('network still down: the entry SURVIVES for the next startup', async () => {
    // The nominal case: the user logged out in the subway, and turns the phone
    // back on still out of coverage. Losing the entry here leaves the server
    // pushing to a device with no account forever.
    const f = file([ENTRY]);
    const { create } = clientThat({ 'push.token': 0, logout: 0 });
    await finishPendingLogouts(f, create);
    assert.deepEqual(f.remaining(), ['https://x']);
  });

  test('the server already killed the token (401): the entry is settled, not retried', async () => {
    // `logout` may have succeeded where the DELETE failed, or the server
    // expired the session. Nothing is left to kill: keeping the entry would
    // replay a call doomed to 401 on every startup, forever.
    const f = file([ENTRY]);
    const { create } = clientThat({ 'push.token': 401, logout: 401 });
    await finishPendingLogouts(f, create);
    assert.deepEqual(f.remaining(), []);
  });

  test('an already removed push token (404) does not block the logout', async () => {
    // Reinstall, FCM rotation: the 404 is a successful unregistration.
    const f = file([ENTRY]);
    const { create, calls } = clientThat({ 'push.token': 404 });
    await finishPendingLogouts(f, create);
    assert.deepEqual(calls, ['push.token', 'logout']);
    assert.deepEqual(f.remaining(), []);
  });

  test('the logout is ATTEMPTED even if removing the push token failed', async () => {
    // The two actions are independent: giving up the logout because the push
    // did not go would leave the session open server-side.
    const f = file([ENTRY]);
    const { create, calls } = clientThat({ 'push.token': 0 });
    await finishPendingLogouts(f, create);
    assert.deepEqual(calls, ['push.token', 'logout']);
    assert.deepEqual(f.remaining(), ['https://x'], 'the push remains to be removed');
  });

  test('without a push token, only the logout is played', async () => {
    const f = file([{ ...ENTRY, jetonPush: null }]);
    const { create, calls } = clientThat({});
    await finishPendingLogouts(f, create);
    assert.deepEqual(calls, ['logout']);
    assert.deepEqual(f.remaining(), []);
  });

  test('one server failing does not deprive the others of their turn', async () => {
    // Multi-server: two pending logouts, one unreachable.
    const f = file([
      { ...ENTRY, baseUrl: 'https://mort' },
      { ...ENTRY, baseUrl: 'https://vivant' },
    ]);
    const create = (entry: PendingLogout) =>
      new RestClient(entry.baseUrl, {
        sleep: async () => {},
        fetch: (async (url: string | URL) => {
          if (String(url).includes('mort')) throw new TypeError('Network request failed');
          return Response.json({ success: true });
        }) as unknown as typeof globalThis.fetch,
      });
    await finishPendingLogouts(f, create);
    assert.deepEqual(f.remaining(), ['https://mort']);
  });

  test('an empty queue makes no call', async () => {
    const f = file([]);
    const { create, calls } = clientThat({});
    await finishPendingLogouts(f, create);
    assert.deepEqual(calls, []);
  });
});
