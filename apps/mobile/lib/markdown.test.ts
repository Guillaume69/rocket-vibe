import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { textPreview, messageTree, textOf, emojiUnicode, isTable, mentionOf, splitTables, type Table } from './markdown.ts';

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

test('a shortcode with letters beyond ASCII is an emoji, outside code only', () => {
  const tree = messageTree(null, ':göring: and `:höss:`');
  const nodes = (tree?.[0] as { value: { type: string; shortCode?: string }[] }).value;
  assert.deepEqual(nodes.map((n) => [n.type, n.shortCode]), [['EMOJI', 'göring'], ['PLAIN_TEXT', undefined], ['INLINE_CODE', undefined]]);
});

test('only a name with a letter beyond ASCII is that emoji: a glyph or a punctuation mark between colons stays text', () => {
  for (const text of ['wow:😀:', 'a :、: b', 'x:１２:']) {
    const nodes = (messageTree(null, text)?.[0] as { value: { type: string }[] }).value;
    assert.deepEqual(nodes.map((n) => n.type), ['PLAIN_TEXT'], text);
  }
  const nodes = (messageTree(null, 'ok :café_2: :日本:')?.[0] as { value: { type: string; shortCode?: string }[] }).value;
  assert.deepEqual(nodes.filter((n) => n.type === 'EMOJI').map((n) => n.shortCode), ['café_2', '日本']);
});

describe('GFM tables in locally parsed text', () => {
  const uptime = '#### AxeoBIM is ✅ Up\n\n| Server | Message |\n|:-------|:--------|\n|  | [AxeoBIM] [✅ Up] All children up and running |';

  test('a table becomes its own block between the text around it', () => {
    const tree = messageTree(null, uptime)!;
    assert.deepEqual(tree.map((b) => b.type), ['HEADING', 'TABLE']);
    const table = tree[1] as unknown as Table;
    assert.ok(isTable(table));
    assert.deepEqual(table.align, ['left', 'left']);
    assert.deepEqual(table.value.map((r) => r.header), [true, false]);
    assert.deepEqual(table.value[1]!.value.map((c) => textOf(c.value)), ['', '[AxeoBIM] [✅ Up] All children up and running']);
    assert.equal(textOf(tree[0]), 'AxeoBIM is ✅ Up');
  });

  test('alignment, optional outer pipes, escaped pipes and short rows', () => {
    const tree = messageTree(null, 'a | b | c\n---|:-:|--:\n1 | x \\| y\nafter')!;
    const table = tree[0] as unknown as Table;
    assert.deepEqual(table.align, [null, 'center', 'right']);
    assert.deepEqual(table.value[1]!.value.map((c) => textOf(c.value)), ['1', 'x | y', '']);
    assert.equal(table.value.length, 2, 'a line without a pipe ends the table');
    assert.equal(textOf(tree[1]), 'after');
  });

  test('cells are inline markdown: emoji, links, bold', () => {
    const table = messageTree(null, '| A |\n|---|\n| :file_folder: [doc](https://x.y/z) **b** |')![0] as unknown as Table;
    const types = table.value[1]!.value[0]!.value.map((n) => n.type);
    assert.deepEqual(types, ['EMOJI', 'PLAIN_TEXT', 'LINK', 'PLAIN_TEXT', 'BOLD']);
  });

  test('no table: a header without its delimiter row, a column count mismatch, a code block', () => {
    for (const text of ['a | b\nc | d', 'a | b\n---|---|---', '```\n| a |\n|---|\n```']) {
      assert.ok(!(messageTree(null, text) ?? []).some((b) => isTable(b)), text);
    }
  });

  test('previews and plain text never show the pipes of the syntax', () => {
    assert.equal(textPreview(uptime), 'AxeoBIM is ✅ Up Server | Message · [AxeoBIM] [✅ Up] All children up and running');
    assert.equal(textOf(messageTree(null, '| a | b |\n|---|---|\n| 1 | 2 |')), 'a | b\n1 | 2');
  });
});

describe('mentionOf', () => {
  const names = new Map([['marc-etienne.barrut', 'Marc-Etienne Barrut']]);

  test('a known username reads as the name, the username kept for the profile', () => {
    assert.deepEqual(mentionOf('marc-etienne.barrut', names), { username: 'marc-etienne.barrut', label: '@Marc-Etienne Barrut' });
  });

  test('punctuation the parser kept stays after the name', () => {
    assert.deepEqual(mentionOf('marc-etienne.barrut.', names), { username: 'marc-etienne.barrut', label: '@Marc-Etienne Barrut.' });
  });

  test('unknown people, everyone mentions and servers without names read as written', () => {
    assert.equal(mentionOf('bob', names).label, '@bob');
    assert.equal(mentionOf('here', new Map([['here', 'Here']])).label, '@here');
    assert.equal(mentionOf('marc-etienne.barrut', new Map()).label, '@marc-etienne.barrut');
  });
});

describe('splitTables and an unclosed fence', () => {
  test('a table after an unclosed fence stays code', () => {
    assert.equal(splitTables('```\n| a | b |\n|---|---|\n| 1 | 2 |'), null);
  });

  test('a table before it is cut out, the unclosed fence kept as text', () => {
    const chunks = splitTables('| a | b |\n|---|---|\n| 1 | 2 |\n```\n| c | d |\n|---|---|');
    assert.equal(chunks?.length, 2);
    assert.ok(chunks !== null && 'table' in chunks[0]!);
    assert.deepEqual(chunks?.[1], { text: '```\n| c | d |\n|---|---|' });
  });
});
