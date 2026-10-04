import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { textPreview, messageTree, textOf, emojiUnicode } from './markdown.ts';

describe('messageTree', () => {
  test('prefers the server `md` when present', () => {
    const md = JSON.stringify([
      { type: 'PARAGRAPH', value: [{ type: 'PLAIN_TEXT', value: 'serveur' }] },
    ]);
    const tree = messageTree(md, 'texte ignoré');
    assert.equal(textOf(tree), 'serveur');
  });

  test('an OLD message without `md` is parsed locally: the 4.3 contract fallback', () => {
    const tree = messageTree(null, '**gras** et _italique_');
    assert.ok(tree !== null);
    assert.equal(tree[0].type, 'PARAGRAPH');
    assert.equal(textOf(tree), 'gras et italique');
  });

  test('a `md` corrupted in the database falls back to the text instead of crashing', () => {
    assert.equal(textOf(messageTree('{pas du json', 'secours')), 'secours');
    assert.equal(textOf(messageTree('"pas un tableau"', 'secours')), 'secours');
    assert.equal(textOf(messageTree('[]', 'secours')), 'secours');
  });

  test('a `md` of corrupted SHAPE (poisoned elements) also falls back to the text', () => {
    // An array is not enough: `[null]` or a node without `type` passed the
    // guard and crashed rendering, durably, since `md` is persisted.
    assert.equal(textOf(messageTree('[null]', 'secours')), 'secours');
    assert.equal(textOf(messageTree('[{"value":[]}]', 'secours')), 'secours');
    assert.equal(textOf(messageTree('[42]', 'secours')), 'secours');
  });

  test('neither `md` nor text: null, not an exception', () => {
    assert.equal(messageTree(null, null), null);
    assert.equal(messageTree(null, '   '), null);
  });
});

describe('textOf', () => {
  test('flattens nested nodes', () => {
    const tree = messageTree(null, '**gras _et italique_** `code`');
    assert.equal(textOf(tree), 'gras et italique code');
  });

  test('a known short code returns its character', () => {
    const tree = messageTree(null, ':smile: bonjour');
    assert.equal(textOf(tree), '😄 bonjour');
  });

  test('an unknown short code stays literal: a custom emoji is still readable', () => {
    const tree = messageTree(null, 'bravo :shipit: !');
    assert.equal(textOf(tree), 'bravo :shipit: !');
  });

  test('an unknown node returns an empty string, not a crash', () => {
    assert.equal(textOf({ type: 'FUTUR_TYPE' }), '');
    assert.equal(textOf(42), '');
  });

  test('a TIMESTAMP returns its `fallback`, not an empty string', () => {
    // `<t:…:F>` yields a node whose `value` is an opaque object; the parser
    // provides `fallback` exactly for the fallback display.
    const tree = messageTree(null, 'rdv <t:1720000000:F> ok');
    assert.match(textOf(tree), /rdv <t:1720000000:F> ok/);
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
    assert.equal(textPreview('[t.gg](http://t.gg) *gras* ~barré~ `code`'), 't.gg gras barré code');
    assert.equal(textPreview('salut @bob #general\n\n- un\n- deux'), 'salut @bob #general • un • deux');
    assert.equal(textPreview(':kkk: :smile:'), ':kkk: 😄');
  });
});
