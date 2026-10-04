import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withEnglishRoomPath } from './roomLink.ts';

test('an old `salon/` room link opens the `room/` route', () => {
  assert.equal(withEnglishRoomPath('rocketvibe://salon/r1?host=chat.example'), 'rocketvibe://room/r1?host=chat.example');
  assert.equal(withEnglishRoomPath('/salon/r1'), '/room/r1');
  assert.equal(withEnglishRoomPath('salon/r1'), 'room/r1');
});

test('any other path passes through unchanged', () => {
  for (const path of ['rocketvibe://room/r1', '/thread/salon/x', 'rocketvibe://share/salon/x', '/', '']) {
    assert.equal(withEnglishRoomPath(path), path);
  }
});
