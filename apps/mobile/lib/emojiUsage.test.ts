import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_REACTIONS,
  canonicalEmojiCode,
  QUICK_COUNT,
  emojiIdentity,
  normalizeEmojiCode,
  topEmojis,
  type EmojiUse,
} from './emojiUsage.ts';

const use = (code: string, count: number, lastUsed = 0): EmojiUse => ({ code, count, lastUsed });

describe('normalizeEmojiCode', () => {
  test('strips the colons', () => {
    assert.equal(normalizeEmojiCode(':+1:'), '+1');
    assert.equal(normalizeEmojiCode(' party_parrot '), 'party_parrot');
  });

  test('refuses what is not a shortcode', () => {
    assert.equal(normalizeEmojiCode(''), null);
    assert.equal(normalizeEmojiCode(':'), null);
    assert.equal(normalizeEmojiCode('::'), null);
    assert.equal(normalizeEmojiCode('👍'), null);
    assert.equal(normalizeEmojiCode('two words'), null);
    assert.equal(normalizeEmojiCode('x'.repeat(101)), null);
  });
});

describe('canonicalEmojiCode', () => {
  test('aliases of a default reaction count under its name', () => {
    assert.equal(canonicalEmojiCode('thumbsup'), '+1');
    assert.equal(canonicalEmojiCode(':thumbs_up:'), '+1');
    assert.equal(canonicalEmojiCode('red_heart'), 'heart');
  });

  test('other aliases under the glyph main name; customs and invalid as they are', () => {
    assert.equal(canonicalEmojiCode('rocket'), 'rocket');
    assert.equal(canonicalEmojiCode(canonicalEmojiCode('alien_monster')!), canonicalEmojiCode('space_invader'));
    assert.equal(canonicalEmojiCode('party_parrot'), 'party_parrot');
    assert.equal(canonicalEmojiCode('👍'), null);
  });
});

describe('topEmojis', () => {
  test('no use yet: the default row, cut to the size asked', () => {
    assert.deepEqual(topEmojis([], QUICK_COUNT), DEFAULT_REACTIONS.slice(0, QUICK_COUNT));
  });

  test('most used first, then most recent, then the defaults fill', () => {
    const rows = [use('rocket', 2, 10), use('fire', 5, 1), use('eyes', 2, 20)];
    assert.deepEqual(topEmojis(rows, 5), ['fire', 'eyes', 'rocket', '+1', 'heart']);
  });

  test('a default already used is not repeated', () => {
    assert.deepEqual(topEmojis([use('heart', 3, 1)], 5), ['heart', '+1', 'joy', 'tada', 'open_mouth']);
  });

  test('more uses than places: only the best', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((code, i) => use(`party_${code}`, i + 1, i));
    assert.deepEqual(topEmojis(rows, 5), ['party_f', 'party_e', 'party_d', 'party_c', 'party_b']);
  });

  test('aliases of one emoji are one entry, under the most used code', () => {
    assert.equal(emojiIdentity('+1'), emojiIdentity('thumbsup'));
    const rows = [use('thumbsup', 1, 50), use('+1', 2, 10), use('fire', 2, 20)];
    // 3 uses of 👍 together: ahead of fire, and the default `+1` is not added again.
    assert.deepEqual(topEmojis(rows, 4), ['+1', 'fire', 'heart', 'joy']);
  });

  test('colons and invalid rows are tolerated', () => {
    const rows = [use(':rocket:', 1, 1), use('👍', 9, 9), use('fire', 0, 9), use('eyes', Number.NaN, 9)];
    assert.deepEqual(topEmojis(rows, 2), ['rocket', '+1']);
  });

  test('`allowed` drops what the room cannot take, the defaults stay', () => {
    const rows = [use('party_parrot', 9, 1), use('rocket', 1, 1)];
    const standardOnly = (code: string) => emojiIdentity(code) !== code;
    assert.deepEqual(topEmojis(rows, 3, standardOnly), ['rocket', '+1', 'heart']);
  });

  test('ties are deterministic', () => {
    const rows = [use('zap', 1, 5), use('eyes', 1, 5)];
    assert.deepEqual(topEmojis(rows, 2), ['eyes', 'zap']);
  });
});
