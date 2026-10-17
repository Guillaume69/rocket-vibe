import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { pressCardAction } from './integrationCards.ts';

function recorder() {
  const seen: string[] = [];
  return {
    seen,
    then: {
      note: (text: string) => seen.push(`note:${text}`),
      open: (url: string) => seen.push(`open:${url}`),
      failed: () => seen.push('failed'),
    },
  };
}

describe('pressCardAction', () => {
  test('a refused or unreachable press says the action failed, nothing else', async () => {
    const r = recorder();
    await pressCardAction(() => Promise.reject(new Error('400')), r.then);
    assert.deepEqual(r.seen, ['failed']);
  });

  test('the answer becomes a note and opens only an http(s) link', async () => {
    const r = recorder();
    await pressCardAction(async () => ({ ephemeralText: 'Done', gotoLocation: 'https://example.com/x' }), r.then);
    await pressCardAction(async () => ({ ephemeralText: null, gotoLocation: 'javascript:alert(1)' }), r.then);
    await pressCardAction(async () => ({ ephemeralText: null, gotoLocation: null }), r.then);
    assert.deepEqual(r.seen, ['note:Done', 'open:https://example.com/x']);
  });
});
