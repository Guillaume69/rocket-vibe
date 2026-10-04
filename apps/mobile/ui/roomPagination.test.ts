import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { advanceBound, boundIsStuck, pageMovedBack, MAX_PAGES_AT_BOUND } from './roomPagination.ts';

describe('avancerBorne / borneImmobile', () => {
  test('première demande : la borne naît à une page', () => {
    assert.deepEqual(advanceBound(null, 'm1'), { id: 'm1', pages: 1 });
  });

  test('même borne : on compte ; borne neuve : on repart à 1', () => {
    const two = advanceBound({ id: 'm1', pages: 1 }, 'm1');
    assert.deepEqual(two, { id: 'm1', pages: 2 });
    assert.deepEqual(advanceBound(two, 'm0'), { id: 'm0', pages: 1 });
  });

  test(`le filet tolère ${MAX_PAGES_AT_BOUND} pages immobiles, la suivante déclare l'épuisement`, () => {
    let bound = advanceBound(null, 'm1');
    assert.equal(boundIsStuck(bound), false, 'première page : on demande');
    bound = advanceBound(bound, 'm1');
    assert.equal(boundIsStuck(bound), false, 'deuxième page sur la même borne : encore permis');
    bound = advanceBound(bound, 'm1');
    assert.equal(boundIsStuck(bound), true, 'troisième : la pagination n’avance plus, on coupe');
  });

  test('une borne qui progresse ne déclenche jamais le filet', () => {
    let bound = advanceBound(null, 'm3');
    bound = advanceBound(bound, 'm2');
    bound = advanceBound(bound, 'm1');
    assert.equal(boundIsStuck(bound), false);
  });
});

describe('pageARecule', () => {
  test('un message STRICTEMENT plus ancien que la borne : la page a reculé', () => {
    assert.equal(pageMovedBack(100, 200), true);
  });

  test('LE piège du 429 : une page pleine de jumeaux ex æquo n’a PAS reculé', () => {
    // `inclusive: true` renvoie la borne ET tous ses jumeaux de la même
    // milliseconde (rafale de bot, import). Compter `n > 1` concluait « il
    // reste du passé » pour toujours : `passeEpuise` jamais armé, la
    // ré-ingestion re-déclenchait `onEndReached` (FlashList v2 le réarme à
    // chaque changement de data), et la boucle tenait jusqu'au 429.
    assert.equal(pageMovedBack(200, 200), false);
  });

  test('page vide (null) : rien derrière, pas de recul', () => {
    assert.equal(pageMovedBack(null, 200), false);
  });

  test('page plus RÉCENTE que la borne (réponse aberrante) : pas un recul non plus', () => {
    assert.equal(pageMovedBack(300, 200), false);
  });
});
