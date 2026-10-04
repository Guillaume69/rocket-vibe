import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { setUpConnection } from './connectionSetup.ts';

/** A promise whose settling (when and how) the test decides. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yields to pending microtasks, without sleeping. */
const letRun = async (turns = 6): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

/**
 * Bench: a stream and an arming settled by hand, in any order. No clock,
 * which is the whole point of the module.
 */
function bench(options: { alreadyActive?: boolean } = {}) {
  const stream = deferred<void>();
  const arming = deferred<void>();
  const order: string[] = [];
  /** What the stream covered at the START of each read. */
  const coverage: boolean[] = [];
  let armed = options.alreadyActive ?? false;

  return {
    stream,
    arming,
    order,
    coverage,
    /** The server armed the subscriptions: from here on, the stream covers. */
    arm() {
      armed = true;
      arming.resolve();
    },
    options: {
      streamAlreadyActive: () => armed,
      openStream: () => {
        order.push('stream:request');
        return stream.promise;
      },
      streamArmed: () => arming.promise,
      catchUp: async () => {
        order.push('read');
        coverage.push(armed);
      },
      then: () => order.push('then'),
    },
  };
}

describe('setUpConnection', () => {
  test('instant stream: the read does not wait for it, the second one covers it', async () => {
    const b = bench();
    const done = setUpConnection(b.options);

    // The read starts without waiting for anything: this is what the user sees.
    await letRun();
    assert.deepEqual(b.order, ['stream:request', 'read', 'then']);

    b.stream.resolve();
    b.arm();
    await done;

    assert.deepEqual(b.order, ['stream:request', 'read', 'then', 'read']);
    // The first read before arming, the second after: the second guarantees
    // that no window escapes both transports.
    assert.deepEqual(b.coverage, [false, true]);
  });

  test('very slow stream: nothing changes, same order, same guarantees', async () => {
    const b = bench();
    const done = setUpConnection(b.options);

    await letRun();
    assert.deepEqual(b.order, ['stream:request', 'read', 'then'], 'read already done');

    // The stream takes "a long time", here an arbitrary number of loop turns.
    // No time constant applies: nothing is decided during that span.
    await letRun(50);
    assert.deepEqual(b.order, ['stream:request', 'read', 'then']);

    b.stream.resolve();
    await letRun();
    // Still no second read: the subscriptions are not armed.
    assert.deepEqual(b.order, ['stream:request', 'read', 'then']);

    b.arm();
    await done;
    assert.deepEqual(b.coverage, [false, true], 'the second read covers');
  });

  test('stream already active: a single read, and it covers', async () => {
    const b = bench({ alreadyActive: true });
    b.stream.resolve(); // live socket: `openStream` does nothing

    await setUpConnection(b.options);

    assert.deepEqual(b.order, ['stream:request', 'read', 'then']);
    assert.deepEqual(b.coverage, [true]);
  });

  test('the stream failure is relayed, but after the user got their messages', async () => {
    const b = bench();
    const done = setUpConnection(b.options);
    const expected = done.then(
      () => null,
      (e: unknown) => e,
    );

    await letRun();
    assert.deepEqual(b.order, ['stream:request', 'read', 'then'], 'the read happened');

    b.stream.reject(new Error('no "connected" within 10000 ms'));
    const error = await expected;

    // Relayed so the reconnect driver keeps its backoff...
    assert.ok(error instanceof Error);
    assert.match(error.message, /connected/);
    // ...and without a second read: without a stream there is no window to
    // cover, and the next attempt redoes the whole thing.
    assert.deepEqual(b.coverage, [false]);
  });

  test('a failing read fails the connection setup (the driver will retry)', async () => {
    const b = bench({ alreadyActive: true });
    b.stream.resolve();
    await assert.rejects(
      setUpConnection({ ...b.options, catchUp: () => Promise.reject(new Error('rooms.get: 429')) }),
      /429/,
    );
  });

  test('session ended before the read: nothing is touched any more', async () => {
    const b = bench();
    b.stream.resolve();
    await setUpConnection({ ...b.options, isDiscarded: () => true });

    assert.deepEqual(b.order, ['stream:request']);
  });

  test('session ended during the read: no second pass', async () => {
    const b = bench();
    let discarded = false;
    const done = setUpConnection({
      ...b.options,
      catchUp: async () => {
        b.order.push('read');
        discarded = true; // the user logs out during the read
      },
      isDiscarded: () => discarded,
    });

    b.stream.resolve();
    b.arm();
    await done;

    assert.deepEqual(b.order, ['stream:request', 'read', 'then']);
  });
});
