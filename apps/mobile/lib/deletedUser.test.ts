import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isDeletedUsername } from './deletedUser.ts';

test('a tombstoned RocketVibe username, any case, and nothing else', () => {
  assert.equal(isDeletedUsername('deleted-0f3a9c'), true);
  assert.equal(isDeletedUsername('Deleted-0f3a9c'), true);
  assert.equal(isDeletedUsername('alice'), false);
  assert.equal(isDeletedUsername('undeleted-bob'), false);
  assert.equal(isDeletedUsername(null), false);
});
