import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { sessionToken } from './sessionToken.ts';
import { keepWarm, releaseHotRooms, roomCovered } from './hotRooms.ts';

/** A set of releasers that records whether it was called. */
function fixture() {
  const calls: number[] = [];
  return {
    calls,
    releases: [() => calls.push(1), () => calls.push(2)],
    release: () => calls.length > 0,
  };
}

describe('hotRooms', () => {
  beforeEach(() => releaseHotRooms());

  test('a never-visited room is not covered', () => {
    assert.equal(roomCovered('r1', 3), false);
  });

  test('leaving then entering under the SAME generation: covered, so nothing to catch up', () => {
    keepWarm('r1', 3, fixture().releases, sessionToken());
    assert.equal(roomCovered('r1', 3), true);
  });

  test('after a disconnection, coverage drops: the gap can be of any size', () => {
    keepWarm('r1', 3, fixture().releases, sessionToken());
    assert.equal(roomCovered('r1', 4), false);
  });

  test('two round trips: the first set of references is RELEASED, not accumulated', () => {
    // Otherwise each round trip would leave one more reference on the stream and
    // the room would never really close.
    const first = fixture();
    const second = fixture();
    keepWarm('r1', 3, first.releases, sessionToken());
    keepWarm('r1', 3, second.releases, sessionToken());

    assert.deepEqual(first.calls, [1, 2], 'the first set must be released');
    assert.deepEqual(second.calls, [], 'the current set stays held');
    assert.equal(roomCovered('r1', 3), true);
  });

  test('beyond 3 rooms, the least recently left one is released', () => {
    const a = fixture();
    keepWarm('a', 1, a.releases, sessionToken());
    keepWarm('b', 1, fixture().releases, sessionToken());
    keepWarm('c', 1, fixture().releases, sessionToken());
    assert.equal(a.release(), false, 'three rooms fit without eviction');

    keepWarm('d', 1, fixture().releases, sessionToken());

    assert.deepEqual(a.calls, [1, 2], 'the oldest is released');
    assert.equal(roomCovered('a', 1), false, 'and becomes a room to catch up again');
    assert.equal(roomCovered('b', 1), true);
    assert.equal(roomCovered('d', 1), true);
  });

  test('revisiting a room refreshes it in the LRU', () => {
    const a = fixture();
    keepWarm('a', 1, a.releases, sessionToken());
    keepWarm('b', 1, fixture().releases, sessionToken());
    keepWarm('c', 1, fixture().releases, sessionToken());
    // 'a' is revisited: it must no longer be the next evicted.
    const aAgain = fixture();
    keepWarm('a', 1, aAgain.releases, sessionToken());
    keepWarm('d', 1, fixture().releases, sessionToken());

    assert.equal(roomCovered('a', 1), true, '`a` was refreshed');
    assert.equal(roomCovered('b', 1), false, '`b` is the one evicted');
  });

  test('end of session: everything is released', () => {
    const a = fixture();
    const b = fixture();
    keepWarm('a', 1, a.releases, sessionToken());
    keepWarm('b', 1, b.releases, sessionToken());

    releaseHotRooms();

    assert.deepEqual(a.calls, [1, 2]);
    assert.deepEqual(b.calls, [1, 2]);
    assert.equal(roomCovered('a', 1), false);
  });

  describe('the GHOST entry of an ended session', () => {
    test('a screen unmounting AFTER the purge does not repopulate the table', () => {
      // The real order: the provider's cleanup runs BEFORE that of the screens it
      // carried. `<Room>` therefore calls `keepWarm` with releasers whose DDP
      // client has already been `reset()`.
      const token = sessionToken(); // captured at screen mount
      const late = fixture();

      releaseHotRooms(); // the provider goes away

      keepWarm('r1', 7, late.releases, token); // then the screen

      assert.deepEqual(late.calls, [1, 2], 'released on the spot, not remembered');
      assert.equal(roomCovered('r1', 7), false, 'no ghost entry');
    });

    test('without the token, the NEXT session would believe the room covered', () => {
      // This is the exact damage, and it is deferred: the generation counter
      // restarts at 0 in the next session. As soon as it passes the stored value
      // again, the guard answers "nothing to catch up" for a room this socket never
      // listened to: missed edits and deletions are then never fetched.
      const token = sessionToken();
      releaseHotRooms();
      keepWarm('r1', 2, fixture().releases, token);

      // Next session: its counter rises, and reaches 2.
      assert.equal(roomCovered('r1', 2), false);
    });

    test('the FRESH token is accepted: the guard does not block everything', () => {
      releaseHotRooms();
      const alive = fixture();
      keepWarm('r1', 1, alive.releases, sessionToken());

      assert.deepEqual(alive.calls, [], 'the references stay held');
      assert.equal(roomCovered('r1', 1), true);
    });
  });
});
