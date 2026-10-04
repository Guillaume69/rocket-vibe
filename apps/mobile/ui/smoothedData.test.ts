import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { smoothingDecision } from './smoothedData.ts';

describe('smoothingDecision', () => {
  test('first render (lastRenderMs = 0): the value goes through at once', () => {
    assert.deepEqual(smoothingDecision(0, 1_000_000, 200), { immediate: true });
  });

  test('enough time elapsed: immediate, smoothing does not delay a calm stream', () => {
    assert.deepEqual(smoothingDecision(1_000, 1_200, 200), { immediate: true });
    assert.deepEqual(smoothingDecision(1_000, 1_500, 200), { immediate: true });
  });

  test('mid-burst: wait EXACTLY the rest of the window', () => {
    // Rendered at t=1000, new value at t=1150: 50 ms of window left.
    assert.deepEqual(smoothingDecision(1_000, 1_150, 200), { immediate: false, waitMs: 50 });
    // Right inside the window: a full 200 ms to wait.
    assert.deepEqual(smoothingDecision(1_000, 1_000, 200), { immediate: false, waitMs: 200 });
  });

  test('at the exact boundary, publish: `>=`, not `>`', () => {
    assert.deepEqual(smoothingDecision(1_000, 1_200, 200), { immediate: true });
    assert.deepEqual(smoothingDecision(1_000, 1_199, 200), { immediate: false, waitMs: 1 });
  });

  test('zero delay: always immediate, smoothing switches off cleanly', () => {
    assert.deepEqual(smoothingDecision(1_000, 1_000, 0), { immediate: true });
  });
});
