import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { dayKey, insertDaySeparators } from './daySeparator.ts';

/** Timestamps at local NOON: no test depends on the bench's time zone. */
const day = (year: number, month: number, dayOfMonth: number, time = 12) =>
  new Date(year, month - 1, dayOfMonth, time).getTime();

const m = (id: string, ts: number) => ({ id, ts });
const ids = (rows: { id: string }[]): string[] => rows.map((l) => l.id);

describe('insertDaySeparators', () => {
  test('day boundary in DESC: the separator renders above the newer one, titled with ITS day', () => {
    const data = [m('m2', day(2026, 8, 1)), m('m1', day(2026, 7, 31))];
    const result = insertDaySeparators(data, 'newest-first');
    assert.deepEqual(ids(result), ['m2', 'day-20260801', 'm1']);
    const separator = result[1] as { day: true; ts: number };
    assert.equal(dayKey(separator.ts), 20260801);
  });

  test('day boundary in ASC (thread): same logic, array reversed', () => {
    const data = [m('m1', day(2026, 7, 31)), m('m2', day(2026, 8, 1))];
    assert.deepEqual(ids(insertDaySeparators(data, 'oldest-first')), [
      'm1',
      'day-20260801',
      'm2',
    ]);
  });

  test('same day: no insertion, SAME reference, the useMemo does not re-render for nothing', () => {
    const data = [m('m2', day(2026, 8, 1, 15)), m('m1', day(2026, 8, 1, 9))];
    assert.equal(insertDaySeparators(data, 'newest-first'), data);
  });

  test("never a separator above the oldest loaded one: the next page may continue the same day", () => {
    const data = [m('m1', day(2026, 8, 1))];
    assert.equal(insertDaySeparators(data, 'newest-first'), data);
  });

  test('the "new messages" bar stays in place, the separator goes ABOVE it', () => {
    // DESC, rendered bottom-up: m1 (yesterday), then [separator, bar, m2]; in the
    // array, the bar thus precedes the separator.
    const data = [
      m('m2', day(2026, 8, 1)),
      { bar: true as const, id: 'unread-bar' },
      m('m1', day(2026, 7, 31)),
    ];
    assert.deepEqual(ids(insertDaySeparators(data, 'newest-first')), [
      'm2',
      'unread-bar',
      'day-20260801',
      'm1',
    ]);
  });

  test('three days: one separator per boundary, stable ids per day', () => {
    const data = [
      m('m3', day(2026, 8, 1)),
      m('m2', day(2026, 7, 31)),
      m('m1', day(2026, 7, 30)),
    ];
    assert.deepEqual(ids(insertDaySeparators(data, 'newest-first')), [
      'm3',
      'day-20260801',
      'm2',
      'day-20260731',
      'm1',
    ]);
  });
});
