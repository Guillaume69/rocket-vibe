import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Reconnector } from './reconnect.ts';

/** Simulated clock: timers fire when WE decide. */
function fakeClock() {
  let nextId = 1;
  const scheduled = new Map<number, { fn: () => void; ms: number }>();
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++;
      scheduled.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (m: ReturnType<typeof setTimeout>) => void scheduled.delete(m as unknown as number),
    /** Fires the next timer and returns its delay. */
    async advance(): Promise<number | null> {
      const [id, entry] = [...scheduled.entries()][0] ?? [];
      if (id === undefined || entry === undefined) return null;
      scheduled.delete(id);
      entry.fn();
      // Let the `tryConnect` promise run.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      return entry.ms;
    },
    pending: () => scheduled.size,
  };
}

describe('Reconnector', () => {
  test('first attempt immediate, then capped exponential backoff', async () => {
    const clock = fakeClock();
    const delays: number[] = [];
    let succeedAfter = 99;
    let attempts = 0;
    const r = new Reconnector({
      connect: async () => {
        attempts++;
        if (attempts <= succeedAfter) throw new Error('pas encore');
      },
      random: () => 1, // deterministic jitter: full delay
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    r.trigger();
    for (let i = 0; i < 8; i++) {
      const ms = await clock.advance();
      if (ms !== null) delays.push(ms);
    }
    // 0 (immediate), then 1 s, 2 s, 4 s, 8 s, 16 s, then the 30 s cap.
    assert.deepEqual(delays, [0, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);

    // A success resets the counter.
    succeedAfter = 0;
    await clock.advance();
    r.trigger();
    const afterSuccess = await clock.advance();
    assert.equal(afterSuccess, 0, 'after a success, the next attempt is immediate');
  });

  test('jitter bounds the delay between half and full', async () => {
    for (const [random, expected] of [
      [0, 500],
      [1, 1000],
    ] as const) {
      const clock = fakeClock();
      const r = new Reconnector({
        connect: async () => {
          throw new Error('non');
        },
        random: () => random,
        schedule: clock.schedule,
        cancel: clock.cancel,
      });
      r.trigger();
      await clock.advance(); // attempt 0, immediate, fails
      const ms = await clock.advance(); // attempt 1: full 1 s
      assert.equal(ms, expected);
    }
  });

  test('trigger is idempotent: a single attempt scheduled at a time', () => {
    const clock = fakeClock();
    const r = new Reconnector({
      connect: async () => {},
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    r.trigger();
    r.trigger();
    assert.equal(clock.pending(), 1);
  });

  test('stop cancels the scheduled attempt and blocks the next ones', async () => {
    const clock = fakeClock();
    let attempts = 0;
    const r = new Reconnector({
      connect: async () => {
        attempts++;
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    r.stop();
    assert.equal(clock.pending(), 0, 'the timer is cancelled');
    r.trigger();
    assert.equal(clock.pending(), 0, 'nothing gets scheduled any more');
    assert.equal(attempts, 0);
  });

  test('a trigger during an attempt that SUCCEEDS is replayed, not swallowed', async () => {
    // Real scenario: the socket drops during the REST reload of an
    // attempt that will "succeed". Without a retry, the signal was lost and
    // nothing ever reconnected again: cache frozen until restart.
    const clock = fakeClock();
    const valve: { open: (() => void) | null } = { open: null };
    let attempts = 0;
    const r = new Reconnector({
      connect: () =>
        new Promise<void>((resolve) => {
          attempts++;
          valve.open = resolve;
        }),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    await clock.advance(); // attempt 1 in flight, blocked on the gate
    r.trigger(); // the socket just dropped: to REMEMBER
    valve.open?.();
    await new Promise((s) => setImmediate(s));
    await new Promise((s) => setImmediate(s));
    assert.equal(clock.pending(), 1, 'a new attempt is scheduled');
    await clock.advance();
    assert.equal(attempts, 2);
  });

  test('suspend cancels the scheduled timer and blocks requests', () => {
    // In the background, the AppState handler deliberately closes the socket and
    // "push takes over". Without suspension, an already armed backoff timer
    // fires anyway: each attempt reopens a socket that
    // Doze will kill, and triggers a rate-limited REST catchUpAll().
    const clock = fakeClock();
    let attempts = 0;
    const r = new Reconnector({
      connect: async () => {
        attempts++;
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    assert.equal(clock.pending(), 1);

    r.suspend();
    assert.equal(clock.pending(), 0, 'the armed timer is disarmed');
    r.trigger();
    assert.equal(clock.pending(), 0, 'no request schedules anything any more');
    assert.equal(attempts, 0);
  });

  test("the failure of an attempt IN FLIGHT does not restart the loop after suspend", async () => {
    // The other path: the timer already fired, the attempt is running, and
    // its `catch` will call `trigger()` again. The flag must hold
    // there too, otherwise going to the background only suspends one half.
    const clock = fakeClock();
    const valve: { fail: ((e: Error) => void) | null } = { fail: null };
    const r = new Reconnector({
      connect: () =>
        new Promise<void>((_, reject) => {
          valve.fail = reject;
        }),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    await clock.advance(); // attempt in flight

    r.suspend(); // the app goes to the background during the attempt
    valve.fail?.(new Error('réseau coupé'));
    await new Promise((s) => setImmediate(s));
    await new Promise((s) => setImmediate(s));

    assert.equal(clock.pending(), 0, 'nothing gets rescheduled in the background');
  });

  test('a retry remembered during a SUCCESSFUL attempt does not survive suspend', async () => {
    const clock = fakeClock();
    const valve: { open: (() => void) | null } = { open: null };
    const r = new Reconnector({
      connect: () =>
        new Promise<void>((resolve) => {
          valve.open = resolve;
        }),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    await clock.advance();
    r.trigger(); // the socket drops: retry remembered
    r.suspend(); // …then the app goes to the background
    valve.open?.();
    await new Promise((s) => setImmediate(s));
    await new Promise((s) => setImmediate(s));

    assert.equal(clock.pending(), 0);
  });

  test('resume rearms, and the attempt is IMMEDIATE, not at the end of the backoff', async () => {
    // The accumulated backoff describes a network observed with the screen off. Back in
    // the foreground the situation is new, and it is a user gesture:
    // making them wait 30 s would be the penalty this workstream wants to remove.
    const clock = fakeClock();
    let attempts = 0;
    const r = new Reconnector({
      connect: async () => {
        attempts++;
        throw new Error('non');
      },
      random: () => 1,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    for (let i = 0; i < 6; i++) await clock.advance(); // the backoff climbs
    assert.equal(attempts, 6);

    r.suspend();
    r.resume();
    r.trigger();
    assert.equal(await clock.advance(), 0, 'immediate on return');
    assert.equal(attempts, 7);
  });

  test('resume does not revive a stopped driver', () => {
    const clock = fakeClock();
    const r = new Reconnector({
      connect: async () => {},
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.stop(); // unmount: final
    r.resume();
    r.trigger();
    assert.equal(clock.pending(), 0);
  });

  test('a trigger DURING an attempt in flight does not double up', async () => {
    const clock = fakeClock();
    const valve: { open: (() => void) | null } = { open: null };
    let attempts = 0;
    const r = new Reconnector({
      connect: () =>
        new Promise<void>((resolve) => {
          attempts++;
          valve.open = resolve;
        }),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    await clock.advance(); // starts the attempt, which blocks on the gate
    r.trigger(); // in flight: must not schedule anything
    assert.equal(clock.pending(), 0);
    valve.open?.();
    await new Promise((s) => setImmediate(s));
    assert.equal(attempts, 1);
  });
});
