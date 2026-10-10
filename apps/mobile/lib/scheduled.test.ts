import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atMinute, inOneHour, pickableDays, schedulable, tomorrowMorning } from './scheduled.ts';

test('the offered times follow the device clock', () => {
  const now = new Date(2026, 9, 11, 23, 30, 42);
  assert.deepEqual(inOneHour(now), new Date(2026, 9, 12, 0, 30, 0));
  assert.deepEqual(tomorrowMorning(now), new Date(2026, 9, 12, 8, 0, 0));
  // Just after midnight, "tomorrow" is still the next calendar day.
  assert.deepEqual(tomorrowMorning(new Date(2026, 9, 12, 0, 5)), new Date(2026, 9, 13, 8, 0, 0));
  // Across a month end.
  assert.deepEqual(tomorrowMorning(new Date(2026, 9, 31, 12, 0)), new Date(2026, 10, 1, 8, 0, 0));
  const days = pickableDays(now);
  assert.equal(days.length, 31);
  assert.deepEqual(days[0], new Date(2026, 9, 11));
  assert.deepEqual(days[30], new Date(2026, 10, 10));
  assert.deepEqual(atMinute(days[1], 14 * 60 + 5), new Date(2026, 9, 12, 14, 5));
});

test('a time is schedulable from one minute to 30 days ahead', () => {
  const now = new Date(2026, 9, 11, 12, 0, 0);
  assert.equal(schedulable(new Date(now.getTime() + 59_000), now), false);
  assert.equal(schedulable(new Date(now.getTime() + 60_000), now), true);
  assert.equal(schedulable(inOneHour(now), now), true);
  assert.equal(schedulable(new Date(now.getTime() + 30 * 86_400_000), now), true);
  assert.equal(schedulable(new Date(now.getTime() + 30 * 86_400_000 + 1), now), false);
  assert.equal(schedulable(new Date(NaN), now), false);
  // The last offered day, late in the evening, is beyond 30 days.
  assert.equal(schedulable(atMinute(pickableDays(now)[30], 23 * 60), now), false);
});
