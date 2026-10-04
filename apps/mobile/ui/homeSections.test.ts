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

const TITRES = {
  nonLus: 'Non lus',
  favoris: 'Favoris',
  salons: 'Salons',
  messagesPrives: 'Messages privés',
};

/** Un salon minimal — l'ordre du tableau EST l'ordre de récence (requête triée). */
const salon = (rid: string, type: string) => ({ rid, type });

const abonnement = (
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
      [salon('f1', 'c'), salon('c1', 'c'), salon('f2', 'd'), salon('f3', 'p')],
      [
        abonnement('f1', { favorite: true }),
        abonnement('c1'),
        abonnement('f2', { favorite: true }),
        abonnement('f3', { favorite: true, unread: 1 }),
      ],
      TITRES,
    );
    assert.deepEqual(resume(sections), ['Non lus: f3', 'Favoris: f1, f2', 'Salons: c1']);
  });

  test('répartition Salons / Messages privés, ordre de récence préservé, sections vides retirées', () => {
    const sections = buildSections(
      [salon('c1', 'c'), salon('d1', 'd'), salon('p1', 'p'), salon('d2', 'd')],
      [abonnement('c1'), abonnement('d1'), abonnement('p1'), abonnement('d2')],
      TITRES,
    );
    assert.deepEqual(resume(sections), ['Salons: c1, p1', 'Messages privés: d1, d2']);
  });

  test('non-lus et mentions remontent en tête, TOUS TYPES CONFONDUS', () => {
    // d1 a des non-lus, c2 une alerte (une mention peut lever le drapeau sans
    // que le compteur bouge) : les deux vont dans « Non lus », le DM ne
    // descend PAS dans « Messages privés ».
    const sections = buildSections(
      [salon('c1', 'c'), salon('d1', 'd'), salon('c2', 'c')],
      [abonnement('c1'), abonnement('d1', { unread: 3 }), abonnement('c2', { alert: true })],
      TITRES,
    );
    assert.deepEqual(resume(sections), ['Non lus: d1, c2', 'Salons: c1']);
  });

  test('`ouvert === false` masque le salon ; PAS d’abonnement → visible quand même', () => {
    // Pas encore d'abonnement reçu (course d'ingestion) : afficher plutôt que
    // de faire clignoter la liste. L'entrée porte alors `abonnement: null`.
    const sections = buildSections(
      [salon('c1', 'c'), salon('c2', 'c'), salon('c3', 'c')],
      [abonnement('c1', { open: false }), abonnement('c2')],
      TITRES,
    );
    assert.deepEqual(resume(sections), ['Salons: c2, c3']);
    const entrees = sections[0].data;
    assert.notEqual(entrees[0].subscription, null);
    assert.equal(entrees[1].subscription, null);
  });

  test('un salon masqué mais NON LU reste masqué — le masquage prime', () => {
    const sections = buildSections(
      [salon('c1', 'c'), salon('c2', 'c')],
      [abonnement('c1', { open: false, unread: 5 }), abonnement('c2')],
      TITRES,
    );
    assert.deepEqual(resume(sections), ['Salons: c2']);
  });

  test('tout lu → pas de section « Non lus » ; aucun DM → pas de « Messages privés »', () => {
    const sections = buildSections([salon('c1', 'c')], [abonnement('c1')], TITRES);
    assert.deepEqual(resume(sections), ['Salons: c1']);
  });

  test('requêtes vives pas encore résolues (undefined) : liste vide, pas de crash', () => {
    assert.deepEqual(buildSections(undefined, undefined, TITRES), []);
  });
});

describe('sections repliées', () => {
  const sections = () =>
    buildSections(
      [salon('c1', 'c'), salon('d1', 'd'), salon('c2', 'c')],
      [abonnement('c1'), abonnement('d1'), abonnement('c2')],
      TITRES,
    );

  test('une section repliée se vide mais garde son effectif', () => {
    const affichees = collapseSections(sections(), new Set(['salons'] as const));
    assert.deepEqual(
      affichees.map((s) => [s.key, s.collapsed, s.total, s.data.length]),
      [
        ['salons', true, 2, 0],
        ['messagesPrives', false, 1, 1],
      ],
    );
  });

  test('une section SEULE ne se replie jamais : sans en-tête, rien ne la rouvrirait', () => {
    const seule = buildSections([salon('c1', 'c')], [abonnement('c1')], TITRES);
    const [affichee] = collapseSections(seule, new Set(['salons'] as const));
    assert.equal(affichee.collapsed, false);
    assert.equal(affichee.data.length, 1);
  });

  test('basculer replie puis déplie, sans muter l’ensemble reçu', () => {
    const vide = new Set<SectionKey>();
    const repliee = toggleSection(vide, 'messagesPrives');
    assert.deepEqual([...repliee], ['messagesPrives']);
    assert.equal(vide.size, 0);
    assert.deepEqual([...toggleSection(repliee, 'messagesPrives')], []);
  });

  test('aller-retour par le stockage', () => {
    const repliees = new Set<SectionKey>(['messagesPrives', 'nonLus']);
    const brut = writeCollapsedSections(repliees);
    assert.equal(brut, '["nonLus","messagesPrives"]');
    assert.deepEqual(readCollapsedSections(brut), repliees);
  });

  test('stockage absent, corrompu ou inconnu : rien de replié', () => {
    assert.equal(readCollapsedSections(null).size, 0);
    assert.equal(readCollapsedSections('{pas du json').size, 0);
    assert.equal(readCollapsedSections('{"salons":true}').size, 0);
    assert.deepEqual([...readCollapsedSections('["salons","archives",3]')], ['salons']);
  });
});
