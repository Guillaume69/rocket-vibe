import assert from 'node:assert/strict';
import { test } from 'node:test';

import { answerCardMenu, pendingCardMenu, requestCardMenu } from './cardMenuStore.ts';

const menu = { source: 'options' as const, options: [{ label: 'A', value: 'a' }], initial: null };

test('the sheet answers the menu it showed, once; a newer menu closes the older one', async () => {
  const first = requestCardMenu({ rid: 'r1', title: 'One', menu });
  const shown = pendingCardMenu()!;
  const second = requestCardMenu({ rid: 'r1', title: 'Two', menu });
  assert.equal(await first, null);
  answerCardMenu(shown, { label: 'A', value: 'a' });
  const current = pendingCardMenu()!;
  assert.equal(current.title, 'Two');
  answerCardMenu(current, { label: 'A', value: 'a' });
  answerCardMenu(current, null);
  assert.deepEqual(await second, { label: 'A', value: 'a' });
  assert.equal(pendingCardMenu(), null);
});
