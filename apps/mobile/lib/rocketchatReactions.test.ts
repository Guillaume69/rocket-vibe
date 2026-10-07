import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { unicodeOfShortcode } from './emojis.ts';
import { rocketChatReaction } from './rocketchatReactions.ts';

const accepted = new Set<string>(
  (JSON.parse(readFileSync(new URL('../../../scripts/rocketchat-emojis.json', import.meta.url), 'utf8')) as { codes: string[] }).codes,
);

test('an accepted code is sent as it is', () => {
  for (const code of ['+1', 'thumbsup', 'heart', 'joy', 'tada', 'open_mouth', 'pray', 'rocket']) {
    assert.equal(rocketChatReaction(code), code);
  }
});

test('a refused code goes out as an accepted alias of the same glyph', () => {
  const sent = rocketChatReaction('alien_monster');
  assert.equal(sent, 'space_invader');
  assert.ok(accepted.has(sent!));
  assert.equal(unicodeOfShortcode(sent!), unicodeOfShortcode('alien_monster'));
});

test('a glyph Rocket.Chat has no code for is hidden', () => {
  assert.equal(rocketChatReaction('melting_face'), null);
  assert.equal(rocketChatReaction('saluting_face'), null);
});

test('a custom emoji passes: the server judges its own', () => {
  assert.equal(rocketChatReaction('party_parrot'), 'party_parrot');
});

test('whatever it sends is in the list Rocket.Chat accepts', () => {
  for (const code of ['grinning', 'thumbs_up', 'red_heart', 'smiley', 'fire', 'eyes', '100']) {
    const sent = rocketChatReaction(code);
    if (sent !== null) assert.ok(accepted.has(sent), `${code} -> ${sent}`);
  }
});
