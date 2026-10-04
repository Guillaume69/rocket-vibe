import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  INITIAL_BACK_TO_LATEST_STATE,
  farFromLatest,
  onBackToLatestPress,
  onBackToLatestScroll,
  onBackToLatestSwipe,
} from './backToLatest.ts';

const HAUTEUR = 700;

describe('retour au plus récent', () => {
  test('visible au-delà d’un écran de remontée, pas en deçà', () => {
    assert.equal(farFromLatest(0, HAUTEUR), false);
    assert.equal(farFromLatest(HAUTEUR, HAUTEUR), false);
    assert.equal(farFromLatest(HAUTEUR + 1, HAUTEUR), true);
  });

  test('hauteur pas encore mesurée : jamais visible', () => {
    assert.equal(farFromLatest(5_000, 0), false);
  });

  test('le défilement allume puis éteint le bouton', () => {
    const loin = onBackToLatestScroll(INITIAL_BACK_TO_LATEST_STATE, 1_500, HAUTEUR);
    assert.deepEqual(loin, { visible: true, backInProgress: false });
    assert.equal(onBackToLatestScroll(loin, 1_600, HAUTEUR), loin);
    assert.deepEqual(onBackToLatestScroll(loin, 100, HAUTEUR), INITIAL_BACK_TO_LATEST_STATE);
  });

  test('après un appui, l’animation de retour ne rallume pas le bouton', () => {
    let etat = onBackToLatestPress();
    assert.equal(etat.visible, false);
    etat = onBackToLatestScroll(etat, 1_200, HAUTEUR);
    assert.deepEqual(etat, { visible: false, backInProgress: true });
    etat = onBackToLatestScroll(etat, 300, HAUTEUR);
    assert.deepEqual(etat, INITIAL_BACK_TO_LATEST_STATE);
    assert.equal(onBackToLatestScroll(etat, 1_200, HAUTEUR).visible, true);
  });

  test('un glissé pendant le retour rend la main au défilement', () => {
    const etat = onBackToLatestSwipe(onBackToLatestPress());
    assert.deepEqual(etat, INITIAL_BACK_TO_LATEST_STATE);
    assert.equal(onBackToLatestScroll(etat, 1_200, HAUTEUR).visible, true);
  });
});
