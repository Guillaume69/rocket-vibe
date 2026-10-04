import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import {
  requestSource,
  isSheetMounted,
  answerSource,
  reportSheetUnmounted,
  reportSheetMounted,
} from './attachmentSource.ts';

/** The channel is a stateful module: each test starts with no sheet. */
beforeEach(() => {
  answerSource(null);
  if (isSheetMounted()) reportSheetUnmounted();
});

describe('attachmentSource', () => {
  test('the sheet answers ON TAP, without closing: that is the whole point', async () => {
    const wait = requestSource();
    reportSheetMounted();

    answerSource('library'); // the tap

    assert.equal(await wait, 'library');
    assert.equal(
      isSheetMounted(),
      true,
      'the sheet stays mounted: the picker launches on a still view tree',
    );
  });

  test('closed without a choice (swipe, hardware back): the request settles to null', async () => {
    const wait = requestSource();
    reportSheetMounted();

    reportSheetUnmounted();

    assert.equal(await wait, null);
    assert.equal(isSheetMounted(), false);
  });

  test('after unmount, the composer must NO LONGER close, or it pops the room', () => {
    requestSource();
    reportSheetMounted();
    assert.equal(isSheetMounted(), true);

    // The user swipes the sheet away while the picker opens.
    reportSheetUnmounted();

    assert.equal(isSheetMounted(), false, 'the `closeAttachSheet` guard must be false');
  });

  test('the unmount that FOLLOWS a choice rewrites nothing: answerSource is idempotent', async () => {
    const wait = requestSource();
    reportSheetMounted();

    answerSource('photo');
    reportSheetUnmounted(); // the composer's back(), once the picker returns

    assert.equal(await wait, 'photo', 'the choice survives the unmount');
  });

  test('a new request settles the previous, still pending one', async () => {
    const first = requestSource();
    const second = requestSource();

    answerSource('file');

    assert.equal(await first, null);
    assert.equal(await second, 'file');
  });

  test('answering with no request pending does not throw', () => {
    assert.doesNotThrow(() => answerSource('video'));
  });
});
