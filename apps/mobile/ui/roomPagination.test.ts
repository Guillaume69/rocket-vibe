import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { advanceBound, boundIsStuck, pageMovedBack, MAX_PAGES_AT_BOUND } from './roomPagination.ts';

describe('advanceBound / boundIsStuck', () => {
  test('first request: the bound starts at one page', () => {
    assert.deepEqual(advanceBound(null, 'm1'), { id: 'm1', pages: 1 });
  });

  test('same bound: we count; new bound: back to 1', () => {
    const two = advanceBound({ id: 'm1', pages: 1 }, 'm1');
    assert.deepEqual(two, { id: 'm1', pages: 2 });
    assert.deepEqual(advanceBound(two, 'm0'), { id: 'm0', pages: 1 });
  });

  test(`the safety net tolerates ${MAX_PAGES_AT_BOUND} stuck pages, the next one declares exhaustion`, () => {
    let bound = advanceBound(null, 'm1');
    assert.equal(boundIsStuck(bound), false, 'first page: request');
    bound = advanceBound(bound, 'm1');
    assert.equal(boundIsStuck(bound), false, 'second page on the same bound: still allowed');
    bound = advanceBound(bound, 'm1');
    assert.equal(boundIsStuck(bound), true, 'third: pagination no longer moves, cut off');
  });

  test('a moving bound never trips the safety net', () => {
    let bound = advanceBound(null, 'm3');
    bound = advanceBound(bound, 'm2');
    bound = advanceBound(bound, 'm1');
    assert.equal(boundIsStuck(bound), false);
  });
});

describe('pageMovedBack', () => {
  test('a message STRICTLY older than the bound: the page moved back', () => {
    assert.equal(pageMovedBack(100, 200), true);
  });

  test('THE 429 trap: a page full of tied twins has NOT moved back', () => {
    // `inclusive: true` returns the bound AND all its twins of the same
    // millisecond (bot burst, import). Counting `n > 1` concluded "there is past
    // left" forever: `passExhausted` never set, re-ingestion re-triggered
    // `onEndReached` (FlashList v2 re-arms it on every data change), and the
    // loop held until the 429.
    assert.equal(pageMovedBack(200, 200), false);
  });

  test('empty page (null): nothing behind, no move back', () => {
    assert.equal(pageMovedBack(null, 200), false);
  });

  test('page NEWER than the bound (aberrant response): not a move back either', () => {
    assert.equal(pageMovedBack(300, 200), false);
  });
});
