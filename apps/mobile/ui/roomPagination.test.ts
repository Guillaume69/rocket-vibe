import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { avancerBorne, borneImmobile, pageARecule, PAGES_MAX_SUR_BORNE } from './roomPagination.ts';

describe('avancerBorne / borneImmobile', () => {
  test('première demande : la borne naît à une page', () => {
    assert.deepEqual(avancerBorne(null, 'm1'), { id: 'm1', pages: 1 });
  });

  test('même borne : on compte ; borne neuve : on repart à 1', () => {
    const deux = avancerBorne({ id: 'm1', pages: 1 }, 'm1');
    assert.deepEqual(deux, { id: 'm1', pages: 2 });
    assert.deepEqual(avancerBorne(deux, 'm0'), { id: 'm0', pages: 1 });
  });

  test(`le filet tolère ${PAGES_MAX_SUR_BORNE} pages immobiles, la suivante déclare l'épuisement`, () => {
    let borne = avancerBorne(null, 'm1');
    assert.equal(borneImmobile(borne), false, 'première page : on demande');
    borne = avancerBorne(borne, 'm1');
    assert.equal(borneImmobile(borne), false, 'deuxième page sur la même borne : encore permis');
    borne = avancerBorne(borne, 'm1');
    assert.equal(borneImmobile(borne), true, 'troisième : la pagination n’avance plus, on coupe');
  });

  test('une borne qui progresse ne déclenche jamais le filet', () => {
    let borne = avancerBorne(null, 'm3');
    borne = avancerBorne(borne, 'm2');
    borne = avancerBorne(borne, 'm1');
    assert.equal(borneImmobile(borne), false);
  });
});

describe('pageARecule', () => {
  test('un message STRICTEMENT plus ancien que la borne : la page a reculé', () => {
    assert.equal(pageARecule(100, 200), true);
  });

  test('LE piège du 429 : une page pleine de jumeaux ex æquo n’a PAS reculé', () => {
    // `inclusive: true` renvoie la borne ET tous ses jumeaux de la même
    // milliseconde (rafale de bot, import). Compter `n > 1` concluait « il
    // reste du passé » pour toujours : `passeEpuise` jamais armé, la
    // ré-ingestion re-déclenchait `onEndReached` (FlashList v2 le réarme à
    // chaque changement de data), et la boucle tenait jusqu'au 429.
    assert.equal(pageARecule(200, 200), false);
  });

  test('page vide (null) : rien derrière, pas de recul', () => {
    assert.equal(pageARecule(null, 200), false);
  });

  test('page plus RÉCENTE que la borne (réponse aberrante) : pas un recul non plus', () => {
    assert.equal(pageARecule(300, 200), false);
  });
});
