import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ActivityEngine } from './activity.ts';

/** A promise resolved by hand, to hold a fetch "in flight". */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ActivityEngine', () => {
  test('the scope is on during the fetch, off once it resolves', async () => {
    const m = new ActivityEngine();
    const d = deferred();

    assert.equal(m.active('global'), false, 'idle');
    const tracking = m.track('global', d.promise);
    assert.equal(m.active('global'), true, 'on as soon as it starts (synchronous)');

    d.resolve();
    await tracking;
    assert.equal(m.active('global'), false, 'off at the end');
  });

  test('a failing fetch still switches the scope off, and rejects', async () => {
    const m = new ActivityEngine();
    const d = deferred();

    const tracking = m.track('r1', d.promise);
    d.reject(new Error('network'));

    await assert.rejects(tracking, /network/);
    assert.equal(m.active('r1'), false, 'no stuck counter');
  });

  test('two concurrent fetches: the scope stays on while one remains', async () => {
    const m = new ActivityEngine();
    const a = deferred();
    const b = deferred();

    const its = m.track('r1', a.promise);
    const sb = m.track('r1', b.promise);
    assert.equal(m.active('r1'), true);

    a.resolve();
    await its;
    assert.equal(m.active('r1'), true, 'one remains, still on');

    b.resolve();
    await sb;
    assert.equal(m.active('r1'), false, 'the last one switches off');
  });

  test('scopes are independent', async () => {
    const m = new ActivityEngine();
    const d = deferred();
    const tracking = m.track('global', d.promise);

    assert.equal(m.active('global'), true);
    assert.equal(m.active('r1'), false, 'another scope is untouched');

    d.resolve();
    await tracking;
  });

  test('notifies only on boolean FLIPS (0→1, 1→0), not on a concurrent one', async () => {
    const m = new ActivityEngine();
    let notices = 0;
    m.onChange(() => {
      notices++;
    });

    const a = deferred();
    const b = deferred();
    m.track('r1', a.promise); // 0→1: one notice
    m.track('r1', b.promise); // 1→2: none
    assert.equal(notices, 1);

    a.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(notices, 1, '2→1: still on, no notice');

    b.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(notices, 2, '1→0: a switch-off notice');
  });

  test('onChange returns an unsubscribe that stops the notices', async () => {
    const m = new ActivityEngine();
    let notices = 0;
    const detach = m.onChange(() => {
      notices++;
    });
    detach();

    const d = deferred();
    const tracking = m.track('global', d.promise);
    d.resolve();
    await tracking;
    assert.equal(notices, 0, 'no longer subscribed');
  });
});
