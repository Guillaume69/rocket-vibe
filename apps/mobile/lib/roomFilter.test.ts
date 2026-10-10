import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { filterRooms } from './roomFilter.ts';

type R = { name: string; slug: string | null; at: number };
const at = (name: string, ts: number, slug: string | null = null): R => ({ name, slug, at: ts });
const names = (rooms: R[], q: string) => filterRooms(rooms, q, (r) => [r.name, r.slug], (r) => r.at).map((r) => r.name);

describe('filterRooms (the desktop switcher rule)', () => {
  const rooms = [at('dev-ops', 1), at('Équipe dev', 3), at('devoirs', 2), at('ad-hoc devs', 4), at('android', 9)];

  test('a name start, then a word start, then anywhere; latest activity first', () => {
    assert.deepEqual(names(rooms, 'DEV'), ['devoirs', 'dev-ops', 'ad-hoc devs', 'Équipe dev']);
    assert.deepEqual(names(rooms, 'evo'), ['devoirs']);
  });

  test('case and accents aside', () => {
    assert.deepEqual(names(rooms, 'equipe'), ['Équipe dev']);
    assert.deepEqual(names(rooms, 'ÉQUIPE'), ['Équipe dev']);
  });

  test('an empty query keeps everything, latest first', () => {
    assert.deepEqual(names(rooms, ' '), ['android', 'ad-hoc devs', 'Équipe dev', 'devoirs', 'dev-ops']);
  });

  test('the slug matches too', () => {
    assert.deepEqual(names([at('Bureau', 1, 'office')], 'off'), ['Bureau']);
  });
});
