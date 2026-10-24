import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { unicodeOfShortcode } from './emojis.ts';
import { EMOJI_CODES } from './emojis.generated.ts';

describe('unicodeOfShortcode', () => {
  test('resolves common shortcodes', () => {
    assert.equal(unicodeOfShortcode('smile'), '😄');
    assert.equal(unicodeOfShortcode('tada'), '🎉');
    assert.equal(unicodeOfShortcode('rocket'), '🚀');
  });

  test('resolves aliases, including `+1`, the reaction bar one', () => {
    assert.equal(unicodeOfShortcode('+1'), '👍');
    assert.equal(unicodeOfShortcode('thumbsup'), unicodeOfShortcode('+1'));
  });

  test('`:heart:` carries its variation selector, otherwise the font renders it BLACK', () => {
    assert.equal(unicodeOfShortcode('heart'), '❤️');
  });

  test('skin tones are codes in their own right', () => {
    // They are not DERIVED: in a ZWJ sequence the modifier goes after the
    // person, not at the end (`🧑🏻‍🎨`, not `🧑‍🎨🏻`).
    assert.equal(unicodeOfShortcode('thumbsup_tone2'), '👍🏼');
    assert.equal(unicodeOfShortcode('artist_tone1'), '🧑🏻‍🎨');
  });

  test('an unknown code is `null`, which is how we know it is not an emoji', () => {
    assert.equal(unicodeOfShortcode('pas_un_emoji_du_tout'), null);
    assert.equal(unicodeOfShortcode(''), null);
    // A server custom emoji: unknown to the table, on purpose.
    assert.equal(unicodeOfShortcode('shipit'), null);
  });

  test('Object prototype members do not leak through', () => {
    // `:constructor:` is a legal shortcode for the server parser.
    assert.equal(unicodeOfShortcode('constructor'), null);
    assert.equal(unicodeOfShortcode('__proto__'), null);
    assert.equal(unicodeOfShortcode('toString'), null);
  });
});

describe('the generated table', () => {
  test('stays pure ASCII, otherwise Hermes doubles its size in the bundle', () => {
    assert.match(EMOJI_CODES, /^[\x00-\x7f]*$/);
  });

  test('all 6222 entries decode to a non-empty glyph', () => {
    // `String.fromCodePoint` throws on an invalid code point: a corrupted
    // generated artifact must fail HERE, not while rendering a message.
    const codes = Object.keys(JSON.parse(EMOJI_CODES) as Record<string, string>);
    assert.equal(codes.length, 6222);
    for (const code of codes) {
      const glyph = unicodeOfShortcode(code);
      assert.ok(
        glyph !== null && glyph.length > 0,
        `shortcode "${code}" does not decode`,
      );
    }
  });
});
