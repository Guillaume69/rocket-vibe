import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mentionsE2E } from './mentions.ts';

test('users and rooms, at the start or after whitespace, without duplicates', () => {
  assert.deepEqual(mentionsE2E('@bob hi, did you see #general? @bob @here'), {
    e2eUserMentions: ['@bob', '@here'],
    e2eChannelMentions: ['#general'],
  });
});

test('neither email address nor trailing punctuation', () => {
  assert.deepEqual(mentionsE2E('write to alice@example.org, thanks @carol.'), {
    e2eUserMentions: ['@carol'],
    e2eChannelMentions: [],
  });
});

test('federated username', () => {
  assert.deepEqual(mentionsE2E('@dave@other.server'), {
    e2eUserMentions: ['@dave@other.server'],
    e2eChannelMentions: [],
  });
});
