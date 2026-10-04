import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  INITIAL_BACK_TO_LATEST_STATE,
  farFromLatest,
  onBackToLatestPress,
  onBackToLatestScroll,
  onBackToLatestSwipe,
} from './backToLatest.ts';

const HEIGHT = 700;

describe('retour au plus récent', () => {
  test('visible au-delà d’un écran de remontée, pas en deçà', () => {
    assert.equal(farFromLatest(0, HEIGHT), false);
    assert.equal(farFromLatest(HEIGHT, HEIGHT), false);
    assert.equal(farFromLatest(HEIGHT + 1, HEIGHT), true);
  });

  test('hauteur pas encore mesurée : jamais visible', () => {
    assert.equal(farFromLatest(5_000, 0), false);
  });

  test('le défilement allume puis éteint le bouton', () => {
    const far = onBackToLatestScroll(INITIAL_BACK_TO_LATEST_STATE, 1_500, HEIGHT);
    assert.deepEqual(far, { visible: true, backInProgress: false });
    assert.equal(onBackToLatestScroll(far, 1_600, HEIGHT), far);
    assert.deepEqual(onBackToLatestScroll(far, 100, HEIGHT), INITIAL_BACK_TO_LATEST_STATE);
  });

  test('après un appui, l’animation de retour ne rallume pas le bouton', () => {
    let state = onBackToLatestPress();
    assert.equal(state.visible, false);
    state = onBackToLatestScroll(state, 1_200, HEIGHT);
    assert.deepEqual(state, { visible: false, backInProgress: true });
    state = onBackToLatestScroll(state, 300, HEIGHT);
    assert.deepEqual(state, INITIAL_BACK_TO_LATEST_STATE);
    assert.equal(onBackToLatestScroll(state, 1_200, HEIGHT).visible, true);
  });

  test('un glissé pendant le retour rend la main au défilement', () => {
    const state = onBackToLatestSwipe(onBackToLatestPress());
    assert.deepEqual(state, INITIAL_BACK_TO_LATEST_STATE);
    assert.equal(onBackToLatestScroll(state, 1_200, HEIGHT).visible, true);
  });
});
