import { test } from 'node:test';
import assert from 'node:assert/strict';

import { afterSystemPicker, sheetOverRoom, systemPickerOpen, withSystemPicker } from './roomCover.ts';

test('only a sheet on top of the stack covers the room', () => {
  const room = { name: 'room/[rid]' };
  assert.equal(sheetOverRoom({ index: 1, routes: [room, { name: 'message-actions' }] }), true);
  assert.equal(sheetOverRoom({ index: 1, routes: [room, { name: 'attach' }] }), true);
  assert.equal(sheetOverRoom({ index: 1, routes: [room, { name: 'thread/[id]' }] }), false);
  assert.equal(sheetOverRoom({ index: 0, routes: [room, { name: 'attach' }] }), false);
  assert.equal(sheetOverRoom({ routes: [room, { name: 'room-info' }] }), true);
  assert.equal(sheetOverRoom(undefined), false);
  assert.equal(sheetOverRoom({ routes: [] }), false);
});

test('a system picker counts as open until it settles, failure included', async () => {
  assert.equal(systemPickerOpen(), false);
  let during = false;
  await withSystemPicker(async () => {
    during = systemPickerOpen();
  });
  assert.equal(during, true);
  assert.equal(systemPickerOpen(), false);
  await assert.rejects(withSystemPicker(async () => Promise.reject(Error('cancelled'))));
  assert.equal(systemPickerOpen(), false);
});

test('what waits for the system picker runs once it settles, at once without one', async () => {
  const ran: string[] = [];
  afterSystemPicker(() => ran.push('now'));
  assert.deepEqual(ran, ['now']);
  await withSystemPicker(async () => {
    afterSystemPicker(() => ran.push('after'));
    assert.deepEqual(ran, ['now']);
  });
  assert.deepEqual(ran, ['now', 'after']);
});
