import assert from 'node:assert/strict';
import { test } from 'node:test';

import { unicodeOfShortcode } from '../../lib/emojis.ts';
import { reactionCode, reactionName } from './reactions.ts';

test('skin-toned Mattermost reactions read as toned codes', () => {
  assert.equal(unicodeOfShortcode(reactionCode('-1_medium_light_skin_tone')), '👎🏼');
  assert.equal(unicodeOfShortcode(reactionCode('+1_dark_skin_tone')), '👍🏿');
  assert.equal(unicodeOfShortcode(reactionCode('wave_light_skin_tone')), '👋🏻');
  assert.equal(reactionCode('+1'), '+1');
  assert.equal(reactionCode('party_skin_tone'), 'party_skin_tone');
});

test('toned codes go back to Mattermost names', () => {
  assert.equal(reactionName(reactionCode('-1_medium_light_skin_tone')), '-1_medium_light_skin_tone');
  assert.equal(reactionName(':+1_tone5:'), '+1_dark_skin_tone');
  assert.equal(reactionName('smile'), 'smile');
});
