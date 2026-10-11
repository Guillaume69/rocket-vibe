import test from 'node:test';
import assert from 'node:assert/strict';
import { requestGifSelection, finishGifSelection } from './gifSelection.ts';
test('cancel preserves a draft; successful selection resolves only once', async () => {
  const cancelled = requestGifSelection();
  finishGifSelection(cancelled.id, false);
  assert.equal(await cancelled.result, false);
  const sent = requestGifSelection();
  finishGifSelection(sent.id, true);
  finishGifSelection(sent.id, false);
  assert.equal(await sent.result, true);
});
