import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  basculerSection,
  type CleSection,
  construireSections,
  ecrireSectionsRepliees,
  lireSectionsRepliees,
  replierSections,
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
  extra: Partial<{ nonLus: number; alerte: boolean; ouvert: boolean; favori: boolean }> = {},
) => ({ rid, nonLus: 0, alerte: false, ouvert: true, favori: false, ...extra });

/** Projection compacte pour les assertions : `titre: rid1, rid2`. */
const resume = (sections: { titre: string; data: { salon: { rid: string } }[] }[]): string[] =>
  sections.map((s) => `${s.titre}: ${s.data.map((e) => e.salon.rid).join(', ')}`);

describe('construireSections', () => {
  test('les favoris ont leur section après les non-lus, tous types confondus', () => {
    // f1 (canal) et f2 (DM) sont en favori ; f3 aussi mais a des non-lus : il
    // reste dans « Non lus », comme tout salon qui a un message.
    const sections = construireSections(
      [salon('f1', 'c'), salon('c1', 'c'), salon('f2', 'd'), salon('f3', 'p')],
      [
        abonnement('f1', { favori: true }),
        abonnement('c1'),
        abonnement('f2', { favori: true }),
        abonnement('f3', { favori: true, nonLus: 1 }),
      ],
      TITRES,
    );
    assert.deepEqual(resume(sections), ['Non lus: f3', 'Favoris: f1, f2', 'Salons: c1']);
  });

  test('répartition Salons / Messages privés, ordre de récence préservé, sections vides retirées', () => {
    const sections = construireSections(
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
    const sections = construireSections(
      [salon('c1', 'c'), salon('d1', 'd'), salon('c2', 'c')],
      [abonnement('c1'), abonnement('d1', { nonLus: 3 }), abonnement('c2', { alerte: true })],
      TITRES,
    );
    assert.deepEqual(resume(sections), ['Non lus: d1, c2', 'Salons: c1']);
  });

  test('`ouvert === false` masque le salon ; PAS d’abonnement → visible quand même', () => {
    // Pas encore d'abonnement reçu (course d'ingestion) : afficher plutôt que
    // de faire clignoter la liste. L'entrée porte alors `abonnement: null`.
    const sections = construireSections(
      [salon('c1', 'c'), salon('c2', 'c'), salon('c3', 'c')],
      [abonnement('c1', { ouvert: false }), abonnement('c2')],
      TITRES,
    );
    assert.deepEqual(resume(sections), ['Salons: c2, c3']);
    const entrees = sections[0].data;
    assert.notEqual(entrees[0].abonnement, null);
    assert.equal(entrees[1].abonnement, null);
  });

  test('un salon masqué mais NON LU reste masqué — le masquage prime', () => {
    const sections = construireSections(
      [salon('c1', 'c'), salon('c2', 'c')],
      [abonnement('c1', { ouvert: false, nonLus: 5 }), abonnement('c2')],
      TITRES,
    );
    assert.deepEqual(resume(sections), ['Salons: c2']);
  });

  test('tout lu → pas de section « Non lus » ; aucun DM → pas de « Messages privés »', () => {
    const sections = construireSections([salon('c1', 'c')], [abonnement('c1')], TITRES);
    assert.deepEqual(resume(sections), ['Salons: c1']);
  });

  test('requêtes vives pas encore résolues (undefined) : liste vide, pas de crash', () => {
    assert.deepEqual(construireSections(undefined, undefined, TITRES), []);
  });
});

describe('sections repliées', () => {
  const sections = () =>
    construireSections(
      [salon('c1', 'c'), salon('d1', 'd'), salon('c2', 'c')],
      [abonnement('c1'), abonnement('d1'), abonnement('c2')],
      TITRES,
    );

  test('une section repliée se vide mais garde son effectif', () => {
    const affichees = replierSections(sections(), new Set(['salons'] as const));
    assert.deepEqual(
      affichees.map((s) => [s.cle, s.repliee, s.total, s.data.length]),
      [
        ['salons', true, 2, 0],
        ['messagesPrives', false, 1, 1],
      ],
    );
  });

  test('une section SEULE ne se replie jamais : sans en-tête, rien ne la rouvrirait', () => {
    const seule = construireSections([salon('c1', 'c')], [abonnement('c1')], TITRES);
    const [affichee] = replierSections(seule, new Set(['salons'] as const));
    assert.equal(affichee.repliee, false);
    assert.equal(affichee.data.length, 1);
  });

  test('basculer replie puis déplie, sans muter l’ensemble reçu', () => {
    const vide = new Set<CleSection>();
    const repliee = basculerSection(vide, 'messagesPrives');
    assert.deepEqual([...repliee], ['messagesPrives']);
    assert.equal(vide.size, 0);
    assert.deepEqual([...basculerSection(repliee, 'messagesPrives')], []);
  });

  test('aller-retour par le stockage', () => {
    const repliees = new Set<CleSection>(['messagesPrives', 'nonLus']);
    const brut = ecrireSectionsRepliees(repliees);
    assert.equal(brut, '["nonLus","messagesPrives"]');
    assert.deepEqual(lireSectionsRepliees(brut), repliees);
  });

  test('stockage absent, corrompu ou inconnu : rien de replié', () => {
    assert.equal(lireSectionsRepliees(null).size, 0);
    assert.equal(lireSectionsRepliees('{pas du json').size, 0);
    assert.equal(lireSectionsRepliees('{"salons":true}').size, 0);
    assert.deepEqual([...lireSectionsRepliees('["salons","archives",3]')], ['salons']);
  });
});
