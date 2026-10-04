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

describe('back to latest', () => {
  test('visible beyond one screen scrolled up, not below', () => {
    assert.equal(farFromLatest(0, HEIGHT), false);
    assert.equal(farFromLatest(HEIGHT, HEIGHT), false);
    assert.equal(farFromLatest(HEIGHT + 1, HEIGHT), true);
  });

  test('height not measured yet: never visible', () => {
    assert.equal(farFromLatest(5_000, 0), false);
  });

  test('scrolling lights up then turns off the button', () => {
    const far = onBackToLatestScroll(INITIAL_BACK_TO_LATEST_STATE, 1_500, HEIGHT);
    assert.deepEqual(far, { visible: true, backInProgress: false });
    assert.equal(onBackToLatestScroll(far, 1_600, HEIGHT), far);
    assert.deepEqual(onBackToLatestScroll(far, 100, HEIGHT), INITIAL_BACK_TO_LATEST_STATE);
  });

  test('after a press, the back animation does not light the button again', () => {
    let state = onBackToLatestPress();
    assert.equal(state.visible, false);
    state = onBackToLatestScroll(state, 1_200, HEIGHT);
    assert.deepEqual(state, { visible: false, backInProgress: true });
    state = onBackToLatestScroll(state, 300, HEIGHT);
    assert.deepEqual(state, INITIAL_BACK_TO_LATEST_STATE);
    assert.equal(onBackToLatestScroll(state, 1_200, HEIGHT).visible, true);
  });

  test('a drag during the return hands control back to scrolling', () => {
    const state = onBackToLatestSwipe(onBackToLatestPress());
    assert.deepEqual(state, INITIAL_BACK_TO_LATEST_STATE);
    assert.equal(onBackToLatestScroll(state, 1_200, HEIGHT).visible, true);
  });
});
