import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { notesPage, readNotes } from './notes.ts';

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
  assert.deepEqual(text, { markdown: 'Élan\n\nbonjour', sequence: 5, updatedBy: 'Bob', updatedAt: 1004 });
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
  assert.equal(text.markdown, '- [x] milk\n- [ ] eggs 🥚!\n- [site](https://example.com)\n\na\\*b');
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
