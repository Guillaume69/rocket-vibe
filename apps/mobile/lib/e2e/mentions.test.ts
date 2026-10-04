import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mentionsE2E } from './mentions.ts';

test('users and rooms, at the start or after whitespace, without duplicates', () => {
  assert.deepEqual(mentionsE2E('@bob salut, tu as vu #general ? @bob @here'), {
    e2eUserMentions: ['@bob', '@here'],
    e2eChannelMentions: ['#general'],
  });
});

test('neither email address nor trailing punctuation', () => {
  assert.deepEqual(mentionsE2E('écris à alice@exemple.fr, merci @carol.'), {
    e2eUserMentions: ['@carol'],
    e2eChannelMentions: [],
  });
});

test('federated username', () => {
  assert.deepEqual(mentionsE2E('@dave@autre.serveur'), {
    e2eUserMentions: ['@dave@autre.serveur'],
    e2eChannelMentions: [],
  });
});
