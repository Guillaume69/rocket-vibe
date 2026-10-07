import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { INITIAL_PILL_STATE, nextPillState, onPillPress, unreadSummary } from './newMessagesPill.ts';
import { UNREAD_BAR_ID } from './unreadBar.ts';

const msg = (id: string, authorId: string, ts: number) => ({ id, authorId, ts });

describe('new messages pill', () => {
  test('counts the messages from others newer than the bar', () => {
    const rows = [
      msg('c', 'me', 30),
      msg('b', 'bob', 20),
      { id: 'day-1' },
      msg('a', 'bob', 10),
      { id: UNREAD_BAR_ID },
      msg('z', 'bob', 5),
    ];
    assert.deepEqual(unreadSummary(rows, 'me'), { barIndex: 4, count: 2, oldestTs: 10 });
  });

  test('no bar, no summary', () => {
    assert.equal(unreadSummary([msg('a', 'bob', 1)], 'me'), null);
  });

  test('shows while the bar is above the last visible row', () => {
    const shown = nextPillState(INITIAL_PILL_STATE, 40, { startIndex: 0, endIndex: 12 });
    assert.deepEqual(shown, { seen: false, visible: true });
    assert.equal(nextPillState(shown, 40, { startIndex: 3, endIndex: 15 }), shown);
  });

  test('done once the bar has been on screen, even scrolled away again', () => {
    const shown = nextPillState(INITIAL_PILL_STATE, 40, { startIndex: 0, endIndex: 12 });
    const seen = nextPillState(shown, 40, { startIndex: 30, endIndex: 42 });
    assert.deepEqual(seen, { seen: true, visible: false });
    assert.equal(nextPillState(seen, 40, { startIndex: 0, endIndex: 12 }), seen);
  });

  test('a bar under the view counts as seen', () => {
    assert.deepEqual(nextPillState(INITIAL_PILL_STATE, 2, { startIndex: 10, endIndex: 20 }), {
      seen: true,
      visible: false,
    });
  });

  test('no measured range keeps the state', () => {
    assert.equal(nextPillState(INITIAL_PILL_STATE, 40, undefined), INITIAL_PILL_STATE);
    assert.equal(nextPillState(INITIAL_PILL_STATE, 40, { startIndex: -1, endIndex: -1 }), INITIAL_PILL_STATE);
  });

  test('the bar going away hides the pill', () => {
    const shown = nextPillState(INITIAL_PILL_STATE, 40, { startIndex: 0, endIndex: 12 });
    assert.deepEqual(nextPillState(shown, null, { startIndex: 0, endIndex: 12 }), INITIAL_PILL_STATE);
  });

  test('a press ends it', () => {
    assert.deepEqual(onPillPress(), { seen: true, visible: false });
  });
});
