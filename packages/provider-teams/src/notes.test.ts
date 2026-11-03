import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { notesEdit, notesPage, parseInline, readNotes } from './notes.ts';

type Doc = Record<string, unknown>;

function snapshot(segments: unknown[], ops: unknown[]): Doc {
  const header = { segmentTexts: segments, headerMetadata: { orderedChunkMetadata: [{ id: 'header' }], sequenceNumber: 0 } };
  return {
    blobs: [{ id: 'h', content: JSON.stringify(header), encoding: 'utf-8' }],
    latestSequenceNumber: 5,
    ops,
    trees: [{ sequenceNumber: 0, entries: [{ path: '.app/.channels/C/.channels/text/content/header', type: 'blob', id: 'h' }] }],
  };
}

function op(seq: number, merge: unknown): Doc {
  const contents = { type: 'component', contents: { address: 'C', contents: { content: { address: 'text', contents: merge }, type: 'op' } } };
  return { op: { sequenceNumber: seq, timestamp: 1000 + seq, type: 'op', contents: JSON.stringify(contents) }, sequenceNumber: seq };
}

const marker = () => ({ marker: { refType: 1 }, props: { nodeType: 'Paragraph' } });
const by = (name: string, text: string) => ({ text, props: { attribution: { name } } });

test('a page is found from its created event address', () => {
  const nav = btoa('s=%2Fcontentstorage%2FCSP_guid&d=b!drive&f=01ITEM&c=%2F&fluid=1&p=%40fluidx%2Floop-page-container');
  const uri = `https://tenant.sharepoint.com/contentstorage/CSP_guid/Document%20Library/19_x_thread_v2/loop_loopThread.loop?nav=${nav}`;
  assert.deepEqual(notesPage(uri), { host: 'https://tenant.sharepoint.com', drive: 'b!drive', item: '01ITEM' });
  assert.equal(notesPage('https://evil.example.com/x.loop?nav=cz0x'), null);
  assert.equal(notesPage('not a url'), null);
});

test('typed text replays into paragraphs closed by their markers', () => {
  const grouped = { type: 'groupedBatch', contents: [
    { contents: { type: 'schema', contents: {} } },
    { contents: { type: 'component', contents: { address: 'C', contents: { content: { address: 'text', contents: { pos1: 0, seg: by('Ada', 'É'), type: 0 } }, type: 'op' } } } },
  ] };
  const ops = [
    { op: { sequenceNumber: 1, timestamp: 1001, type: 'op', contents: JSON.stringify(grouped) }, sequenceNumber: 1 },
    op(2, { pos1: 1, seg: by('Ada', 'lan'), type: 0 }),
    op(3, { pos1: 5, seg: marker(), type: 0 }),
    op(4, { pos1: 5, seg: by('Bob', 'bonjour'), type: 0 }),
    { op: { sequenceNumber: 5, type: 'noop' }, sequenceNumber: 5 },
  ];
  const text = readNotes(snapshot([marker()], ops))!;
  assert.deepEqual({ markdown: text.markdown, sequence: text.sequence, updatedBy: text.updatedBy, updatedAt: text.updatedAt }, { markdown: 'Élan\n\nbonjour', sequence: 5, updatedBy: 'Bob', updatedAt: 1004 });
});

test('later operations remove, annotate and are not replayed twice', () => {
  const ops = [op(1, { pos1: 0, seg: by('Ada', 'Plan draft'), type: 0 })];
  const later = [
    op(1, { pos1: 0, seg: by('Ada', 'Plan draft'), type: 0 }),
    op(2, { pos1: 4, pos2: 10, type: 1 }),
    op(3, { pos1: 4, pos2: 5, props: { nodeType: 'Heading2' }, type: 2 }),
    op(4, { pos1: 0, pos2: 4, props: { bold: true }, type: 2 }),
  ];
  const text = readNotes(snapshot([marker()], ops), later)!;
  assert.equal(text.markdown, '## **Plan**');
  assert.equal(text.sequence, 4);
});

test('lists, checklists, links and UTF-16 positions', () => {
  const segments = [
    { text: 'milk', props: {} },
    { marker: { refType: 1 }, props: { nodeType: 'CheckListItem', checked: true } },
    { text: 'eggs 🥚', props: {} },
    { marker: { refType: 1 }, props: { nodeType: 'CheckListItem' } },
    { text: 'site', props: { link: 'https://example.com' } },
    { marker: { refType: 1 }, props: { nodeType: 'BulletedListItem' } },
    'a*b',
  ];
  const text = readNotes(snapshot(segments, []), [op(1, { pos1: 12, seg: by('Ada', '!'), type: 0 })])!;
  assert.equal(text.markdown, '- [x] milk\n- [ ] eggs 🥚!\n\n- [site](https://example.com)\n\na\\*b');
});

test('a real snapshot reads as its two paragraphs', () => {
  const real = JSON.parse(readFileSync(new URL('../../../crates/rv-teams/data/notes-snapshot.json', import.meta.url), 'utf8')) as Doc;
  const text = readNotes(real)!;
  assert.equal(text.markdown, 'ÉNORME\n\nbjr');
  assert.equal(text.sequence, 20);
  assert.equal(text.updatedBy, 'Bob');
});

test('a snapshot without text reads as nothing', () => {
  assert.equal(readNotes({ trees: [{ entries: [] }] }), null);
  assert.equal(readNotes(snapshot([marker()], []))!.markdown, '');
});

const SAMPLE = 'ÉNORME\n\nbjr\n\n# Heading one\n\n## Second heading\n\nPlain with **bold**, *italic*, ~~struck~~ and [a link](https://example.com/).\n\n- bullet one\n- bullet two\n\n1. first\n2. second\n\n- [x] done item\n- [ ] open item\n\n> a quote\n\n```\nlet x = 1;\n```\n\nÉcrit depuis RocketVibe (test natif)';
const formatted = () => readNotes(JSON.parse(readFileSync(new URL('../../../crates/rv-teams/data/notes-formatted.json', import.meta.url), 'utf8')) as Doc)!;

test('a formatted Loop page reads as markdown: style!reference, format!* and hyperlink!url', () => {
  const text = formatted();
  assert.equal(text.markdown, SAMPLE);
  assert.equal(text.component, 'C');
});

test('saving unchanged markdown sends nothing', () => {
  const text = formatted();
  assert.deepEqual(notesEdit(text.blocks, text.markdown, {}), []);
});

test('an edit rewrites only what changed, in descending positions, and reads back', () => {
  const text = formatted();
  const wanted = text.markdown
    .replace('## Second heading', '### Third level')
    .replace('bjr', 'bonjour **à tous**')
    .replace('- bullet two\n', '- bullet two\n- bullet three\n')
    .replace('\n\n> a quote', '');
  const ops = notesEdit(text.blocks, wanted, { name: 'Ada' });
  assert.ok(ops.length < 12);
  for (let i = 1; i < ops.length; i++) assert.ok((ops[i - 1]!.pos1 as number) >= (ops[i]!.pos1 as number));
  // Replay the ops on the page as the service sequences them.
  const header = { segmentTexts: [] as unknown[], headerMetadata: { orderedChunkMetadata: [{ id: 'header' }], sequenceNumber: 0 } };
  for (const b of text.blocks) {
    for (const r of b.runs) header.segmentTexts.push({ text: r.text, props: { ...(r.marks.bold ? { 'format!bold': true } : {}), ...(r.marks.italic ? { 'format!italic': true } : {}), ...(r.marks.struck ? { 'format!strikeThrough': true } : {}), ...(r.marks.link ? { 'hyperlink!url': r.marks.link } : {}) } });
    if (b.props) header.segmentTexts.push({ marker: { refType: 1 }, props: b.props });
  }
  const snapshot = {
    blobs: [{ id: 'h', content: JSON.stringify(header), encoding: 'utf-8' }],
    ops: ops.map((merge, i) => ({ sequenceNumber: i + 1, op: { sequenceNumber: i + 1, type: 'op', contents: JSON.stringify({ type: 'component', contents: { address: 'C', contents: { content: { address: 'text', contents: merge }, type: 'op' } } }) } })),
    trees: [{ entries: [{ path: '.app/.channels/C/.channels/text/content/header', type: 'blob', id: 'h' }] }],
  };
  assert.equal(readNotes(snapshot)!.markdown, wanted);
});

test('new paragraphs carry their style and marks; a list with nothing to join stays readable', () => {
  const ops = notesEdit([], '# Title\n\nhello **world**\n\n- item', { name: 'Ada' });
  const styles = ops.map((o) => (o.seg as Doc | undefined)?.props as Doc | undefined).map((p) => p?.['style!reference']).filter((s) => s !== undefined);
  assert.deepEqual(styles, ['Heading 1']);
  assert.ok(ops.some((o) => (o.seg as Doc | undefined)?.text === 'world' && ((o.seg as Doc).props as Doc)['format!bold'] === true));
  assert.ok(ops.some((o) => (o.seg as Doc | undefined)?.text === '- item'));
});

test('inline markdown parses back into marks', () => {
  const shown = parseInline('a **b** *c* ~~d~~ [e](https://x.y/) \\*f').map((r) => `${r.text}:${+r.marks.bold}${+r.marks.italic}${+r.marks.struck}${r.marks.link ?? ''}`);
  assert.deepEqual(shown, ['a :000', 'b:100', ' :000', 'c:010', ' :000', 'd:001', ' :000', 'e:000https://x.y/', ' *f:000']);
});
