/**
 * The profile opening mechanics: the race between `users.info`, the call probe
 * and the 2 s cap, the deferred anti-flash indicator, the reentrancy guard.
 * Testable since the module became PURE lib/ (workstream 15): navigation is
 * injected (`setProfileNavigator`), no more expo-router.
 *
 * Timers and `Date` mocked (`t.mock.timers`): no real waiting. Between each
 * `tick`, microtasks are drained: the module's `then` chains advance one step
 * per turn.
 *
 * Mock TRAP (verified on Node 24): `tick(n)` sets `Date.now()` to the TARGET
 * before running the callbacks on the way: a callback armed at 450 would read
 * 2000 in a `tick(2000)`, and the anti-flash would compute a wait never ticked
 * (hang). So tick PER DEADLINE, never in one block.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test, type TestContext } from 'node:test';

import { forgetCallAvailability } from './call.ts';
import {
  setProfileClient,
  setProfileNavigator,
  readPreloadedProfile,
  forgetProfileCards,
  openProfileCard,
  subscribeProfileOpening,
  type ProfileParams,
} from './profilePreload.ts';
import type { RestClient } from './rest.ts';

const USER = { _id: 'u1', username: 'alice' };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeClient(handles: {
  usersInfo: () => Promise<unknown>;
  capabilities: () => Promise<unknown>;
}): RestClient {
  return {
    baseUrl: 'http://banc.local',
    get: (path: string) =>
      path === 'users.info' ? handles.usersInfo() : handles.capabilities(),
  } as unknown as RestClient;
}

/** Enough turns to exhaust the module's `then`/`await` chains. */
async function drain(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

describe('openProfileCard', () => {
  let navigations: ProfileParams[];

  beforeEach(() => {
    navigations = [];
    forgetProfileCards();
    forgetCallAvailability();
    setProfileNavigator((p) => navigations.push(p));
  });

  test('fast answer: profile cached, navigation, indicator never shown', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    setProfileClient(
      fakeClient({
        usersInfo: () => Promise.resolve({ user: USER }),
        capabilities: () => Promise.resolve({}),
      }),
    );
    const busy: boolean[] = [];
    const unsubscribe = subscribeProfileOpening((v) => busy.push(v));

    const end = openProfileCard({ username: 'alice' });
    await drain();
    await end;

    assert.deepEqual(navigations, [{ username: 'alice' }]);
    assert.deepEqual(readPreloadedProfile({ username: 'alice' }), {
      user: USER,
      error: null,
    });
    // `subscribeProfileOpening` replays the current state (false) on subscribe;
    // nothing else may have shown under the threshold.
    assert.deepEqual(busy, [false]);
    unsubscribe();
  });

  test('the call probe counts toward the cap: it lags, opening at 2 s without a profile', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    // `users.info` answers right away, the PROBE is what hangs: the
    // `Promise.all` must not resolve, and only the cap opens.
    setProfileClient(
      fakeClient({
        usersInfo: () => Promise.resolve({ user: USER }),
        capabilities: () => deferred<unknown>().promise,
      }),
    );

    const end = openProfileCard({ username: 'alice' });
    await drain();
    assert.deepEqual(navigations, [], 'nothing may open before the cap');

    t.mock.timers.tick(450); // the indicator, at ITS time (see the header)
    t.mock.timers.tick(1550); // then the cap
    await drain();
    await end;

    assert.deepEqual(navigations, [{ username: 'alice' }]);
    // Cap exceeded: the entry is PURGED, the screen will redo its load rather
    // than serve a profile whose height would lie.
    assert.equal(readPreloadedProfile({ username: 'alice' }), undefined);
  });

  test('everything lags: the indicator shows at 450 ms and turns off on opening', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    setProfileClient(
      fakeClient({
        usersInfo: () => deferred<unknown>().promise,
        capabilities: () => deferred<unknown>().promise,
      }),
    );
    const busy: boolean[] = [];
    const unsubscribe = subscribeProfileOpening((v) => busy.push(v));

    const end = openProfileCard({ username: 'alice' });
    await drain();
    t.mock.timers.tick(450);
    await drain();
    assert.deepEqual(busy, [false, true], 'past the threshold, the pill is there');

    t.mock.timers.tick(1550);
    await drain();
    await end;

    // Shown for 1,550 ms > minimum 400: immediate turn-off, opening.
    assert.deepEqual(busy, [false, true, false]);
    assert.deepEqual(navigations, [{ username: 'alice' }]);
    unsubscribe();
  });

  test('anti-flash: an answer just after the threshold holds the pill 400 ms', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const card = deferred<unknown>();
    setProfileClient(
      fakeClient({
        usersInfo: () => card.promise,
        capabilities: () => Promise.resolve({}),
      }),
    );
    const busy: boolean[] = [];
    const unsubscribe = subscribeProfileOpening((v) => busy.push(v));

    const end = openProfileCard({ username: 'alice' });
    await drain();
    t.mock.timers.tick(450);
    t.mock.timers.tick(50);
    card.resolve({ user: USER });
    await drain();

    // Answer at 500 ms, pill born at 450: it must hold until 850.
    assert.deepEqual(busy, [false, true]);
    assert.deepEqual(navigations, [], 'the opening waits for the pill to end');

    t.mock.timers.tick(349);
    await drain();
    assert.deepEqual(busy, [false, true]);

    t.mock.timers.tick(1);
    await drain();
    await end;
    assert.deepEqual(busy, [false, true, false]);
    assert.deepEqual(navigations, [{ username: 'alice' }]);
    unsubscribe();
  });

  test('reentrancy: same target merged into the flight in progress, other target not blocked', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const card = deferred<unknown>();
    setProfileClient(
      fakeClient({
        usersInfo: () => card.promise,
        capabilities: () => Promise.resolve({}),
      }),
    );

    const first = openProfileCard({ username: 'alice' });
    await drain();
    // Second tap on the SAME profile during the flight: absorbed by the guard.
    const duplicate = openProfileCard({ username: 'alice' });
    // A tap on ANOTHER profile goes through: a global lock would swallow it.
    const other = openProfileCard({ username: 'bob' });
    await drain();

    card.resolve({ user: USER });
    await drain();
    await Promise.all([first, duplicate, other]);

    // Alice first: her chain subscribed first to the shared profile; the order
    // follows the microtasks, not the guard's "takeover".
    assert.deepEqual(navigations, [{ username: 'alice' }, { username: 'bob' }]);

    // Flight over, the guard is released: reopening navigates again.
    await openProfileCard({ username: 'alice' });
    await drain();
    assert.equal(navigations.length, 3);
  });
});
