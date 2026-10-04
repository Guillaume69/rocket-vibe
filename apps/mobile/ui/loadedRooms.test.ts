import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { sessionToken } from './sessionToken.ts';
import {
  markRoomLoaded,
  forgetLoadedRooms,
  roomLoadedUnder,
} from './loadedRooms.ts';

describe('loadedRooms', () => {
  beforeEach(() => forgetLoadedRooms());

  test('a never-opened room is not loaded', () => {
    assert.equal(roomLoadedUnder('r1', 3), false);
  });

  test('leaving and entering under the SAME generation: nothing to reload', () => {
    // The user's case: leave the room, come straight back.
    markRoomLoaded('r1', 3, sessionToken());
    assert.equal(roomLoadedUnder('r1', 3), true);
  });

  test('after a connection setup, the guard drops: the gap can be of any size', () => {
    markRoomLoaded('r1', 3, sessionToken());
    assert.equal(roomLoadedUnder('r1', 4), false);
  });

  test('an EARLIER generation does not count either (generations are not monotonic)', () => {
    markRoomLoaded('r1', 4, sessionToken());
    assert.equal(roomLoadedUnder('r1', 3), false);
  });

  test('rooms are independent', () => {
    markRoomLoaded('r1', 3, sessionToken());
    assert.equal(roomLoadedUnder('r2', 3), false);
  });

  test('end of session: the whole cache is forgotten', () => {
    markRoomLoaded('r1', 3, sessionToken());
    markRoomLoaded('r2', 3, sessionToken());
    forgetLoadedRooms();
    assert.equal(roomLoadedUnder('r1', 3), false);
    assert.equal(roomLoadedUnder('r2', 3), false);
  });

  test('a history load that COMPLETES after the session ends repopulates nothing', () => {
    // The fetch started under the previous session: its mark would belong to a
    // server we left, and would skip the opening history in the next session as
    // soon as its counter reaches this generation.
    const token = sessionToken();
    forgetLoadedRooms();
    markRoomLoaded('r1', 3, token);
    assert.equal(roomLoadedUnder('r1', 3), false);
  });
});
