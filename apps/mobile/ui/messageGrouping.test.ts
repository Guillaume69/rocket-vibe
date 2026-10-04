import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GROUP_WINDOW_MS, repeatedTimeIds, continuationIds } from './messageGrouping.ts';

/** A minimal message, ordinary by default (`systemType: null`). */
const m = (id: string, ts: number, authorId: string, systemType: string | null = null) => ({
  id,
  ts,
  authorId,
  systemType,
});

describe('continuationIds', () => {
  test('same author within the window: the row below is a continuation, in both orders', () => {
    // DESC (room): m2 is the newest, its chronological predecessor is the
    // NEXT element of the array.
    const desc = [m('m2', 60_000, 'bob'), m('m1', 0, 'bob')];
    assert.deepEqual(continuationIds(desc, 'newest-first'), new Set(['m2']));
    // ASC (thread): same pair, array reversed, same conclusion.
    const asc = [m('m1', 0, 'bob'), m('m2', 60_000, 'bob')];
    assert.deepEqual(continuationIds(asc, 'oldest-first'), new Set(['m2']));
  });

  test("a different author breaks the group, then the group resumes after", () => {
    // bob, alice, bob, bob: only the LAST bob-bob pair groups.
    const desc = [m('m4', 3000, 'bob'), m('m3', 2000, 'bob'), m('m2', 1000, 'alice'), m('m1', 0, 'bob')];
    assert.deepEqual(continuationIds(desc, 'newest-first'), new Set(['m4']));
  });

  test('the time window: exactly 5 min still groups, one ms more does not', () => {
    const justBefore = [m('m2', GROUP_WINDOW_MS, 'bob'), m('m1', 0, 'bob')];
    assert.deepEqual(continuationIds(justBefore, 'newest-first'), new Set(['m2']));
    const tooFar = [m('m2', GROUP_WINDOW_MS + 1, 'bob'), m('m1', 0, 'bob')];
    assert.deepEqual(continuationIds(tooFar, 'newest-first'), new Set());
  });

  test('the "new messages" bar breaks: the first unread keeps its header', () => {
    const desc = [m('m2', 1000, 'bob'), { bar: true as const, id: 'barre-nouveaux' }, m('m1', 0, 'bob')];
    assert.deepEqual(continuationIds(desc, 'newest-first'), new Set());
  });

  test('the day separator breaks: 23:58 then 00:02 pass the window, not the boundary', () => {
    // Two messages 4 min apart but on either side of midnight: the separator
    // inserted between them (ui/daySeparator) breaks the group.
    const desc = [
      m('m2', 242_000, 'bob'),
      { day: true, id: 'jour-20260801', ts: 242_000 },
      m('m1', 2_000, 'bob'),
    ];
    assert.deepEqual(continuationIds(desc, 'newest-first'), new Set());
  });

  test('a system message groups neither as a continuation nor as a group head', () => {
    // bob writes, "bob joined" (uj), bob writes: nobody groups, the system
    // message breaks both sides.
    const desc = [m('m3', 2000, 'bob'), m('m2', 1000, 'bob', 'uj'), m('m1', 0, 'bob')];
    assert.deepEqual(continuationIds(desc, 'newest-first'), new Set());
  });

  test("`e2e` renders as an ordinary message: it groups normally", () => {
    const desc = [m('m2', 1000, 'bob', 'e2e'), m('m1', 0, 'bob', 'e2e')];
    assert.deepEqual(continuationIds(desc, 'newest-first'), new Set(['m2']));
  });

  test('edges: empty list, lone message, never a continuation', () => {
    assert.deepEqual(continuationIds([], 'newest-first'), new Set());
    assert.deepEqual(continuationIds([m('m1', 0, 'bob')], 'oldest-first'), new Set());
  });
});

describe('repeatedTimeIds', () => {
  /** Projects like the screens do: continuations first, then repeated times. */
  const project = (
    rows: Parameters<typeof continuationIds>[0],
    order: 'newest-first' | 'oldest-first',
  ) => repeatedTimeIds(rows, order, continuationIds(rows, order));

  test("a continuation in the SAME minute as the message above hides its time, in both orders", () => {
    // 0 ms and 59,999 ms: same displayed minute, m2's time is redundant.
    const desc = [m('m2', 59_999, 'bob'), m('m1', 0, 'bob')];
    assert.deepEqual(project(desc, 'newest-first'), new Set(['m2']));
    const asc = [m('m1', 0, 'bob'), m('m2', 59_999, 'bob')];
    assert.deepEqual(project(asc, 'oldest-first'), new Set(['m2']));
  });

  test('a continuation in the NEXT minute keeps its time, even one second apart', () => {
    // 59,999 ms then 60,000 ms: 1 ms apart but two displayed minutes.
    const desc = [m('m2', 60_000, 'bob'), m('m1', 59_999, 'bob')];
    assert.deepEqual(project(desc, 'newest-first'), new Set());
  });

  test("a chain: each minute break shows the time again, repetitions stay silent", () => {
    // 11:03, 11:03, 11:04, 11:04 (epoch minutes 3, 3, 4, 4): the head shows its
    // header time, m2 stays silent (same minute), m3 shows again (new minute), m4
    // stays silent (same minute as m3, whose time is rendered).
    const desc = [
      m('m4', 4 * 60_000 + 30_000, 'bob'),
      m('m3', 4 * 60_000, 'bob'),
      m('m2', 3 * 60_000 + 40_000, 'bob'),
      m('m1', 3 * 60_000, 'bob'),
    ];
    assert.deepEqual(project(desc, 'newest-first'), new Set(['m2', 'm4']));
  });

  test("a NON-continuation is never affected: the redisplayed header already carries the time", () => {
    // Same minute but different authors: m2 is not a continuation, its header
    // (username + time) renders whole, nothing to hide.
    const desc = [m('m2', 30_000, 'alice'), m('m1', 0, 'bob')];
    assert.deepEqual(project(desc, 'newest-first'), new Set());
  });
});
