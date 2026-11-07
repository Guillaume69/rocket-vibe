import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NEW_TABLE, NEW_TASK_LIST } from './loopTemplates.ts';
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

/** The merge-tree operations of a save on one component's text. */
function merges(ops: readonly Doc[], component: string): Doc[] {
  return ops
    .filter((o) => o.type === 'component' && (o.contents as Doc).address === component)
    .map((o) => ((o.contents as Doc).contents as Doc).content as Doc | undefined)
    .filter((c): c is Doc => c?.address === 'text')
    .map((c) => c.contents as Doc);
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
  assert.equal(text.sequence, 5);
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
  assert.deepEqual(notesEdit(text, text.markdown, {}), []);
});

test('an edit rewrites only what changed, in descending positions, and reads back', () => {
  const text = formatted();
  const wanted = text.markdown
    .replace('## Second heading', '### Third level')
    .replace('bjr', 'bonjour **à tous**')
    .replace('- bullet two\n', '- bullet two\n- bullet three\n')
    .replace('\n\n> a quote', '');
  const ops = merges(notesEdit(text, wanted, { name: 'Ada' }), text.component);
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

test('new paragraphs carry their style and marks', () => {
  const empty = { markdown: '', sequence: 0, updatedBy: null, updatedAt: null, component: 'C', listRegistry: null, blocks: [] };
  const ops = merges(notesEdit(empty, '# Title\n\nhello **world**\n\n- item', { name: 'Ada' }), 'C');
  const styles = ops.map((o) => (o.seg as Doc | undefined)?.props as Doc | undefined).map((p) => p?.['style!reference']).filter(Boolean);
  assert.deepEqual(styles, ['Heading 1']);
  assert.ok(ops.some((o) => (o.seg as Doc | undefined)?.text === 'world' && ((o.seg as Doc).props as Doc)['format!bold'] === true));
});

/** A page as Loop keeps it (scrubbed from a real one), the Rust tests' own fixture. */
function blocksSnapshot(): Doc {
  const blobs: Doc[] = [], entries: Doc[] = [];
  const file = (path: string, content: unknown) => {
    const id = `b${blobs.length}`;
    blobs.push({ id, content: typeof content === 'string' ? content : JSON.stringify(content), encoding: 'utf-8' });
    entries.push({ path, type: 'blob', id });
  };
  const dir = (storage: Doc) => ({ content: { storage } });
  const plain = (value: unknown) => ({ type: 'Plain', value });
  const url = (u: string) => ({ type: '__fluid_handle__', url: u });
  const para = { marker: { refType: 1 }, props: { nodeType: 'Paragraph' } };
  const text = (segmentTexts: unknown[]) => ({ segmentTexts, headerMetadata: { orderedChunkMetadata: [{ id: 'header' }], sequenceNumber: 5 } });
  const at = (c: string, rest: string) => `.app/.channels/${c}/${rest}`;
  const pkg = (p: string) => ({ pkg: `["${p}"]` });
  const component = (c: string) => ({ marker: { refType: 1 }, props: { nodeType: 'FluidComponent', 'component!url': url(`/${c}`) } });
  file(at('P', '.component'), pkg('LoopCanvasComponentSingleton'));
  file(at('P', '.channels/root/header'), dir({ 'text:list!registry': plain(url('/P/REG')) }));
  file(at('P', '.channels/CHECK/header'), dir({ 'list!id': plain('L0'), 'list!itemFormat-0': plain('%cb') }));
  file(at('P', '.channels/NUM/header'), dir({ 'list!id': plain('L1'), 'list!itemFormat-0': plain('%cd3') }));
  file(at('P', '.channels/text/content/header'), text([
    'title', para,
    { text: 'done', props: { 'format!textDecoration': ['strikethrough'] } },
    { marker: { refType: 1 }, props: { nodeType: 'Paragraph', 'list!reference': '0;L0;1' } },
    'open',
    { marker: { refType: 1 }, props: { nodeType: 'Paragraph', 'list!reference': '0;L0;0' } },
    'one',
    { marker: { refType: 1 }, props: { nodeType: 'Paragraph', 'list!reference': '0;L1' } },
    component('Q'), component('CODE'), component('TB'), component('TL'),
  ]));
  file(at('Q', '.component'), pkg('BlockQuoteComponentType'));
  file(at('Q', '.channels/text/content/header'), text(['wise', para]));
  file(at('CODE', '.component'), pkg('CodeBlockComponentType'));
  file(at('CODE', '.channels/root/header'), dir({ 'text:code!language': plain('Python') }));
  file(at('CODE', '.channels/text/content/header'), text(['x = 1', para]));
  const cell = (row: number, column: number) => {
    let k = 0;
    for (let b = 0; b < 8; b++) k |= (((column >> b) & 1) << (2 * b)) | (((row >> b) & 1) << (2 * b + 1));
    return k;
  };
  const matrix = (rows: [number, number, unknown][]) => {
    const leaf = new Array<unknown>(64).fill(null);
    for (const [r, c, v] of rows) leaf[cell(r, c)] = v;
    return [[[[[[leaf]]]]], [null], -1];
  };
  file(at('TB', '.component'), pkg('TableroComponentType'));
  file(at('TB', '.channels/root/header'), dir({ tableViewModelIdKey: plain(url('/TV')) }));
  file(at('TV', '.channels/root/header'), dir({
    tableroDocumentId: plain(url('/TD')), rowSequenceKey: plain(url('/TV/rowSequence-1')), colSequenceKey: plain(url('/TV/colSequence-1')),
    viewDataPropertyBagKey: plain(url('/TV/bag')), sharedSignalKey: plain(url('/TV/signal')),
  }));
  file(at('TD', '.channels/root/header'), dir({ matrixIdKey: plain(url('/TD/matrixId-1')), columnCounterKey: plain(url('/TD/counter')) }));
  file(at('TD', '.channels/matrixId-1/rows/segments/header'), { segments: [[2, 1]] });
  file(at('TD', '.channels/matrixId-1/cols/segments/header'), { segments: [[2, 1]] });
  file(at('TV', '.channels/rowSequence-1/header'), { dataArray: [{ entryId: 'E0', value: 'gone', isDeleted: true }, { entryId: 'E1', value: 'R', isDeleted: false }] });
  file(at('TV', '.channels/colSequence-1/header'), { dataArray: [{ entryId: 'EC', value: 'K', isDeleted: false }] });
  file(at('TD', '.channels/matrixId-1/cells'), matrix([
    [1, 2, { id: 'K', type: 'IRichTextData', title: { componentHandle: url('/HEAD'), cellValue: 'Col' } }],
    [2, 1, { id: 'R' }],
    [2, 2, { value: { componentHandle: url('/CELL'), cellValue: '' }, cellDataTypeProps: { type: 'IRichTextData' } }],
  ]));
  file(at('HEAD', '.channels/text/content/header'), text(['Col', para]));
  file(at('CELL', '.channels/text/content/header'), text(['aa', para]));
  file(at('TL', '.component'), pkg('TasklistComponentType'));
  file(at('TT', '.component'), pkg('TasklistComponentType'));
  file(at('TL', '.channels/root/header'), dir({ tableComponentHandle: plain(url('/TT')) }));
  file(at('TT', '.channels/root/header'), dir({ tableViewModelIdKey: plain(url('/LV')) }));
  file(at('LV', '.channels/root/header'), dir({ tableroDocumentId: plain(url('/LD')), rowSequenceKey: plain(url('/LV/rowSequence-1')), colSequenceKey: plain(url('/LV/colSequence-1')) }));
  file(at('LD', '.channels/root/header'), dir({ matrixIdKey: plain(url('/LD/matrixId-1')) }));
  file(at('LD', '.channels/matrixId-1/rows/segments/header'), { segments: [[2, 1]] });
  file(at('LD', '.channels/matrixId-1/cols/segments/header'), { segments: [[2, 1]] });
  file(at('LV', '.channels/rowSequence-1/header'), { dataArray: [{ entryId: 'E1', value: 'T', isDeleted: false }] });
  file(at('LV', '.channels/colSequence-1/header'), { dataArray: [{ entryId: 'E2', value: 'TC', isDeleted: false }] });
  file(at('LD', '.channels/matrixId-1/cells'), matrix([
    [1, 2, { id: 'TC', type: 'ICheckboxRichText' }],
    [2, 1, { id: 'T' }],
    [2, 2, { value: { componentHandle: url('/BOX') } }],
  ]));
  file(at('BOX', '.channels/root/header'), dir({ ConfigurationType: plain({ checked: false, type: 'CheckboxText', richTextComponentHandle: url('/TITLE') }) }));
  file(at('TITLE', '.channels/text/content/header'), text(['ship', para]));
  return { blobs, latestSequenceNumber: 5, ops: [], trees: [{ entries }] };
}

const BLOCKS = 'title\n\n- [x] done\n- [ ] open\n\n1. one\n\n> wise\n\n```python\nx = 1\n```\n\n| Col |\n| --- |\n| aa |\n\n- [ ] ship';

const sequenced = (ops: readonly Doc[]) => ops.map((contents, n) => ({ op: { sequenceNumber: 6 + n, timestamp: 1, type: 'op', contents: JSON.stringify(contents) }, sequenceNumber: 6 + n }));
const addressOf = (op: Doc) => {
  const contents = op.contents as Doc;
  return `${String(contents.address)}/${String(((contents.contents as Doc).content as Doc | undefined)?.address)}`;
};
const onChannel = (ops: readonly Doc[], channel: string) => ops
  .filter((o) => o.type === 'component' && addressOf(o).endsWith(`/${channel}`))
  .map((o) => (((o.contents as Doc).contents as Doc).content as Doc).contents as Doc);

test('a real page\'s blocks read as markdown, and saving them unchanged sends nothing', () => {
  const text = readNotes(blocksSnapshot())!;
  assert.equal(text.markdown, BLOCKS);
  assert.deepEqual(notesEdit(text, BLOCKS, {}), []);
});

test('each block is edited in its own channel and reads back as typed', () => {
  const snapshot = blocksSnapshot();
  const text = readNotes(snapshot)!;
  const wanted = BLOCKS.replace('title', 'title again').replace('> wise', '> wiser\n> and more').replace('x = 1', 'x = 2')
    .replace('| aa |', '| **bb** |').replace('- [ ] ship', '- [x] shipped').replace('- [ ] open', '- [x] open');
  const ops = notesEdit(text, wanted, { name: 'Ada' });
  assert.deepEqual(new Set(ops.map(addressOf)), new Set(['P/text', 'Q/text', 'CODE/text', 'CELL/text', 'TITLE/text', 'BOX/root']));
  const tick = onChannel(ops, 'root')[0]!;
  assert.equal(tick.key, 'ConfigurationType');
  assert.equal(((tick.value as Doc).value as Doc).checked, true);
  assert.ok(onChannel(ops, 'text').some((o) => (o.props as Doc | undefined)?.['list!reference'] === '0;L0;1'));
  assert.equal(readNotes(snapshot, sequenced(ops))!.markdown, wanted);
});

test('a table takes new and removed rows and columns', () => {
  const snapshot = blocksSnapshot();
  const text = readNotes(snapshot)!;
  const table = '| Col |\n| --- |\n| aa |';
  for (const typed of [
    '| Col |\n| --- |\n| aa |\n| new row |',
    '| Col |\n| --- |\n| new first |\n| aa |',
    '| Col | Two |\n| --- | --- |\n| aa | **b** |',
    '| One | Col |\n| --- | --- |\n| x | aa |',
    '| Col |\n| --- |',
    '| Renamed |\n| --- |\n| changed |\n| and more |',
  ]) {
    const wanted = BLOCKS.replace(table, typed);
    const ops = notesEdit(text, wanted, { name: 'Ada' });
    const again = readNotes(snapshot, sequenced(ops))!;
    assert.equal(again.markdown, wanted, typed);
    assert.deepEqual(notesEdit(again, wanted, {}), [], typed);
  }
});

test('a new row and a removed one follow the editor\'s operations', () => {
  const text = readNotes(blocksSnapshot())!;
  const added = notesEdit(text, BLOCKS.replace('| aa |', '| aa |\n| bb |'), { name: 'Ada' });
  const matrix = onChannel(added, 'matrixId-1');
  assert.deepEqual(matrix[0], { pos1: 2, seg: [1, -2147483648], type: 0, target: 'rows' });
  assert.equal(matrix[1]!.row, 2);
  assert.equal(matrix[1]!.col, 0);
  assert.equal(onChannel(added, 'rowSequence-1')[0]!.insertAfterEntryId, 'E1');
  const removed = notesEdit(text, BLOCKS.replace('\n| aa |', ''), {});
  assert.deepEqual(onChannel(removed, 'matrixId-1')[0], { pos1: 1, pos2: 2, type: 1, target: 'rows' });
  assert.deepEqual(onChannel(removed, 'rowSequence-1')[0], { type: 1, entryId: 'E1' });
});

test('a whole component can go', () => {
  const text = readNotes(blocksSnapshot())!;
  const block = text.blocks.find((b) => b.embedded?.t === 'table')!;
  const ops = notesEdit(text, BLOCKS.replace('| Col |\n| --- |\n| aa |\n\n', ''), {});
  assert.deepEqual(merges(ops, 'P'), [{ pos1: block.start, pos2: block.marker + 1, type: 1 }]);
});

test('new quotes and lists are attached first and read back before the next summary', () => {
  const snapshot = blocksSnapshot();
  const text = readNotes(snapshot)!;
  const wanted = `${BLOCKS}\n\n> a new quote\n> and more\n\nplain\n\n- b1\n- b2\n\n1. n1\n2. n2\n\n- [ ] c1\n- [x] c2`;
  const ops = notesEdit(text, wanted, { name: 'Ada' });
  const quote = ops.findIndex((o) => o.type === 'attach');
  const placed = ops.findIndex((o) => JSON.stringify(o).includes('FluidComponent'));
  assert.ok(quote >= 0 && quote < placed);
  assert.equal(readNotes(snapshot, sequenced(ops))!.markdown, wanted);
});

test('inline markdown parses back into marks', () => {
  const shown = parseInline('a **b** *c* ~~d~~ [e](https://x.y/) \\*f').map((r) => `${r.text}:${+r.marks.bold}${+r.marks.italic}${+r.marks.struck}${r.marks.link ?? ''}`);
  assert.deepEqual(shown, ['a :000', 'b:100', ' :000', 'c:010', ' :000', 'd:001', ' :000', 'e:000https://x.y/', ' *f:000']);
});

test('tasks are added and removed one at a time', () => {
  const snapshot = blocksSnapshot();
  const text = readNotes(snapshot)!;
  const wanted = `${BLOCKS}\n- [x] next\n- [ ] last`;
  const ops = notesEdit(text, wanted, {});
  assert.equal(readNotes(snapshot, sequenced(ops))!.markdown, wanted);
});

test('a new table and task list read back as typed', () => {
  const snapshot = blocksSnapshot();
  const text = readNotes(snapshot)!;
  const wanted = `${BLOCKS}\n\nbetween\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | **2** | 3 |\n| 4 | 5 | 6 |\n\nmore\n\n- [ ] one · To do\n- [x] two`;
  const back = readNotes(snapshot, sequenced(notesEdit(text, wanted, {})))!.markdown;
  assert.ok(back.includes('| A | B | C |\n| --- | --- | --- |\n| 1 | **2** | 3 |\n| 4 | 5 | 6 |'), back);
  assert.ok(back.endsWith('- [ ] one · To do\n- [x] two · To do'), back);
});

test('a summary can wrap recent segments and keep text operations apart', () => {
  const snapshot = blocksSnapshot();
  const path = '.app/.channels/P/.channels/text/content/catchupOps';
  (snapshot.trees as { entries: unknown[] }[])[0]!.entries.push({ path, id: 'catchup' });
  (snapshot.blobs as unknown[]).push({ id: 'catchup', content: JSON.stringify([{ sequenceNumber: 9, contents: { pos1: 0, seg: { json: { text: 'new ' }, seq: 9 }, type: 0 } }]) });
  assert.ok(readNotes(snapshot)!.markdown.startsWith('new title'));
});

test('the templates are the same as the desktop core', () => {
  const read = (name: string) => readFileSync(new URL(`../../../crates/rv-teams/templates/${name}`, import.meta.url), 'utf8').trimEnd();
  assert.equal(NEW_TABLE, read('loop-table.json'));
  assert.equal(NEW_TASK_LIST, read('loop-tasklist.json'));
});
