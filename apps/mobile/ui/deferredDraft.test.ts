import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createDeferredDraft, DRAFT_DELAY_MS } from './deferredDraft.ts';

/** Manual clock: nothing fires until time is advanced. */
function clock() {
  const scheduled = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 1;
  return {
    schedule: (fn: () => void, ms: number) => {
      delays.push(ms);
      const id = next++;
      scheduled.set(id, fn);
      return id;
    },
    cancel: (id: unknown) => void scheduled.delete(id as number),
    /** Fires every armed timer. */
    fire: () => {
      const fns = [...scheduled.values()];
      scheduled.clear();
      for (const fn of fns) fn();
    },
    armed: () => scheduled.size,
    delays,
  };
}

/** An instrumented instance: `log` records writes and deletions. */
function make(timeoutMs?: number) {
  const h = clock();
  const log: string[] = [];
  const deferred = createDeferredDraft({
    write: (text) => void log.push(`ecrit:${text}`),
    delete: () => void log.push('supprime'),
    timeoutMs,
    schedule: h.schedule,
    cancel: h.cancel,
  });
  return { h, log, deferred };
}

describe('createDeferredDraft', () => {
  test('one keystroke → ONE write, after the pause, never during', () => {
    const { h, log, deferred } = make();
    deferred.save('bonjou');
    assert.deepEqual(log, [], 'nothing goes out while typing');
    assert.deepEqual(h.delays, [DRAFT_DELAY_MS], "the default pause is the contract's");
    h.fire();
    assert.deepEqual(log, ['ecrit:bonjou']);
  });

  test('two close keystrokes → a single write, the LAST', () => {
    const { h, log, deferred } = make();
    deferred.save('bonjou');
    deferred.save('bonjour');
    assert.equal(h.armed(), 1, 'the first timer is cancelled, not stacked');
    h.fire();
    assert.deepEqual(log, ['ecrit:bonjour']);
  });

  test('BLANK text means deletion, not writing spaces', () => {
    const { h, log, deferred } = make();
    deferred.save('   ');
    h.fire();
    assert.deepEqual(log, ['supprime']);
  });

  test('flushing during the pause → IMMEDIATE write, and nothing after', () => {
    // The screen's unmount: without this flush, the last typed characters would
    // be lost.
    const { h, log, deferred } = make();
    deferred.save('à ne pas perdre');
    deferred.flusher();
    assert.deepEqual(log, ['ecrit:à ne pas perdre']);
    h.fire();
    assert.deepEqual(log, ['ecrit:à ne pas perdre'], 'the cancelled timer does not fire again');
  });

  test('flushing AFTER the timer fired does not write twice, flushing with nothing pending writes nothing', () => {
    const { h, log, deferred } = make();
    deferred.flusher();
    assert.deepEqual(log, [], 'nothing pending, nothing to write');
    deferred.save('déjà écrit');
    h.fire();
    deferred.flusher();
    assert.deepEqual(log, ['ecrit:déjà écrit'], 'sent text is not replayed');
  });

  test('clearing → immediate deletion, the pending keystroke NEVER goes out', () => {
    // Sending the message: the draft is no longer needed, debounce included.
    const { h, log, deferred } = make();
    deferred.save('envoyé entre-temps');
    deferred.clear();
    assert.deepEqual(log, ['supprime']);
    h.fire();
    assert.deepEqual(log, ['supprime']);
  });

  test("key change: the OLD instance's flush writes under its key, the new one stays blank", () => {
    // The contract `useDraft` relies on: one instance PER key, the old one
    // flushed on change (effect cleanup). Text typed in room A, left within
    // 400 ms, lands under A, never under B.
    const h = clock();
    const byKey: Record<string, string[]> = { A: [], B: [] };
    const instance = (key: 'A' | 'B') =>
      createDeferredDraft({
        write: (text) => void byKey[key].push(`ecrit:${text}`),
        delete: () => void byKey[key].push('supprime'),
        schedule: h.schedule,
        cancel: h.cancel,
      });

    const old = instance('A');
    old.save('tapé dans A');
    // The hook switches to B: cleanup → flush of A, fresh instance for B.
    old.flusher();
    const next = instance('B');
    h.fire();
    assert.deepEqual(byKey.A, ['ecrit:tapé dans A']);
    assert.deepEqual(byKey.B, [], 'nothing leaks into the new key');
    next.flusher();
    assert.deepEqual(byKey.B, [], 'the new one has nothing pending to flush');
  });

  test('the pause is configurable: the hook keeps 400 ms, another screen can tighten it', () => {
    const { h, deferred } = make(120);
    deferred.save('x');
    assert.deepEqual(h.delays, [120]);
  });
});
