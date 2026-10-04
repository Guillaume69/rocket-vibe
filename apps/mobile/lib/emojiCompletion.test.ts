import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyCompletion,
  completeEmoji,
  detectEmojiToken,
} from './emojiCompletion.ts';

describe('detectEmojiToken', () => {
  test('finds the open token just before the cursor', () => {
    assert.deepEqual(detectEmojiToken('goodbye :sm', 11), { start: 8, query: 'sm' });
  });

  test('lowercases the query, keeps the start intact', () => {
    assert.deepEqual(detectEmojiToken('a :SMi', 6), { start: 2, query: 'smi' });
  });

  test('triggers at the start of the field', () => {
    assert.deepEqual(detectEmojiToken(':te', 3), { start: 0, query: 'te' });
  });

  test('triggers from the first letter', () => {
    assert.deepEqual(detectEmojiToken(':t', 2), { start: 0, query: 't' });
  });

  test('a bare `:` (no letter) does not trigger', () => {
    assert.equal(detectEmojiToken(':', 1), null);
  });

  test('an already closed token does not trigger', () => {
    assert.equal(detectEmojiToken(':smile:', 7), null);
  });

  test('picks up the SECOND token, not the first closed one', () => {
    assert.deepEqual(detectEmojiToken(':smile: :par', 12), { start: 8, query: 'par' });
  });

  test('ignores the `:` of a URL (preceded by a letter)', () => {
    assert.equal(detectEmojiToken('look http://ex', 14), null);
  });

  test('ignores the `:` of a time (preceded by a digit)', () => {
    assert.equal(detectEmojiToken('at 12:34', 8), null);
  });

  test('a space closes the token', () => {
    assert.equal(detectEmojiToken('hello :sm ', 10), null);
  });

  test('a cursor in the MIDDLE bounds the query', () => {
    // Cursor after "sm": the following "ile" is not part of it.
    assert.deepEqual(detectEmojiToken(':smile', 3), { start: 0, query: 'sm' });
  });

  test('triggers after non-alphanumeric punctuation', () => {
    assert.deepEqual(detectEmojiToken('(:sm', 4), { start: 1, query: 'sm' });
  });

  test('ignores a `:` stuck to an ACCENTED letter (French word)', () => {
    // `résumé` is 6 characters, the `:` is preceded by `é`: no opening.
    assert.equal(detectEmojiToken('résumé:tl', 9), null);
    assert.equal(detectEmojiToken('Café:im', 7), null);
  });

  test('no colon, nothing', () => {
    assert.equal(detectEmojiToken('hello', 5), null);
  });
});

describe('completeEmoji', () => {
  const STD = ['smile', 'smiley', 'sad', 'unsmiley', 'test', 'tetard'];
  const CUST = ['smirk_cat', 'party_parrot'];

  test('ranks prefix before substring, custom before standard', () => {
    // `sm`: custom prefix (smirk_cat), then standard prefixes (smile<smiley),
    // then standard substring (unsmiley). `sad`/`test`/`tetard` do not match.
    assert.deepEqual(
      completeEmoji('sm', STD, CUST).map((s) => s.code),
      ['smirk_cat', 'smile', 'smiley', 'unsmiley'],
    );
  });

  test('an exact match comes before a longer prefix', () => {
    assert.equal(completeEmoji('smile', STD, CUST)[0]?.code, 'smile');
  });

  test('a custom with the same name as a standard is dropped (the glyph wins)', () => {
    const r = completeEmoji('smile', ['smile'], ['smile']);
    assert.equal(r.length, 1);
    assert.equal(r[0]?.type, 'standard');
  });

  test('a custom with an UPPERCASE name matches a lowercase query', () => {
    // The server may name a custom `PartyBlob`; `:party` must find it, and the
    // ORIGINAL code is kept (the image URL is built on it).
    const r = completeEmoji('party', [], ['PartyBlob']);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0], { code: 'PartyBlob', type: 'custom' });
  });

  test('a custom with the same name as a standard, up to case, is dropped', () => {
    const r = completeEmoji('smile', ['smile'], ['Smile']);
    assert.equal(r.length, 1);
    assert.equal(r[0]?.type, 'standard');
  });

  test('respects the cap', () => {
    const many = Array.from({ length: 100 }, (_, i) => `test${i}`);
    assert.equal(completeEmoji('test', many, [], 5).length, 5);
  });

  test('a single letter is now enough to rank', () => {
    // `s`: custom prefix (smirk_cat), standard prefixes (sad<smile<smiley),
    // then standard substrings, shortest first (test<unsmiley).
    assert.deepEqual(
      completeEmoji('s', STD, CUST).map((s) => s.code),
      ['smirk_cat', 'sad', 'smile', 'smiley', 'test', 'unsmiley'],
    );
  });

  test('empty query, empty list', () => {
    assert.deepEqual(completeEmoji('', STD, CUST), []);
  });

  test('no match, empty list', () => {
    assert.deepEqual(completeEmoji('zzz', STD, CUST), []);
  });
});

describe('applyCompletion', () => {
  test('replaces the token, cursor after, trailing space added', () => {
    // "hi :sm" → insert 😄 → "hi 😄 ", cursor at the end.
    const r = applyCompletion('hi :sm', 3, 6, '😄');
    assert.equal(r.text, 'hi 😄 ');
    assert.equal(r.cursor, r.text.length);
  });

  test('in the middle, does not double the following space', () => {
    const r = applyCompletion('a :sm b', 2, 5, ':smile:');
    assert.equal(r.text, 'a :smile: b');
    // Cursor right after ":smile:", before the existing space.
    assert.equal(r.cursor, 'a :smile:'.length);
  });

  test('inserts a custom shortcode as is', () => {
    const r = applyCompletion(':par', 0, 4, ':party_parrot:');
    assert.equal(r.text, ':party_parrot: ');
    assert.equal(r.cursor, ':party_parrot: '.length);
  });
});
