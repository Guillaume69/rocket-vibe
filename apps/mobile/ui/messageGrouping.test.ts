import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { FENETRE_GROUPE_MS, idsHeuresRepetees, idsSuites } from './messageGrouping.ts';

/** Un message minimal, ordinaire par défaut (`typeSysteme: null`). */
const m = (id: string, horodatage: number, auteurId: string, typeSysteme: string | null = null) => ({
  id,
  horodatage,
  auteurId,
  typeSysteme,
});

describe('idsSuites', () => {
  test('même auteur sous la fenêtre : la ligne du dessous est une suite — dans les deux ordres', () => {
    // DESC (salon) : m2 est le plus récent, son précédent chronologique est
    // l'élément SUIVANT du tableau.
    const desc = [m('m2', 60_000, 'bob'), m('m1', 0, 'bob')];
    assert.deepEqual(idsSuites(desc, 'recent-en-tete'), new Set(['m2']));
    // ASC (fil) : même paire, tableau retourné — même conclusion.
    const asc = [m('m1', 0, 'bob'), m('m2', 60_000, 'bob')];
    assert.deepEqual(idsSuites(asc, 'ancien-en-tete'), new Set(['m2']));
  });

  test("un auteur différent rompt le groupe, puis le groupe reprend derrière", () => {
    // bob, alice, bob, bob : seule la DERNIÈRE paire bob-bob se groupe.
    const desc = [m('m4', 3000, 'bob'), m('m3', 2000, 'bob'), m('m2', 1000, 'alice'), m('m1', 0, 'bob')];
    assert.deepEqual(idsSuites(desc, 'recent-en-tete'), new Set(['m4']));
  });

  test('la fenêtre de temps : exactement 5 min groupe encore, une ms de plus non', () => {
    const juste = [m('m2', FENETRE_GROUPE_MS, 'bob'), m('m1', 0, 'bob')];
    assert.deepEqual(idsSuites(juste, 'recent-en-tete'), new Set(['m2']));
    const trop = [m('m2', FENETRE_GROUPE_MS + 1, 'bob'), m('m1', 0, 'bob')];
    assert.deepEqual(idsSuites(trop, 'recent-en-tete'), new Set());
  });

  test('la barre « nouveaux messages » rompt : le premier non-lu garde son en-tête', () => {
    const desc = [m('m2', 1000, 'bob'), { barre: true as const, id: 'barre-nouveaux' }, m('m1', 0, 'bob')];
    assert.deepEqual(idsSuites(desc, 'recent-en-tete'), new Set());
  });

  test('le séparateur de jour rompt : 23 h 58 puis 0 h 02 passent la fenêtre, pas la frontière', () => {
    // Deux messages à 4 min d'écart mais de part et d'autre de minuit : le
    // séparateur inséré entre eux (ui/daySeparator) casse le groupe.
    const desc = [
      m('m2', 242_000, 'bob'),
      { jour: true, id: 'jour-20260801', horodatage: 242_000 },
      m('m1', 2_000, 'bob'),
    ];
    assert.deepEqual(idsSuites(desc, 'recent-en-tete'), new Set());
  });

  test('un message système ne se groupe ni comme suite ni comme tête de groupe', () => {
    // bob écrit, « bob a rejoint » (uj), bob écrit : personne ne se groupe —
    // le système rompt des deux côtés.
    const desc = [m('m3', 2000, 'bob'), m('m2', 1000, 'bob', 'uj'), m('m1', 0, 'bob')];
    assert.deepEqual(idsSuites(desc, 'recent-en-tete'), new Set());
  });

  test("`e2e` se rend comme un message ordinaire : il se groupe normalement", () => {
    const desc = [m('m2', 1000, 'bob', 'e2e'), m('m1', 0, 'bob', 'e2e')];
    assert.deepEqual(idsSuites(desc, 'recent-en-tete'), new Set(['m2']));
  });

  test('les bords : liste vide, message seul — jamais de suite', () => {
    assert.deepEqual(idsSuites([], 'recent-en-tete'), new Set());
    assert.deepEqual(idsSuites([m('m1', 0, 'bob')], 'ancien-en-tete'), new Set());
  });
});

describe('idsHeuresRepetees', () => {
  /** Projette comme les écrans : les suites d'abord, puis les heures répétées. */
  const projeter = (
    lignes: Parameters<typeof idsSuites>[0],
    ordre: 'recent-en-tete' | 'ancien-en-tete',
  ) => idsHeuresRepetees(lignes, ordre, idsSuites(lignes, ordre));

  test("une suite dans la MÊME minute que le message d'au-dessus tait son heure — dans les deux ordres", () => {
    // 0 ms et 59 999 ms : même minute affichée, l'heure de m2 est redondante.
    const desc = [m('m2', 59_999, 'bob'), m('m1', 0, 'bob')];
    assert.deepEqual(projeter(desc, 'recent-en-tete'), new Set(['m2']));
    const asc = [m('m1', 0, 'bob'), m('m2', 59_999, 'bob')];
    assert.deepEqual(projeter(asc, 'ancien-en-tete'), new Set(['m2']));
  });

  test('une suite dans la minute SUIVANTE garde son heure, même à une seconde près', () => {
    // 59 999 ms puis 60 000 ms : 1 ms d'écart mais deux minutes affichées.
    const desc = [m('m2', 60_000, 'bob'), m('m1', 59_999, 'bob')];
    assert.deepEqual(projeter(desc, 'recent-en-tete'), new Set());
  });

  test("une chaîne : chaque rupture de minute réaffiche l'heure, les répétitions se taisent", () => {
    // 11:03, 11:03, 11:04, 11:04 (en minutes epoch 3, 3, 4, 4) : la tête porte
    // son heure d'en-tête, m2 se tait (même minute), m3 réaffiche (nouvelle
    // minute), m4 se tait (même minute que m3, dont l'heure est rendue).
    const desc = [
      m('m4', 4 * 60_000 + 30_000, 'bob'),
      m('m3', 4 * 60_000, 'bob'),
      m('m2', 3 * 60_000 + 40_000, 'bob'),
      m('m1', 3 * 60_000, 'bob'),
    ];
    assert.deepEqual(projeter(desc, 'recent-en-tete'), new Set(['m2', 'm4']));
  });

  test("une NON-suite n'est jamais concernée : l'en-tête réaffiché porte déjà l'heure", () => {
    // Même minute mais auteurs différents : m2 n'est pas une suite, son
    // en-tête (pseudo + heure) se rend entier — rien à taire.
    const desc = [m('m2', 30_000, 'alice'), m('m1', 0, 'bob')];
    assert.deepEqual(projeter(desc, 'recent-en-tete'), new Set());
  });
});
