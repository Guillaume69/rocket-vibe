import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createOpenRoomsStack } from './openRooms.ts';

describe('openRooms', () => {
  test('with no room screen mounted, there is nothing to catch up', () => {
    assert.equal(createOpenRoomsStack().top(), undefined);
  });

  test('a single screen: that one', () => {
    const stack = createOpenRoomsStack();
    stack.declare('r1');
    assert.equal(stack.top(), 'r1');
  });

  test('TWO stacked screens: the catch-up targets the top one', () => {
    const stack = createOpenRoomsStack();
    stack.declare('r1');
    stack.declare('r2');
    assert.equal(stack.top(), 'r2');
  });

  test('on going back, the room BELOW becomes the target again', () => {
    // The fixed defect: the top screen's cleanup set `null` while a room was
    // still shown, and no connection setup caught up anything anymore, for the
    // whole lifetime of the remaining screen.
    const stack = createOpenRoomsStack();
    stack.declare('r1');
    const renderR2 = stack.declare('r2');

    renderR2();

    assert.equal(stack.top(), 'r1');
  });

  test('two screens on the SAME room: popping one leaves the other', () => {
    // A deep link can reopen an already open room. Removing "the first
    // occurrence of r1" would work here by accident; removing the exact
    // declaration always works.
    const stack = createOpenRoomsStack();
    const renderFirst = stack.declare('r1');
    stack.declare('r1');

    renderFirst();

    assert.equal(stack.top(), 'r1', 'one remains');
  });

  test('unmounts OUT OF ORDER: the top stays right', () => {
    // React does not guarantee cleanup order between screens of one transition
    // (`replace` unmounts the old one and mounts the new one).
    const stack = createOpenRoomsStack();
    const renderR1 = stack.declare('r1');
    stack.declare('r2');

    renderR1(); // the one BELOW is leaving

    assert.equal(stack.top(), 'r2');
  });

  test("releasing the same declaration twice does not remove another one's", () => {
    const stack = createOpenRoomsStack();
    const renderR1 = stack.declare('r1');
    stack.declare('r2');

    renderR1();
    renderR1();

    assert.equal(stack.top(), 'r2');
  });

  test('each session has ITS own stack', () => {
    const a = createOpenRoomsStack();
    const b = createOpenRoomsStack();
    a.declare('r1');
    assert.equal(b.top(), undefined);
  });
});
