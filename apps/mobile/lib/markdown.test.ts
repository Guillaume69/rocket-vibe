import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { textPreview, messageTree, textOf, emojiUnicode } from './markdown.ts';

describe('messageTree', () => {
  test('prefers the server `md` when present', () => {
    const md = JSON.stringify([
      { type: 'PARAGRAPH', value: [{ type: 'PLAIN_TEXT', value: 'server' }] },
    ]);
    const tree = messageTree(md, 'ignored text');
    assert.equal(textOf(tree), 'server');
  });

  test('an OLD message without `md` is parsed locally: the 4.3 contract fallback', () => {
    const tree = messageTree(null, '**bold** and _italic_');
    assert.ok(tree !== null);
    assert.equal(tree[0].type, 'PARAGRAPH');
    assert.equal(textOf(tree), 'bold and italic');
  });

  test('a `md` corrupted in the database falls back to the text instead of crashing', () => {
    assert.equal(textOf(messageTree('{not json', 'fallback')), 'fallback');
    assert.equal(textOf(messageTree('"not an array"', 'fallback')), 'fallback');
    assert.equal(textOf(messageTree('[]', 'fallback')), 'fallback');
  });

  test('a `md` of corrupted SHAPE (poisoned elements) also falls back to the text', () => {
    // An array is not enough: `[null]` or a node without `type` passed the
    // guard and crashed rendering, durably, since `md` is persisted.
    assert.equal(textOf(messageTree('[null]', 'fallback')), 'fallback');
    assert.equal(textOf(messageTree('[{"value":[]}]', 'fallback')), 'fallback');
    assert.equal(textOf(messageTree('[42]', 'fallback')), 'fallback');
  });

  test('neither `md` nor text: null, not an exception', () => {
    assert.equal(messageTree(null, null), null);
    assert.equal(messageTree(null, '   '), null);
  });
});

describe('textOf', () => {
  test('flattens nested nodes', () => {
    const tree = messageTree(null, '**bold _and italic_** `code`');
    assert.equal(textOf(tree), 'bold and italic code');
  });

  test('a known short code returns its character', () => {
    const tree = messageTree(null, ':smile: hello');
    assert.equal(textOf(tree), '😄 hello');
  });

  test('an unknown short code stays literal: a custom emoji is still readable', () => {
    const tree = messageTree(null, 'bravo :shipit: !');
    assert.equal(textOf(tree), 'bravo :shipit: !');
  });

  test('an unknown node returns an empty string, not a crash', () => {
    assert.equal(textOf({ type: 'FUTURE_TYPE' }), '');
    assert.equal(textOf(42), '');
  });

  test('a TIMESTAMP returns its `fallback`, not an empty string', () => {
    // `<t:…:F>` yields a node whose `value` is an opaque object; the parser
    // provides `fallback` exactly for the fallback display.
    const tree = messageTree(null, 'meet <t:1720000000:F> ok');
    assert.match(textOf(tree), /meet <t:1720000000:F> ok/);
  });

  test('a unicode emoji returns its character', () => {
    assert.equal(textOf({ type: 'EMOJI', unicode: '🙂' }), '🙂');
  });
});

describe('emojiUnicode', () => {
  test('resolves both forms the server sends', () => {
    assert.equal(emojiUnicode({ type: 'EMOJI', unicode: '🙂' }), '🙂');
    assert.equal(
      emojiUnicode({ type: 'EMOJI', value: { type: 'PLAIN_TEXT', value: 'tada' }, shortCode: 'tada' }),
      '🎉',
    );
  });

  test('a BIG_EMOJI may contain none: the parser does not validate', () => {
    // The proof, taken on the 8.5 server: `:pas_un_emoji:` alone on its line
    // comes out as BIG_EMOJI. Without this `null`, the screen would show it at 36 px.
    const tree = messageTree(null, ':pas_un_emoji:');
    assert.ok(tree !== null);
    assert.equal(tree[0].type, 'BIG_EMOJI');
    const nodes = (tree[0] as { value: unknown[] }).value;
    assert.deepEqual(nodes.map(emojiUnicode), [null]);
    assert.equal(textOf(tree), ':pas_un_emoji:');
  });

  test('anything that is not an EMOJI node is `null`', () => {
    assert.equal(emojiUnicode({ type: 'PLAIN_TEXT', value: 'smile' }), null);
    assert.equal(emojiUnicode(null), null);
    assert.equal(emojiUnicode('smile'), null);
  });
});

describe('textPreview', () => {
  test('a preview reads as text, without markdown syntax', () => {
    assert.equal(textPreview('```\nZOB\n```'), 'ZOB');
    assert.equal(textPreview('[t.gg](http://t.gg) *bold* ~struck~ `code`'), 't.gg bold struck code');
    assert.equal(textPreview('hi @bob #general\n\n- one\n- two'), 'hi @bob #general • one • two');
    assert.equal(textPreview(':kkk: :smile:'), ':kkk: 😄');
  });
});
