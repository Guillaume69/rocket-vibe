import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock, covers, minuteIn, minuteOf, mutedUntil, nextMorning, quietNow, validWindow } from './quiet.ts';

const base = { muted_until: null, quiet_hours: null };

test('a window within a day and one across midnight', () => {
  const night = { start_minute: 1320, end_minute: 480, time_zone: 'UTC' };
  assert.ok(covers(night, 1380) && covers(night, 0) && covers(night, 479));
  assert.ok(!covers(night, 480) && !covers(night, 720) && !covers(night, 1319));
  const day = { start_minute: 540, end_minute: 1020, time_zone: 'UTC' };
  assert.ok(covers(day, 540) && !covers(day, 1020) && !covers(day, 480));
});

test('the window is read in its own time zone', () => {
  // 21:30 UTC is 23:30 in Paris in summer, 22:30 in winter.
  const at = new Date('2026-07-01T21:30:00Z');
  assert.equal(minuteIn('UTC', at), 21 * 60 + 30);
  assert.equal(minuteIn('Europe/Paris', at), 23 * 60 + 30);
  assert.equal(minuteIn('Europe/Paris', new Date('2026-01-01T21:30:00Z')), 22 * 60 + 30);
  // Midnight is 0, never 24.
  assert.equal(minuteIn('UTC', new Date('2026-07-01T00:05:00Z')), 5);
  const paris = { start_minute: 1380, end_minute: 420, time_zone: 'Europe/Paris' };
  assert.ok(quietNow({ ...base, quiet_hours: paris }, at));
  assert.ok(!quietNow({ ...base, quiet_hours: { ...paris, time_zone: 'UTC' } }, at));
});

test('an unknown zone falls back to the device clock', () => {
  const at = new Date(2026, 6, 1, 23, 15);
  assert.equal(minuteIn('Not/AZone', at), 23 * 60 + 15);
});

test('a mute runs until its instant', () => {
  const at = new Date('2026-07-01T12:00:00Z');
  assert.ok(quietNow({ ...base, muted_until: '2026-07-01T13:00:00Z' }, at));
  assert.ok(!quietNow({ ...base, muted_until: '2026-07-01T11:00:00Z' }, at));
  assert.ok(!quietNow(undefined, at));
  assert.equal(mutedUntil({ muted_until: '2026-07-01T13:00:00Z' }, at)?.toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(mutedUntil({ muted_until: '2026-07-01T11:00:00Z' }, at), null);
  assert.equal(mutedUntil({ muted_until: 'garbage' }, at), null);
});

test('clock text both ways, the next morning and a valid window', () => {
  assert.equal(clock(1320), '22:00');
  assert.equal(clock(65), '01:05');
  assert.equal(minuteOf('07:30'), 450);
  assert.equal(minuteOf(' 7:30 '), 450);
  assert.equal(minuteOf('22h00'), 1320);
  assert.equal(minuteOf('24:00'), null);
  assert.equal(minuteOf('12:60'), null);
  assert.equal(minuteOf('noon'), null);
  const evening = new Date(2026, 6, 1, 23, 0);
  assert.equal(nextMorning(evening).getDate(), 2);
  const early = new Date(2026, 6, 1, 6, 0);
  assert.equal(nextMorning(early).getDate(), 1);
  assert.equal(nextMorning(new Date(2026, 6, 1, 8, 0)).getDate(), 2);
  assert.ok(validWindow(1320, 480) && validWindow(0, 1439));
  assert.ok(!validWindow(480, 480) && !validWindow(null, 480) && !validWindow(0, 1440));
});
