import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { dayKey, insertDaySeparators } from './daySeparator.ts';

/** Horodatages à MIDI heure locale : aucun test ne dépend du fuseau du banc. */
const day = (year: number, month: number, dayOfMonth: number, time = 12) =>
  new Date(year, month - 1, dayOfMonth, time).getTime();

const m = (id: string, ts: number) => ({ id, ts });
const ids = (rows: { id: string }[]): string[] => rows.map((l) => l.id);

describe('insererSeparateursJour', () => {
  test('frontière de jour en DESC : le séparateur se rend au-dessus du plus récent, titré de SON jour', () => {
    const data = [m('m2', day(2026, 8, 1)), m('m1', day(2026, 7, 31))];
    const result = insertDaySeparators(data, 'newest-first');
    assert.deepEqual(ids(result), ['m2', 'jour-20260801', 'm1']);
    const separator = result[1] as { day: true; ts: number };
    assert.equal(dayKey(separator.ts), 20260801);
  });

  test('frontière de jour en ASC (fil) : même logique, tableau retourné', () => {
    const data = [m('m1', day(2026, 7, 31)), m('m2', day(2026, 8, 1))];
    assert.deepEqual(ids(insertDaySeparators(data, 'oldest-first')), [
      'm1',
      'jour-20260801',
      'm2',
    ]);
  });

  test('même jour : aucune insertion, MÊME référence — le useMemo ne re-rend pas pour rien', () => {
    const data = [m('m2', day(2026, 8, 1, 15)), m('m1', day(2026, 8, 1, 9))];
    assert.equal(insertDaySeparators(data, 'newest-first'), data);
  });

  test("jamais de séparateur au-dessus du plus ancien chargé : la page suivante peut continuer le même jour", () => {
    const data = [m('m1', day(2026, 8, 1))];
    assert.equal(insertDaySeparators(data, 'newest-first'), data);
  });

  test('la barre « nouveaux messages » reste en place, le séparateur se pose AU-DESSUS d’elle', () => {
    // DESC, rendu de bas en haut : m1 (hier), puis [séparateur, barre, m2] ;
    // dans le tableau, la barre précède donc le séparateur.
    const data = [
      m('m2', day(2026, 8, 1)),
      { bar: true as const, id: 'barre-nouveaux' },
      m('m1', day(2026, 7, 31)),
    ];
    assert.deepEqual(ids(insertDaySeparators(data, 'newest-first')), [
      'm2',
      'barre-nouveaux',
      'jour-20260801',
      'm1',
    ]);
  });

  test('trois jours : un séparateur par frontière, ids stables par jour', () => {
    const data = [
      m('m3', day(2026, 8, 1)),
      m('m2', day(2026, 7, 31)),
      m('m1', day(2026, 7, 30)),
    ];
    assert.deepEqual(ids(insertDaySeparators(data, 'newest-first')), [
      'm3',
      'jour-20260801',
      'm2',
      'jour-20260731',
      'm1',
    ]);
  });
});
