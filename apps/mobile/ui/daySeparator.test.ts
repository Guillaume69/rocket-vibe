import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { dayKey, insertDaySeparators } from './daySeparator.ts';

/** Horodatages à MIDI heure locale : aucun test ne dépend du fuseau du banc. */
const jour = (annee: number, mois: number, quantieme: number, heure = 12) =>
  new Date(annee, mois - 1, quantieme, heure).getTime();

const m = (id: string, horodatage: number) => ({ id, ts: horodatage });
const ids = (lignes: { id: string }[]): string[] => lignes.map((l) => l.id);

describe('insererSeparateursJour', () => {
  test('frontière de jour en DESC : le séparateur se rend au-dessus du plus récent, titré de SON jour', () => {
    const donnees = [m('m2', jour(2026, 8, 1)), m('m1', jour(2026, 7, 31))];
    const resultat = insertDaySeparators(donnees, 'newest-first');
    assert.deepEqual(ids(resultat), ['m2', 'jour-20260801', 'm1']);
    const separateur = resultat[1] as { day: true; ts: number };
    assert.equal(dayKey(separateur.ts), 20260801);
  });

  test('frontière de jour en ASC (fil) : même logique, tableau retourné', () => {
    const donnees = [m('m1', jour(2026, 7, 31)), m('m2', jour(2026, 8, 1))];
    assert.deepEqual(ids(insertDaySeparators(donnees, 'oldest-first')), [
      'm1',
      'jour-20260801',
      'm2',
    ]);
  });

  test('même jour : aucune insertion, MÊME référence — le useMemo ne re-rend pas pour rien', () => {
    const donnees = [m('m2', jour(2026, 8, 1, 15)), m('m1', jour(2026, 8, 1, 9))];
    assert.equal(insertDaySeparators(donnees, 'newest-first'), donnees);
  });

  test("jamais de séparateur au-dessus du plus ancien chargé : la page suivante peut continuer le même jour", () => {
    const donnees = [m('m1', jour(2026, 8, 1))];
    assert.equal(insertDaySeparators(donnees, 'newest-first'), donnees);
  });

  test('la barre « nouveaux messages » reste en place, le séparateur se pose AU-DESSUS d’elle', () => {
    // DESC, rendu de bas en haut : m1 (hier), puis [séparateur, barre, m2] ;
    // dans le tableau, la barre précède donc le séparateur.
    const donnees = [
      m('m2', jour(2026, 8, 1)),
      { bar: true as const, id: 'barre-nouveaux' },
      m('m1', jour(2026, 7, 31)),
    ];
    assert.deepEqual(ids(insertDaySeparators(donnees, 'newest-first')), [
      'm2',
      'barre-nouveaux',
      'jour-20260801',
      'm1',
    ]);
  });

  test('trois jours : un séparateur par frontière, ids stables par jour', () => {
    const donnees = [
      m('m3', jour(2026, 8, 1)),
      m('m2', jour(2026, 7, 31)),
      m('m1', jour(2026, 7, 30)),
    ];
    assert.deepEqual(ids(insertDaySeparators(donnees, 'newest-first')), [
      'm3',
      'jour-20260801',
      'm2',
      'jour-20260731',
      'm1',
    ]);
  });
});
