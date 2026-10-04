import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  toggleSection,
  type SectionKey,
  buildSections,
  writeCollapsedSections,
  readCollapsedSections,
  collapseSections,
} from './homeSections.ts';

const TITLES = {
  nonLus: 'Non lus',
  favoris: 'Favoris',
  salons: 'Salons',
  messagesPrives: 'Messages privés',
};

/** Un salon minimal — l'ordre du tableau EST l'ordre de récence (requête triée). */
const room = (rid: string, type: string) => ({ rid, type });

const subscription = (
  rid: string,
  extra: Partial<{ unread: number; alert: boolean; open: boolean; favorite: boolean }> = {},
) => ({ rid, unread: 0, alert: false, open: true, favorite: false, ...extra });

/** Projection compacte pour les assertions : `titre: rid1, rid2`. */
const resume = (sections: { title: string; data: { room: { rid: string } }[] }[]): string[] =>
  sections.map((s) => `${s.title}: ${s.data.map((e) => e.room.rid).join(', ')}`);

describe('construireSections', () => {
  test('les favoris ont leur section après les non-lus, tous types confondus', () => {
    // f1 (canal) et f2 (DM) sont en favori ; f3 aussi mais a des non-lus : il
    // reste dans « Non lus », comme tout salon qui a un message.
    const sections = buildSections(
      [room('f1', 'c'), room('c1', 'c'), room('f2', 'd'), room('f3', 'p')],
      [
        subscription('f1', { favorite: true }),
        subscription('c1'),
        subscription('f2', { favorite: true }),
        subscription('f3', { favorite: true, unread: 1 }),
      ],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Non lus: f3', 'Favoris: f1, f2', 'Salons: c1']);
  });

  test('répartition Salons / Messages privés, ordre de récence préservé, sections vides retirées', () => {
    const sections = buildSections(
      [room('c1', 'c'), room('d1', 'd'), room('p1', 'p'), room('d2', 'd')],
      [subscription('c1'), subscription('d1'), subscription('p1'), subscription('d2')],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Salons: c1, p1', 'Messages privés: d1, d2']);
  });

  test('non-lus et mentions remontent en tête, TOUS TYPES CONFONDUS', () => {
    // d1 a des non-lus, c2 une alerte (une mention peut lever le drapeau sans
    // que le compteur bouge) : les deux vont dans « Non lus », le DM ne
    // descend PAS dans « Messages privés ».
    const sections = buildSections(
      [room('c1', 'c'), room('d1', 'd'), room('c2', 'c')],
      [subscription('c1'), subscription('d1', { unread: 3 }), subscription('c2', { alert: true })],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Non lus: d1, c2', 'Salons: c1']);
  });

  test('`ouvert === false` masque le salon ; PAS d’abonnement → visible quand même', () => {
    // Pas encore d'abonnement reçu (course d'ingestion) : afficher plutôt que
    // de faire clignoter la liste. L'entrée porte alors `abonnement: null`.
    const sections = buildSections(
      [room('c1', 'c'), room('c2', 'c'), room('c3', 'c')],
      [subscription('c1', { open: false }), subscription('c2')],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Salons: c2, c3']);
    const entries = sections[0].data;
    assert.notEqual(entries[0].subscription, null);
    assert.equal(entries[1].subscription, null);
  });

  test('un salon masqué mais NON LU reste masqué — le masquage prime', () => {
    const sections = buildSections(
      [room('c1', 'c'), room('c2', 'c')],
      [subscription('c1', { open: false, unread: 5 }), subscription('c2')],
      TITLES,
    );
    assert.deepEqual(resume(sections), ['Salons: c2']);
  });

  test('tout lu → pas de section « Non lus » ; aucun DM → pas de « Messages privés »', () => {
    const sections = buildSections([room('c1', 'c')], [subscription('c1')], TITLES);
    assert.deepEqual(resume(sections), ['Salons: c1']);
  });

  test('requêtes vives pas encore résolues (undefined) : liste vide, pas de crash', () => {
    assert.deepEqual(buildSections(undefined, undefined, TITLES), []);
  });
});

describe('sections repliées', () => {
  const sections = () =>
    buildSections(
      [room('c1', 'c'), room('d1', 'd'), room('c2', 'c')],
      [subscription('c1'), subscription('d1'), subscription('c2')],
      TITLES,
    );

  test('une section repliée se vide mais garde son effectif', () => {
    const shown = collapseSections(sections(), new Set(['salons'] as const));
    assert.deepEqual(
      shown.map((s) => [s.key, s.collapsed, s.total, s.data.length]),
      [
        ['salons', true, 2, 0],
        ['messagesPrives', false, 1, 1],
      ],
    );
  });

  test('une section SEULE ne se replie jamais : sans en-tête, rien ne la rouvrirait', () => {
    const single = buildSections([room('c1', 'c')], [subscription('c1')], TITLES);
    const [shown] = collapseSections(single, new Set(['salons'] as const));
    assert.equal(shown.collapsed, false);
    assert.equal(shown.data.length, 1);
  });

  test('basculer replie puis déplie, sans muter l’ensemble reçu', () => {
    const empty = new Set<SectionKey>();
    const collapsed = toggleSection(empty, 'messagesPrives');
    assert.deepEqual([...collapsed], ['messagesPrives']);
    assert.equal(empty.size, 0);
    assert.deepEqual([...toggleSection(collapsed, 'messagesPrives')], []);
  });

  test('aller-retour par le stockage', () => {
    const collapsed = new Set<SectionKey>(['messagesPrives', 'nonLus']);
    const raw = writeCollapsedSections(collapsed);
    assert.equal(raw, '["nonLus","messagesPrives"]');
    assert.deepEqual(readCollapsedSections(raw), collapsed);
  });

  test('stockage absent, corrompu ou inconnu : rien de replié', () => {
    assert.equal(readCollapsedSections(null).size, 0);
    assert.equal(readCollapsedSections('{pas du json').size, 0);
    assert.equal(readCollapsedSections('{"salons":true}').size, 0);
    assert.deepEqual([...readCollapsedSections('["salons","archives",3]')], ['salons']);
  });
});
