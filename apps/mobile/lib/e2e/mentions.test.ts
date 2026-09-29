import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mentionsE2E } from './mentions.ts';

test('utilisateurs et salons, en tête ou après un blanc, sans doublon', () => {
  assert.deepEqual(mentionsE2E('@bob salut, tu as vu #general ? @bob @here'), {
    e2eUserMentions: ['@bob', '@here'],
    e2eChannelMentions: ['#general'],
  });
});

test('ni adresse e-mail ni ponctuation finale', () => {
  assert.deepEqual(mentionsE2E('écris à alice@exemple.fr, merci @carol.'), {
    e2eUserMentions: ['@carol'],
    e2eChannelMentions: [],
  });
});

test('pseudo fédéré', () => {
  assert.deepEqual(mentionsE2E('@dave@autre.serveur'), {
    e2eUserMentions: ['@dave@autre.serveur'],
    e2eChannelMentions: [],
  });
});
