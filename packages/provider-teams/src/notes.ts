/**
 * A chat's Notes tab: a Loop page in SharePoint Embedded, read whole and turned
 * into markdown. Its text is a Fluid merge-tree: the summary in the latest
 * snapshot, then the operations sequenced since, replayed in order. Quotes, code
 * blocks, tables and task lists are components of their own, each cell or title
 * with its own text channel. Saving sends what changed through Fluid's delta stream.
 * Mirrors `rv_teams::notes` in the desktop core.
 */

import { NEW_TABLE, NEW_TASK_LIST } from './loopTemplates.ts';

type Doc = Record<string, unknown>;
type Props = Record<string, unknown>;

/** The system message Teams posts when a chat's notes are created; its text is the page's address. */
export const NOTES_CREATED = 'rv-notes-created';

export type NotesPage = { host: string; drive: string; item: string };

export type NotesText = { markdown: string; sequence: number; updatedBy: string | null; updatedAt: number | null; component: string; listRegistry: string | null; blocks: Block[] };

const obj = (v: unknown): Doc => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Doc) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function decodeBase64(text: string): string | null {
  try {
    const binary = atob(text.replace(/=+$/, '').padEnd(Math.ceil(text.replace(/=+$/, '').length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** The page a `FileAdd` event's address names: its `nav` parameter is a base64 query `s=…&d=<drive>&f=<item>`. */
export function notesPage(uri: string): NotesPage | null {
  let url: URL;
  try { url = new URL(uri); } catch { return null; }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.sharepoint.com')) return null;
  const nav = url.searchParams.get('nav');
  const query = nav === null ? null : decodeBase64(nav);
  if (query === null) return null;
  const fields = new URLSearchParams(query);
  const drive = fields.get('d') ?? '';
  const item = fields.get('f') ?? '';
  return drive && item ? { host: `https://${url.hostname}`, drive, item } : null;
}

type Unit = { code: number; props: Props } | { marker: true; props: Props };

function units(wrapped: unknown): Unit[] {
  if (obj(wrapped).removedSeq !== undefined) return [];
  // A segment newer than the collab window comes wrapped with its sequence.
  const segment = obj(wrapped).json ?? wrapped;
  if (typeof segment === 'string') return Array.from({ length: segment.length }, (_, i) => ({ code: segment.charCodeAt(i), props: {} }));
  const s = obj(segment);
  const props = { ...obj(s.props) };
  if (s.marker !== undefined) return [{ marker: true, props }];
  const text = typeof s.text === 'string' ? s.text : '';
  return Array.from({ length: text.length }, (_, i) => ({ code: text.charCodeAt(i), props: { ...props } }));
}

/** What a sequenced op carries per channel, unwrapping grouped batches. */
function channelOps(contents: Doc): { address: string; channel: string; op: Doc }[] {
  if (contents.type === 'groupedBatch') return arr(contents.contents).flatMap((inner) => channelOps(obj(obj(inner).contents)));
  if (contents.type !== 'component') return [];
  const envelope = obj(contents.contents);
  const content = obj(obj(envelope.contents).content);
  return typeof envelope.address === 'string' && typeof content.address === 'string'
    ? [{ address: envelope.address, channel: content.address, op: obj(content.contents) }]
    : [];
}

function apply(all: Unit[], op: Doc, text: NotesText): boolean {
  const at = (key: string) => {
    const p = num(op[key]);
    return p === null ? null : Math.min(Math.max(0, p), all.length);
  };
  switch (op.type) {
    case 0: {
      const pos = at('pos1');
      if (pos === null) return false;
      const inserted = units(op.seg);
      const name = obj(obj(obj(op.seg).props).attribution).name;
      if (typeof name === 'string') text.updatedBy = name;
      all.splice(pos, 0, ...inserted);
      return inserted.length > 0;
    }
    case 1: case 4: case 5: {
      const from = at('pos1'), to = at('pos2');
      if (from === null || to === null || from >= to) return false;
      all.splice(from, to - from);
      return true;
    }
    case 2: {
      const from = at('pos1'), to = at('pos2');
      const changes = obj(op.props);
      if (from === null || to === null) return false;
      for (const unit of all.slice(from, Math.max(from, to))) {
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) delete unit.props[key];
          else unit.props[key] = value;
        }
      }
      return from < to;
    }
    case 3: return arr(op.ops).reduce<boolean>((changed, inner) => apply(all, obj(inner), text) || changed, false);
    default: return false;
  }
}

const sequenceOf = (entry: Doc) => num(entry.sequenceNumber) ?? num(obj(entry.op).sequenceNumber) ?? 0;

/** A snapshot's tree and blobs, decoded; components attached since join it. */
class Store {
  readonly paths = new Map<string, string>();
  readonly blobs = new Map<string, string>();
  constructor(snapshot: Doc) {
    for (const b of arr(snapshot.blobs)) {
      const blob = obj(b);
      if (typeof blob.content !== 'string') continue;
      const text = blob.encoding === 'base64' ? decodeBase64(blob.content) : blob.content;
      if (text !== null) this.blobs.set(String(blob.id), text);
    }
    for (const e of arr(obj(arr(snapshot.trees)[0]).entries)) {
      const entry = obj(e);
      if (typeof entry.path === 'string' && typeof entry.id === 'string') this.paths.set(entry.path, entry.id);
    }
  }
  json(path: string): Doc | null {
    const id = this.paths.get(path);
    const text = id === undefined ? undefined : this.blobs.get(id);
    if (text === undefined) return null;
    try { return JSON.parse(text) as Doc; } catch { return null; }
  }
  package(component: string): string {
    const pkg = this.json(`.app/.channels/${component}/.component`)?.pkg;
    return typeof pkg === 'string' ? pkg : '';
  }
  root(component: string, key: string): unknown {
    const root = this.json(`.app/.channels/${component}/.channels/root/header`);
    return obj(obj(obj(root?.content).storage)[key]).value;
  }
  stories(): string[] {
    const out: string[] = [];
    for (const path of this.paths.keys()) {
      if (path.endsWith('/.channels/text/content/header')) out.push(path.replace(/^\.app\/\.channels\//, '').split('/')[0] ?? '');
    }
    return out;
  }
  componentOfPackage(pkg: string): string | null {
    const found: string[] = [];
    for (const path of this.paths.keys()) {
      if (!path.endsWith('/.component')) continue;
      const c = path.replace(/^\.app\/\.channels\//, '').split('/')[0] ?? '';
      if (this.package(c).includes(pkg)) found.push(c);
    }
    return found.sort()[0] ?? null;
  }
  /** Who an inline mention names, as summarised. */
  mention(component: string, key: string): unknown {
    const channel = this.json(`.app/.channels/${component}/.channels/${MENTIONS}/header`);
    return obj(obj(obj(channel?.content).storage)[key]).value;
  }
  units(component: string): { all: Unit[]; base: number } | null {
    const folder = `.app/.channels/${component}/.channels/text/content/`;
    const header = this.json(`${folder}header`);
    if (header === null) return null;
    const meta = obj(header.headerMetadata);
    const chunks = arr(meta.orderedChunkMetadata).map((c) => String(obj(c).id ?? '')).filter(Boolean);
    const all: Unit[] = [];
    for (const chunk of chunks.length > 0 ? chunks : ['header']) {
      const body = chunk === 'header' ? header : this.json(`${folder}${chunk}`) ?? {};
      for (const segment of arr(body.segmentTexts)) all.push(...units(segment));
    }
    return { all, base: num(meta.sequenceNumber) ?? 0 };
  }
  attach(contents: Doc): void {
    if (contents.type === 'groupedBatch') { for (const inner of arr(contents.contents)) this.attach(obj(obj(inner).contents)); return; }
    if (contents.type === 'attach') {
      const body = obj(contents.contents);
      if (typeof body.id === 'string') this.addEntries(`.app/.channels/${body.id}`, obj(body.snapshot));
      return;
    }
    if (contents.type !== 'component') return;
    const envelope = obj(contents.contents);
    const inner = obj(envelope.contents);
    const content = obj(inner.content);
    if (inner.type === 'attach' && typeof envelope.address === 'string' && typeof content.id === 'string') {
      this.addEntries(`.app/.channels/${envelope.address}/.channels/${content.id}`, obj(content.snapshot));
    }
  }
  private addEntries(folder: string, tree: Doc): void {
    for (const e of arr(tree.entries)) {
      const entry = obj(e);
      const path = `${folder}/${String(entry.path)}`;
      if (entry.type === 'Blob') {
        const body = obj(entry.value).contents;
        if (typeof body === 'string') { this.blobs.set(path, body); this.paths.set(path, path); }
      } else if (entry.type === 'Tree') this.addEntries(path, obj(entry.value));
    }
  }
}

/** The channel of `atMentions` holding who each inline mention names. */
const MENTIONS = 'instances';

type Replayed = { stories: Map<string, Unit[]>; keys: Map<string, unknown>; channels: Map<string, Doc[]> };
const channelKey = (component: string, channel: string) => `${component}\n${channel}`;

/** The page's text from its latest snapshot (JSON form) and operations fetched after it. */
export function readNotes(snapshot: Doc, later: readonly unknown[] = []): NotesText | null {
  const store = new Store(snapshot);
  const entriesOf = [...arr(snapshot.ops), ...later].map(obj);
  const contentsOf = (entry: Doc): Doc | null => {
    const op = entry.op === undefined ? entry : obj(entry.op);
    try { return typeof op.contents === 'string' ? obj(JSON.parse(op.contents)) : null; } catch { return null; }
  };
  for (const entry of entriesOf) {
    const contents = contentsOf(entry);
    if (contents !== null) store.attach(contents);
  }
  const names = store.stories();
  if (names.length === 0) return null;
  const component = names.find((c) => store.package(c).includes('LoopCanvasComponentSingleton')) ?? [...names].sort()[0]!;
  const page = store.units(component);
  if (page === null) return null;
  const lists = listsIn(store);
  const text: NotesText = { markdown: '', sequence: page.base, updatedBy: null, updatedAt: null, component, listRegistry: null, blocks: [] };
  const replayed: Replayed = { stories: new Map(), keys: new Map(), channels: new Map() };
  const bases = new Map<string, number>();
  for (const name of names) {
    const units = store.units(name);
    if (units !== null) { replayed.stories.set(name, units.all); bases.set(name, units.base); }
  }
  // A summary keeps the operations since its text was written beside that text.
  for (const name of names) {
    const catchup = store.json(`.app/.channels/${name}/.channels/text/content/catchupOps`) as unknown;
    for (const entry of arr(catchup).map(obj)) {
      const seq = num(entry.sequenceNumber) ?? 0;
      const all = replayed.stories.get(name);
      if (all && seq > (bases.get(name) ?? 0)) { apply(all, obj(entry.contents), text); bases.set(name, seq); }
    }
  }
  const summary = num(obj(arr(snapshot.trees)[0]).sequenceNumber) ?? 0;
  const seen = new Set<number>();
  for (const entry of entriesOf.sort((a, b) => sequenceOf(a) - sequenceOf(b))) {
    const seq = sequenceOf(entry);
    if (seen.has(seq)) continue;
    seen.add(seq);
    const op = entry.op === undefined ? entry : obj(entry.op);
    text.sequence = Math.max(text.sequence, seq);
    const contents = contentsOf(entry);
    if (contents === null) continue;
    let changed = false;
    for (const { address, channel, op: inner } of channelOps(contents)) {
      if (channel !== 'text' && channel !== 'root' && seq > summary) {
        const key = channelKey(address, channel);
        replayed.channels.set(key, [...(replayed.channels.get(key) ?? []), inner]);
      }
      if (channel === 'text') {
        if (seq <= (bases.get(address) ?? 0)) continue;
        const all = replayed.stories.get(address);
        if (all) changed = apply(all, inner, text) || changed;
      } else if ((channel === 'root' || channel === MENTIONS) && inner.type === 'set' && typeof inner.key === 'string') {
        replayed.keys.set(channelKey(address, inner.key), obj(inner.value).value);
      }
    }
    if (changed) text.updatedAt = num(op.timestamp) ?? text.updatedAt;
  }
  text.sequence = Math.max(text.sequence, num(snapshot.latestSequenceNumber) ?? 0);
  text.listRegistry = channelName(store.root(component, 'text:list!registry'));
  text.blocks = blocksOf(replayed.stories.get(component) ?? [], lists);
  for (const block of text.blocks) {
    const url = handle(block.props?.['component!url']);
    if (url !== null) block.embedded = embeddedOf(store, replayed, lists, url.replace(/^\//, ''));
  }
  text.markdown = render(text.blocks);
  return text;
}

function handle(value: unknown): string | null {
  const v = obj(value);
  return v.type === '__fluid_handle__' && typeof v.url === 'string' ? v.url : null;
}

function channelName(value: unknown): string | null {
  const url = handle(value);
  return url === null ? null : url.split('/').pop() ?? null;
}

/** A rich text cell: `id` the component owning its text, `null` for a value that cannot be edited. */
type Cell = { id: string | null; runs: Run[]; end: number };
type TableLine = { id: string; entry: string; position: number };
type Task = { checkbox: string; configuration: Doc; done: boolean; title: Cell; row: TableLine; details: string[] };
/** What separates a task's title from its assignees, due date and bucket. */
const TASK_DETAILS = ' \u00b7 ';
/** A checklist line's title, what follows it being a task's details. */
const taskTitle = (typed: string) => typed.split(TASK_DETAILS)[0] ?? typed;
type Table = {
  grid: Cell[][]; rows: TableLine[]; columns: TableLine[];
  data: string; view: string; matrix: string; rowSequence: string; columnSequence: string;
  viewBag: string | null; signal: string | null; counter: string | null;
  matrixRows: number; matrixColumns: number;
  /** Each column's place in the matrix and its definition. */
  definitions: { position: number; definition: Doc }[];
  /** The component a label cell's list of labels lives in. */
  labels: string | null;
};
/** What a `FluidComponent` paragraph holds, as far as the apps show it. */
type Embedded =
  | { t: 'story'; id: string; kind: Kind; language: string | null; blocks: Block[] }
  | { t: 'table'; table: Table }
  | { t: 'tasks'; tasks: Task[]; table: Table }
  | { t: 'other' };

function cellOf(id: string | null, replayed: Replayed, lists: Lists, fallback: string): Cell {
  const all = id === null ? undefined : replayed.stories.get(id);
  if (all === undefined) return { id: null, runs: fallback ? [{ text: fallback, marks: plain }] : [], end: 0 };
  const runs: Run[] = [];
  for (const block of blocksOf(all, lists)) {
    if (runs.length > 0 && block.runs.length > 0) runs.push({ text: ' ', marks: plain });
    runs.push(...block.runs);
  }
  let end = all.length;
  for (let i = all.length - 1; i >= 0; i--) {
    const unit = all[i]!;
    if ('marker' in unit && !inlineMarker(unit.props)) { end = i; break; }
  }
  return { id, runs, end };
}

/** A `SharedMatrix`: rows and columns are handles in the order kept, cells are
 *  keyed by the two handles, in a sparse tree keyed by their interleaved bits. */
type Matrix = { rows: number[]; columns: number[]; cells: Map<string, Doc> };
const cellKey = (row: number, column: number) => `${row},${column}`;

function loadMatrix(store: Store, data: string, channel: string, later: readonly Doc[]): Matrix | null {
  const folder = `.app/.channels/${data}/.channels/${channel}`;
  const vector = (name: string) => arr(store.json(`${folder}/${name}/segments/header`)?.segments).flatMap((wrapped) => {
    if (obj(wrapped).removedSeq !== undefined) return [];
    const s = obj(wrapped).json ?? wrapped;
    const [length, start] = [num(arr(s)[0]) ?? 0, num(arr(s)[1]) ?? 0];
    return Array.from({ length }, (_, i) => start + i);
  });
  const cells = store.json(`${folder}/cells`) as unknown;
  if (!Array.isArray(cells)) return null;
  const matrix: Matrix = { rows: vector('rows'), columns: vector('cols'), cells: new Map() };
  const spread = (morton: number, shift: number) => {
    let n = 0;
    for (let b = 0; b < 16; b++) n |= ((morton >>> (2 * b + shift)) & 1) << b;
    return n;
  };
  const walk = (node: unknown, key: number, depth: number): void => {
    arr(node).forEach((v, i) => {
      const next = depth === 0 ? 0 : (key * 256 + i) >>> 0;
      if (v === null) return;
      if (Array.isArray(v)) walk(v, next, depth + 1);
      else matrix.cells.set(cellKey(spread(next, 1), spread(next, 0)), obj(v));
    });
  };
  walk(cells[0], 0, 0);
  let next = Math.max(0, ...matrix.rows, ...matrix.columns) + 1;
  for (const op of later) {
    const line = op.target === 'rows' ? matrix.rows : matrix.columns;
    if (op.type === 0) {
      const count = num(arr(op.seg)[0]) ?? 0;
      line.splice(Math.min(num(op.pos1) ?? 0, line.length), 0, ...Array.from({ length: count }, (_, i) => next + i));
      next += count;
    } else if (op.type === 1) {
      const from = num(op.pos1) ?? 0;
      line.splice(from, Math.max(0, (num(op.pos2) ?? from) - from));
    } else if (op.type === 2) {
      const r = matrix.rows[num(op.row) ?? -1], c = matrix.columns[num(op.col) ?? -1];
      if (r !== undefined && c !== undefined) matrix.cells.set(cellKey(r, c), obj(op.value));
    }
  }
  return matrix;
}

type OrderEntry = { entry: string; value: string; deleted: boolean };

function orderOf(store: Store, view: string, channel: string, later: readonly Doc[]): OrderEntry[] {
  const entries: OrderEntry[] = arr(store.json(`.app/.channels/${view}/.channels/${channel}/header`)?.dataArray)
    .map(obj)
    .filter((e) => typeof e.entryId === 'string' && typeof e.value === 'string')
    .map((e) => ({ entry: e.entryId as string, value: e.value as string, deleted: e.isDeleted === true }));
  const after = (op: Doc) => {
    const at = typeof op.insertAfterEntryId === 'string' ? entries.findIndex((e) => e.entry === op.insertAfterEntryId) : -1;
    return at + 1;
  };
  for (const op of later) {
    const found = entries.find((e) => e.entry === op.entryId);
    if (op.type === 0) entries.splice(after(op), 0, { entry: String(op.entryId), value: String(op.value ?? ''), deleted: false });
    else if (op.type === 1 && found) found.deleted = true;
    else if (op.type === 2 && found) {
      found.deleted = true;
      entries.splice(after(op), 0, { entry: String(op.changedToEntryId ?? ''), value: found.value, deleted: false });
    } else if (op.type === 3 && found) found.deleted = op.isDeleted === true;
  }
  return entries;
}

function embeddedOf(store: Store, replayed: Replayed, lists: Lists, id: string): Embedded {
  const pkg = store.package(id);
  const story = (kind: Kind, language: string | null): Embedded => {
    const all = replayed.stories.get(id);
    if (all === undefined) return { t: 'other' };
    return { t: 'story', id, kind, language, blocks: blocksOf(all, lists).map((b) => ({ ...b, kind })) };
  };
  if (pkg.includes('BlockQuoteComponentType') || pkg.includes('BlockCalloutComponentType')) return story({ t: 'quote' }, null);
  if (pkg.includes('CodeBlockComponentType')) {
    const language = store.root(id, 'text:code!language');
    return story({ t: 'code' }, typeof language === 'string' ? language.toLowerCase() : null);
  }
  if (pkg.includes('TasklistComponentType')) return tableOf(store, replayed, lists, taskTable(store, id), true) ?? { t: 'other' };
  if (pkg.includes('TableroComponentType')) return tableOf(store, replayed, lists, id, false) ?? { t: 'other' };
  return { t: 'other' };
}

/** The table a task list's component names, one component down. */
function taskTable(store: Store, list: string): string {
  return handle(store.root(list, 'tableComponentHandle'))?.replace(/^\//, '') ?? list;
}

/** A cell of a task's assignees, due date or bucket, as shown after its title. */
function taskDetail(store: Store, replayed: Replayed, definition: Doc, cell: Doc): string | null {
  const component = handle(obj(cell.value).componentHandle)?.replace(/^\//, '') ?? null;
  if (definition.type === 'IRichTextData') {
    const names: string[] = [];
    for (const unit of (component === null ? undefined : replayed.stories.get(component)) ?? []) {
      if (!('marker' in unit)) continue;
      const url = handle(unit.props['component!url'])?.replace(/^\//, '');
      const [owner, key] = url?.split('/') ?? [];
      if (owner === undefined || key === undefined) continue;
      const name = obj(replayed.keys.get(channelKey(owner, key)) ?? store.mention(owner, key)).displayName;
      if (typeof name === 'string') names.push(`@${name}`);
    }
    return names.length > 0 ? names.join(', ') : null;
  }
  if (definition.type === 'IDateData' && component !== null) {
    const date = obj(obj(replayed.keys.get(channelKey(component, 'DiasKey')) ?? store.root(component, 'DiasKey')).contentInfo).currentDate;
    return typeof date === 'string' && date !== '' ? date.replace(/\//g, '-') : null;
  }
  if (definition.type === 'ILabelData') {
    const shown = obj(cell.value).cellValue;
    return typeof shown === 'string' && shown !== '' ? shown : null;
  }
  return null;
}

function tableOf(store: Store, replayed: Replayed, lists: Lists, root: string, tasks: boolean): Embedded | null {
  const bare = (url: string | null) => (url === null ? null : url.replace(/^\//, ''));
  const view = bare(handle(store.root(root, 'tableViewModelIdKey')));
  if (view === null) return null;
  const data = bare(handle(store.root(view, 'tableroDocumentId')));
  const matrixChannel = data === null ? null : channelName(store.root(data, 'matrixIdKey'));
  if (data === null || matrixChannel === null) return null;
  const later = (component: string, channel: string) => replayed.channels.get(channelKey(component, channel)) ?? [];
  const matrix = loadMatrix(store, data, matrixChannel, later(data, matrixChannel));
  if (matrix === null) return null;
  const rowsById = new Map<string, number>();
  const columnsById = new Map<string, { handle: number; value: Doc }>();
  for (const [key, value] of matrix.cells) {
    if (typeof value.id !== 'string') continue;
    const [row, column] = key.split(',').map(Number) as [number, number];
    if (value.type !== undefined) columnsById.set(value.id, { handle: column, value });
    else rowsById.set(value.id, row);
  }
  const rowSequence = channelName(store.root(view, 'rowSequenceKey'));
  const columnSequence = channelName(store.root(view, 'colSequenceKey'));
  if (rowSequence === null || columnSequence === null) return null;
  const rows: TableLine[] = orderOf(store, view, rowSequence, later(view, rowSequence)).flatMap((e) => {
    const h = rowsById.get(e.value);
    const position = h === undefined ? -1 : matrix.rows.indexOf(h);
    return e.deleted || position < 0 ? [] : [{ id: e.value, entry: e.entry, position }];
  });
  const columns: TableLine[] = orderOf(store, view, columnSequence, later(view, columnSequence)).flatMap((e) => {
    const c = columnsById.get(e.value);
    const position = c === undefined ? -1 : matrix.columns.indexOf(c.handle);
    return e.deleted || position < 0 ? [] : [{ id: e.value, entry: e.entry, position }];
  });
  const cellAt = (row: TableLine, column: TableLine) => {
    const r = rowsById.get(row.id), c = columnsById.get(column.id);
    return r === undefined || c === undefined ? undefined : matrix.cells.get(cellKey(r, c.handle));
  };
  const componentOf = (value: Doc | undefined) => bare(handle(obj(obj(value).value).componentHandle));
  const labelColumn = columns.find((c) => columnsById.get(c.id)?.value.type === 'ILabelData');
  let labels: string | null = null;
  for (const row of rows) {
    const cell = labelColumn ? componentOf(cellAt(row, labelColumn)) : null;
    labels = cell === null ? null : bare(handle(store.root(cell, 'labelComponentHandleKey')));
    if (labels !== null) break;
  }
  const shell: Table = {
    grid: [], rows, columns, data, view, matrix: matrixChannel, rowSequence, columnSequence,
    viewBag: channelName(store.root(view, 'viewDataPropertyBagKey')),
    signal: channelName(store.root(view, 'sharedSignalKey')),
    counter: channelName(store.root(data, 'columnCounterKey')),
    matrixRows: matrix.rows.length,
    matrixColumns: matrix.columns.length,
    definitions: columns.map((c) => ({ position: c.position, definition: columnsById.get(c.id)!.value })),
    labels: labels ?? store.componentOfPackage('LabelComponent'),
  };
  if (tasks) {
    const titleColumn = columns.find((c) => columnsById.get(c.id)?.value.type === 'ICheckboxRichText');
    if (!titleColumn) return null;
    const out: Task[] = [];
    for (const row of rows) {
      const checkbox = componentOf(cellAt(row, titleColumn));
      if (checkbox === null) continue;
      const configuration = obj(replayed.keys.get(channelKey(checkbox, 'ConfigurationType')) ?? store.root(checkbox, 'ConfigurationType'));
      const title = cellOf(bare(handle(configuration.richTextComponentHandle)), replayed, lists, '');
      if (title.runs.length === 0) continue;
      const details = columns.flatMap((column) => {
        const value = cellAt(row, column);
        const shown = value === undefined ? null : taskDetail(store, replayed, columnsById.get(column.id)!.value, value);
        return shown === null ? [] : [shown];
      });
      out.push({ checkbox, configuration, done: configuration.checked === true, title, row, details });
    }
    return { t: 'tasks', tasks: out, table: shell };
  }
  const grid: Cell[][] = [columns.map((c) => {
    const title = obj(columnsById.get(c.id)?.value.title);
    return cellOf(bare(handle(title.componentHandle)), replayed, lists, typeof title.cellValue === 'string' ? title.cellValue : '');
  })];
  for (const row of rows) {
    grid.push(columns.map((column) => {
      const value = cellAt(row, column);
      const fallback = obj(obj(value).value).cellValue;
      return cellOf(componentOf(value), replayed, lists, typeof fallback === 'string' ? fallback : '');
    }));
  }
  return { t: 'table', table: { ...shell, grid } };
}

function flag(props: Props, keys: readonly string[]): boolean {
  return keys.some((k) => {
    const v = props[k];
    return v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v !== '' && v !== 'false' && v !== '0');
  });
}

function textOf(props: Props, key: string): string | null {
  const v = props[key];
  if (typeof v === 'string' && v) return v;
  const inner = obj(v).value;
  return typeof inner === 'string' && inner ? inner : null;
}

function link(props: Props): string | null {
  for (const k of ['hyperlink!url', 'link', 'hyperlink', 'href', 'url']) {
    const v = props[k];
    if (typeof v === 'string' && v) return v;
    const o = obj(v);
    const u = o.url ?? o.href ?? o.value;
    if (typeof u === 'string') return u;
  }
  return null;
}

/** Loop writes a strikethrough either as its own flag or as a text decoration. */
function struck(props: Props): boolean {
  if (flag(props, ['format!strikeThrough', 'strikethrough', 'strike'])) return true;
  const decoration = props['format!textDecoration'];
  return decoration !== undefined && /line-through|strike/i.test(JSON.stringify(decoration));
}

type Marks = { bold: boolean; italic: boolean; struck: boolean; code: boolean; link: string | null };
const plain: Marks = { bold: false, italic: false, struck: false, code: false, link: null };
const sameMarks = (a: Marks, b: Marks) => a.bold === b.bold && a.italic === b.italic && a.struck === b.struck && a.code === b.code && a.link === b.link;

function marksOf(props: Props): Marks {
  return {
    bold: flag(props, ['format!bold', 'bold']),
    italic: flag(props, ['format!italic', 'italic']),
    struck: struck(props),
    code: flag(props, ['code', 'inlineCode']),
    link: link(props),
  };
}

/** The editor's properties for these marks, unset ones left out. */
function markProps(marks: Marks): Props {
  const out: Props = {};
  if (marks.bold) out['format!bold'] = true;
  if (marks.italic) out['format!italic'] = true;
  if (marks.struck) out['format!strikeThrough'] = true;
  if (marks.link !== null) out['hyperlink!url'] = marks.link;
  return out;
}

type Run = { text: string; marks: Marks };

const escaped = (text: string) => text.replace(/[\\*_[\]`~]/g, (c) => `\\${c}`);

function inline(runs: readonly Run[]): string {
  return runs.map(({ text, marks }) => {
    if (text.trim() === '') return text;
    let out = escaped(text);
    if (marks.code) out = `\`${text.replace(/`/g, "'")}\``;
    if (marks.struck) out = `~~${out}~~`;
    if (marks.italic) out = `*${out}*`;
    if (marks.bold) out = `**${out}**`;
    return marks.link === null ? out : `[${out}](${marks.link})`;
  }).join('');
}

type Kind =
  | { t: 'paragraph' } | { t: 'heading'; n: number } | { t: 'quote' } | { t: 'code' }
  | { t: 'bullet'; level: number } | { t: 'numbered'; level: number } | { t: 'check'; level: number; done: boolean }
  /** A line of a pipe table, in an edit: kept as it was typed. */
  | { t: 'tableRow' };

const familyOf = (k: Kind): number | null => (k.t === 'bullet' ? 1 : k.t === 'numbered' ? 2 : k.t === 'check' ? 3 : null);
const listed = (k: Kind) => familyOf(k) !== null;
const levelOfKind = (k: Kind) => (k.t === 'bullet' || k.t === 'numbered' || k.t === 'check' ? k.level : 0);
const sameKind = (a: Kind, b: Kind) => JSON.stringify(a) === JSON.stringify(b);

/** The editor's paragraph style for this kind; `null` for a plain paragraph. */
function styleOf(kind: Kind): string | null {
  if (kind.t === 'heading') return `Heading ${kind.n}`;
  if (kind.t === 'quote') return 'Quote';
  if (kind.t === 'code') return 'Code';
  return null;
}

/** List id → the format of each level (`%cb` a checkbox, a `cssClass` bullet, else numbered). */
type Lists = Map<string, string[]>;

function levelOf(props: Props): number {
  for (const k of ['list!level', 'list!indentLevel', 'indentLevel', 'listLevel', 'level']) {
    const v = props[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : Number.NaN;
    if (Number.isFinite(n)) return Math.min(8, Math.max(0, n));
  }
  return 0;
}

const checkedOf = (props: Props) =>
  flag(props, ['list!checked', 'checked', 'isChecked', 'completed', 'done'])
  || Object.entries(props).some(([k, v]) => k.toLowerCase().includes('state') && v === 'checked');

/** A list item's `list!reference`, `<level>;<list>[;<ticked>]`. */
function listReference(reference: string, props: Props): { level: number; list: string; ticked: boolean } {
  const parts = reference.split(';');
  if (parts.length >= 2) {
    return { level: Math.min(8, Math.max(0, Number.parseInt(parts[0]!, 10) || 0)), list: parts[1]!, ticked: parts[2] === '1' };
  }
  return { level: levelOf(props), list: reference, ticked: checkedOf(props) };
}

function kindOf(props: Props, lists: Lists): Kind {
  const style = textOf(props, 'style!reference');
  if (style !== null) {
    const lower = style.toLowerCase();
    const heading = /^heading\s+(\d)/.exec(lower);
    if (heading) return { t: 'heading', n: Math.min(6, Math.max(1, Number(heading[1]))) };
    if (lower === 'title') return { t: 'heading', n: 1 };
    if (lower === 'subtitle') return { t: 'heading', n: 2 };
    if (lower === 'quote' || lower === 'intense quote' || lower === 'callout') return { t: 'quote' };
    if (lower === 'code') return { t: 'code' };
  }
  const reference = textOf(props, 'list!reference');
  if (reference !== null) {
    const { level, list, ticked } = listReference(reference, props);
    const format = lists.get(list)?.[level] ?? '';
    if (format.includes('%cb') || ticked) return { t: 'check', level, done: ticked };
    if (format.includes('%cd') && !format.includes('cssClass')) return { t: 'numbered', level };
    return { t: 'bullet', level };
  }
  const level = levelOf(props);
  const kind = String(props.nodeType ?? 'Paragraph').toLowerCase();
  if (kind.includes('heading') || kind.includes('title')) {
    const digits = Number.parseInt(kind.replace(/\D/g, ''), 10);
    return { t: 'heading', n: Math.min(6, Math.max(1, num(props.headingLevel) ?? (Number.isNaN(digits) ? 1 : digits))) };
  }
  if (kind.includes('check') || kind.includes('task') || kind.includes('todo')) return { t: 'check', level, done: checkedOf(props) };
  if (kind.includes('number') || (kind.includes('ordered') && !kind.includes('unordered'))) return { t: 'numbered', level };
  if (kind.includes('list') || kind.includes('bullet')) return { t: 'bullet', level };
  if (kind.includes('quote')) return { t: 'quote' };
  if (kind.includes('code')) return { t: 'code' };
  return { t: 'paragraph' };
}

/** One paragraph of the page with where its text and closing marker sit. */
type Block = { kind: Kind; runs: Run[]; start: number; marker: number; props: Props | null; embedded?: Embedded };

const blockText = (b: Block) => b.runs.map((r) => r.text).join('');

/** The length of a leading list or quote prefix written as text. */
function literalPrefix(text: string): number | null {
  const indent = text.length - text.replace(/^ +/, '').length;
  const rest = text.slice(indent);
  const fixed = ['- [ ] ', '- [x] ', '- [X] ', '- ', '* ', '> '].find((p) => rest.startsWith(p));
  if (fixed !== undefined) return indent + fixed.length;
  const digits = /^\d+\. /.exec(rest);
  return digits ? indent + digits[0].length : null;
}

function line(block: Block): string {
  const body = inline(block.runs);
  const indent = (l: number) => '  '.repeat(l);
  switch (block.kind.t) {
    case 'paragraph': {
      const first = block.runs[0];
      if (first && sameMarks(first.marks, plain)) {
        const n = literalPrefix(first.text);
        if (n !== null) return first.text.slice(0, n) + inline([{ text: first.text.slice(n), marks: plain }, ...block.runs.slice(1)]);
      }
      return body;
    }
    case 'code': return body;
    case 'heading': return `${'#'.repeat(block.kind.n)} ${body}`;
    case 'quote': return `> ${body}`;
    case 'bullet': return `${indent(block.kind.level)}- ${body}`;
    case 'numbered': return `${indent(block.kind.level)}1. ${body}`;
    case 'check': return `${indent(block.kind.level)}- [${block.kind.done ? 'x' : ' '}] ${body}`;
    case 'tableRow': return blockText(block);
  }
}

/** What one line of the markdown edits. */
type Part = { t: 'page' } | { t: 'story'; at: number } | { t: 'separator' } | { t: 'row'; at: number } | { t: 'task'; at: number };

const cellMarkdown = (cell: Cell) => inline(cell.runs).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const tableLine = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;

/** The lines a paragraph shows, each with what it edits; a blank paragraph shows none and stays. */
function linesOf(block: Block): { text: string; part: Part }[] {
  const e = block.embedded;
  if (e === undefined) {
    if (block.kind.t === 'paragraph' && block.runs.every((r) => r.text === '')) return [];
    return [{ text: line(block), part: { t: 'page' } }];
  }
  if (e.t === 'other') return [];
  if (e.t === 'story') return e.blocks.map((b, at) => ({ text: line(b), part: { t: 'story', at } }));
  if (e.t === 'tasks') return e.tasks.map((t, at) => ({ text: `- [${t.done ? 'x' : ' '}] ${inline(t.title.runs)}${t.details.map((d) => `${TASK_DETAILS}${escaped(d)}`).join('')}`, part: { t: 'task', at } }));
  const out: { text: string; part: Part }[] = [];
  e.table.grid.forEach((row, at) => {
    out.push({ text: tableLine(row.map(cellMarkdown)), part: { t: 'row', at } });
    if (at === 0) out.push({ text: tableLine(row.map(() => '---')), part: { t: 'separator' } });
  });
  return out;
}

function blockMarkdown(block: Block): string {
  const e = block.embedded;
  if (e === undefined) return line(block);
  if (e.t === 'story' && e.kind.t === 'code') return `\`\`\`${e.language ?? ''}\n${e.blocks.map(blockText).join('\n')}\n\`\`\``;
  return linesOf(block).map((l) => l.text).join('\n');
}

/** 1 bullets, 2 numbers, 3 checkboxes, native or written as text. */
function listFamily(block: Block): number | null {
  if (block.embedded !== undefined) return null;
  if (block.kind.t === 'bullet') return 1;
  if (block.kind.t === 'numbered') return 2;
  if (block.kind.t === 'check') return 3;
  if (block.kind.t !== 'paragraph') return null;
  const first = block.runs[0];
  if (!first || !sameMarks(first.marks, plain) || literalPrefix(first.text) === null) return null;
  const rest = first.text.trimStart();
  if (rest.startsWith('>')) return null;
  if (rest.startsWith('- [')) return 3;
  return /^\d/.test(rest) ? 2 : 1;
}

function listsIn(store: Store): Lists {
  const out: Lists = new Map();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.includes('list!id')) { try { walk(JSON.parse(v)); } catch { /* not JSON */ } }
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v === null || typeof v !== 'object') return;
    const o = v as Doc;
    const id = textOf(o, 'list!id');
    if (id !== null) {
      const formats = Array.from({ length: 9 }, () => '');
      for (const [k, value] of Object.entries(o)) {
        const m = /^list!itemFormat-(\d+)$/.exec(k);
        if (m && Number(m[1]) < 9) formats[Number(m[1])] = textOf(o, k) ?? (typeof value === 'string' ? value : '');
      }
      out.set(id, formats);
    }
    Object.values(o).forEach(walk);
  };
  for (const text of store.blobs.values()) {
    if (text.includes('list!id')) { try { walk(JSON.parse(text)); } catch { /* not JSON */ } }
  }
  return out;
}

/** A marker inside a line (an emoji, a tab) rather than one closing a paragraph. */
function inlineMarker(props: Props): boolean {
  return props.nodeType === 'Emoji' || props.nodeType === 'Tab' || props['component!display'] === 'inline-block';
}

function blocksOf(all: readonly Unit[], lists: Lists): Block[] {
  const out: Block[] = [];
  let runs: Run[] = [];
  let pending: number[] = [];
  let pendingMarks: Marks | null = null;
  let start = 0;
  const flush = () => {
    if (pending.length > 0) runs.push({ text: String.fromCharCode(...pending), marks: pendingMarks ?? plain });
    pending = [];
    pendingMarks = null;
  };
  all.forEach((unit, pos) => {
    if ('marker' in unit && inlineMarker(unit.props)) {
      flush();
      const shown = unit.props.nodeType === 'Tab' ? ' ' : textOf(unit.props, 'emoji!value') ?? '';
      if (shown) runs.push({ text: shown, marks: plain });
    } else if ('marker' in unit) {
      flush();
      const kind = kindOf(unit.props, lists);
      // Loop strikes a ticked item's text; the tick already says it.
      if (kind.t === 'check' && kind.done) runs = runs.map((r) => ({ ...r, marks: { ...r.marks, struck: false } }));
      out.push({ kind, runs, start, marker: pos, props: { ...unit.props } });
      runs = [];
      start = pos + 1;
    } else {
      const marks = marksOf(unit.props);
      if (pendingMarks !== null && !sameMarks(pendingMarks, marks)) flush();
      pendingMarks ??= marks;
      pending.push(unit.code);
    }
  });
  flush();
  if (runs.length > 0) out.push({ kind: { t: 'paragraph' }, runs, start, marker: all.length, props: null });
  return out;
}

function render(blocks: readonly Block[]): string {
  const shown = blocks.filter((b) => linesOf(b).length > 0);
  let out = '';
  let previous: number | null | undefined;
  let count = 0;
  for (let i = 0; i < shown.length;) {
    const block = shown[i]!;
    const family = listFamily(block);
    if (previous !== undefined) out += family !== null && family === previous ? '\n' : '\n\n';
    if (block.kind.t === 'code' && block.embedded === undefined) {
      const lines: string[] = [];
      while (i < shown.length && shown[i]!.kind.t === 'code' && shown[i]!.embedded === undefined) { lines.push(blockText(shown[i]!)); i++; }
      out += `\`\`\`\n${lines.join('\n')}\n\`\`\``;
      previous = null;
      continue;
    }
    count = block.kind.t === 'numbered' && family === previous ? count + 1 : 1;
    out += block.kind.t === 'numbered' && block.embedded === undefined
      ? `${'  '.repeat(block.kind.level)}${count}. ${inline(block.runs)}`
      : blockMarkdown(block);
    previous = family;
    i++;
  }
  return out.trim();
}

/** Markdown's inline marks back into runs: `**`, `*`, `~~`, `` ` ``, `[text](url)`, escapes. */
export function parseInline(text: string): Run[] {
  const out: Run[] = [];
  const push = (t: string, marks: Marks) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && sameMarks(last.marks, marks)) last.text += t;
    else out.push({ text: t, marks });
  };
  const find = (chars: string, from: number, pat: string): number => {
    for (let j = from; j + pat.length <= chars.length;) {
      if (chars[j] === '\\') { j += 2; continue; }
      if (chars.startsWith(pat, j)) return j;
      j++;
    }
    return -1;
  };
  const go = (chars: string, base: Marks) => {
    let buf = '';
    let i = 0;
    const nested = (open: number, close: string, change: Partial<Marks>): number | null => {
      const end = find(chars, i + open, close);
      if (end < 0 || end === i + open) return null;
      push(buf, base);
      buf = '';
      go(chars.slice(i + open, end), { ...base, ...change });
      return end + close.length;
    };
    while (i < chars.length) {
      const c = chars[i]!;
      if (c === '\\' && i + 1 < chars.length) { buf += chars[i + 1]; i += 2; continue; }
      let next: number | null = null;
      if (chars.startsWith('**', i)) next = nested(2, '**', { bold: true });
      else if (chars.startsWith('~~', i)) next = nested(2, '~~', { struck: true });
      else if (c === '*' || c === '_') next = nested(1, c, { italic: true });
      else if (c === '`') {
        const end = find(chars, i + 1, '`');
        if (end >= 0) { push(buf, base); buf = ''; push(chars.slice(i + 1, end), { ...base, code: true }); next = end + 1; }
      } else if (c === '[') {
        const close = find(chars, i + 1, ']');
        if (close >= 0 && chars[close + 1] === '(') {
          const urlEnd = find(chars, close + 2, ')');
          if (urlEnd >= 0) {
            push(buf, base);
            buf = '';
            go(chars.slice(i + 1, close), { ...base, link: chars.slice(close + 2, urlEnd) });
            next = urlEnd + 1;
          }
        }
      }
      if (next === null) { buf += c; i++; } else i = next;
    }
    push(buf, base);
  };
  go(text, plain);
  return out;
}

type Wanted = { kind: Kind; runs: Run[] };

function parse(markdown: string): Wanted[] {
  const out: Wanted[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trimStart().startsWith('```')) {
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith('```'); i++) {
        out.push({ kind: { t: 'code' }, runs: [{ text: lines[i]!, marks: plain }] });
      }
      continue;
    }
    if (raw.trim() === '') continue;
    const bare = raw.trim();
    if (bare.length > 1 && bare.startsWith('|') && bare.endsWith('|')) {
      out.push({ kind: { t: 'tableRow' }, runs: [{ text: bare, marks: plain }] });
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    const level = Math.min(8, Math.floor(indent / 2));
    const text = raw.trimStart();
    let kind: Kind = { t: 'paragraph' };
    let body = text;
    let m: RegExpExecArray | null;
    if ((m = /^- \[([xX ])\] /.exec(text))) { kind = { t: 'check', level, done: m[1] !== ' ' }; body = text.slice(m[0].length); }
    else if ((m = /^[-*] /.exec(text))) { kind = { t: 'bullet', level }; body = text.slice(2); }
    else if ((m = /^\d+\. /.exec(text))) { kind = { t: 'numbered', level }; body = text.slice(m[0].length); }
    else if ((m = /^> ?/.exec(text))) { kind = { t: 'quote' }; body = text.slice(m[0].length); }
    else if ((m = /^(#{1,6}) /.exec(text))) { kind = { t: 'heading', n: m[1]!.length }; body = text.slice(m[0].length); }
    out.push({ kind, runs: parseInline(body) });
  }
  return out;
}

const sameRuns = (a: readonly Run[], b: readonly Run[]) => a.length === b.length && a.every((r, i) => r.text === b[i]!.text && sameMarks(r.marks, b[i]!.marks));

function uuid(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const insertText = (at: number, text: string, marks: Marks, author: Doc): Doc =>
  ({ pos1: at, seg: { text, props: { ...markProps(marks), attribution: author } }, type: 0 });

function insertMarker(at: number, kind: Kind, list: string | null, author: Doc): Doc {
  const props: Props = { attribution: author, markerId: uuid(), nodeType: 'Paragraph' };
  const style = styleOf(kind);
  if (style !== null) props['style!reference'] = style;
  if (list !== null) Object.assign(props, listProps(list, kind));
  return { pos1: at, seg: { marker: { refType: 1 }, props }, type: 0 };
}

function listProps(list: string, kind: Kind): Props {
  const reference = kind.t === 'check' ? `${kind.level};${list};${kind.done ? 1 : 0}` : `${levelOfKind(kind)};${list}`;
  return { 'list!reference': reference, 'placeholder!attributeText': 'placeholder!addItem' };
}

function listOf(block: Block): string | null {
  const reference = block.props === null ? null : textOf(block.props, 'list!reference');
  return reference === null || block.props === null ? null : listReference(reference, block.props).list;
}

function restyle(at: number, to: Kind, from: Kind): Doc {
  const props: Props = { 'style!reference': styleOf(to) };
  if (listed(from) && !listed(to)) props['list!reference'] = null;
  return { pos1: at, pos2: at + 1, props, type: 2 };
}

/** What a save asks that a component cannot do, such as a value a table's column cannot take. */
export const NOTES_STRUCTURE = 'notes_structure';

const refused = () => new Error(NOTES_STRUCTURE);

function tableCells(text: string): string[] {
  const inner = text.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out = [''];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && inner[i + 1] === '|') { out[out.length - 1] += '\\|'; i++; }
    else if (inner[i] === '|') out.push('');
    else out[out.length - 1] += inner[i];
  }
  return out.map((c) => c.trim());
}

const channelOp = (component: string, channel: string, op: Doc): Doc =>
  ({ type: 'component', contents: { address: component, contents: { content: { address: channel, contents: op }, type: 'op' } } });
const attachedFile = (path: string, contents: string): Doc => ({ mode: '100644', path, type: 'Blob', value: { contents, encoding: 'utf-8' } });
const attachedTree = (path: string, entries: Doc[]): Doc => ({ mode: '040000', path, type: 'Tree', value: { entries } });
const directoryHeader = (storage: Doc) => JSON.stringify({ blobs: [], content: { ci: { csn: 0, ccIds: [] }, storage } });
const DIRECTORY = 'https://graph.microsoft.com/types/directory';
const attributes = (type: string) => JSON.stringify({ type, snapshotFormatVersion: '0.1', packageVersion: '3.7.0' });
const plainValue = (value: unknown): Doc => ({ type: 'Plain', value });
const fluidHandle = (url: string): Doc => ({ type: '__fluid_handle__', url });

function listFormats(family: number): string[] {
  return Array.from({ length: 9 }, (_, level) =>
    family === 1 ? `%cssClass-scriptor-listItem-marker-bullet;%cd${level % 3}` : family === 2 ? `%cd${level + 3}` : '%cb');
}

function attachChannel(page: string, channel: string, storage: Doc): Doc {
  const snapshot = { entries: [attachedFile('header', directoryHeader(storage)), attachedFile('.attributes', attributes(DIRECTORY))] };
  return { type: 'component', contents: { address: page, contents: { content: { id: channel, snapshot, type: DIRECTORY }, type: 'attach' } } };
}

/** A component holding one text channel, attached to the page's document. */
function attachStory(id: string, pkg: string, type: string, root: Doc, lines: readonly (readonly Run[])[], author: Doc): Doc {
  const storage: Doc = {
    ...root,
    defaultContentDirection: plainValue('ltr'),
    'text:nodeType': plainValue('StoryNode'),
    text: plainValue(fluidHandle(`/${id}/text`)),
  };
  const segments: Doc[] = [];
  let length = 0;
  for (const runs of lines) {
    for (const run of runs) {
      segments.push({ text: run.text, props: { ...markProps(run.marks), attribution: author } });
      length += run.text.length;
    }
    segments.push({ marker: { refType: 1 }, props: { attribution: author, markerId: uuid(), nodeType: 'Paragraph' } });
    length += 1;
  }
  const content = {
    chunkStartSegmentIndex: 0, chunkSegmentCount: segments.length, chunkLengthChars: length,
    totalLengthChars: length, totalSegmentCount: segments.length, chunkSequenceNumber: 0, segmentTexts: segments,
    headerMetadata: { orderedChunkMetadata: [{ id: 'header' }], sequenceNumber: 0, totalLength: length, totalSegmentCount: segments.length, minSequenceNumber: 0 },
  };
  const snapshot = { entries: [
    attachedFile('.component', JSON.stringify({ pkg, summaryFormatVersion: 2, isRootDataStore: false })),
    attachedTree('.channels', [
      attachedTree('root', [attachedFile('header', directoryHeader(storage)), attachedFile('.attributes', attributes(DIRECTORY))]),
      attachedTree('text', [
        attachedTree('content', [attachedFile('header', JSON.stringify(content))]),
        attachedFile('.attributes', attributes('https://graph.microsoft.com/types/mergeTree')),
      ]),
    ]),
  ] };
  return { type: 'attach', contents: { id, snapshot, type } };
}

/** A component holding only directories and arrays, in the shape Loop attaches. */
function attachStore(id: string, pkg: string, type: string, channels: Doc[]): Doc {
  const snapshot = { entries: [
    attachedFile('.component', JSON.stringify({ pkg, summaryFormatVersion: 2, isRootDataStore: false })),
    attachedTree('.channels', channels),
  ] };
  return { type: 'attach', contents: { id, snapshot, type } };
}

const TASK_PACKAGE = '"TasklistComponentType","@ms/tablero"';

/** Every id replaced, so each use of a template is a component of its own. */
function withFreshIds(template: string): string {
  const fresh = new Map<string, string>();
  return template.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
    let next = fresh.get(id);
    if (next === undefined) { next = uuid(); fresh.set(id, next); }
    return next;
  });
}

/** A template's components, and what reading them gives. */
function fromTemplate(template: string, tasks: boolean): { root: string; attaches: Doc[]; embedded: Embedded } | null {
  const document = obj(JSON.parse(withFreshIds(template)));
  const root = document.root;
  if (typeof root !== 'string') return null;
  const attaches = arr(document.attaches).map(obj);
  const store = new Store({});
  for (const attach of attaches) store.attach(attach);
  const replayed: Replayed = { stories: new Map(), keys: new Map(), channels: new Map() };
  for (const name of store.stories()) {
    const all = store.units(name);
    if (all !== null) replayed.stories.set(name, all.all);
  }
  const embedded = tableOf(store, replayed, listsIn(store), tasks ? taskTable(store, root) : root, tasks);
  return embedded === null ? null : { root, attaches, embedded };
}

const placeComponent = (at: number, id: string, author: Doc): Doc => ({ pos1: at, seg: { marker: { refType: 1 }, props: {
  attribution: author, markerId: uuid(), nodeType: 'FluidComponent', 'component!display': 'block',
  'content!locale': 'en-gb', 'component!url': fluidHandle(`/${id}`),
} }, type: 0 });

function attachQuote(id: string, lines: readonly (readonly Run[])[], author: Doc): Doc {
  const pkg = '["BlockQuoteComponentType"]';
  return attachStory(id, pkg, pkg, { defaultContentLocale: plainValue('en-gb') }, lines, author);
}

function attachCell(id: string, preset: string, typed: string, author: Doc): Doc {
  const root = {
    configuration: plainValue({ presetName: preset }),
    isTextBoxMode: plainValue(true),
    defaultContentLocale: plainValue('en-us'),
  };
  return attachStory(id, '["TableroComponentType","IRichTextData"]', 'IRichTextData', root, [parseInline(typed)], author);
}

const cellTypeProps = (preset: string): Doc => ({ initialConfig: {
  isTextBoxMode: true, disableGuestComponents: true, richTextServicesConfiguration: { presetName: preset },
} });

/** Aligns two lists of lines: what stays, what changed in place, what only one side has. */
function align(old: readonly string[], next: readonly string[]): [number | null, number | null][] {
  const n = old.length, m = next.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = old[i] === next[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: [number | null, number | null][] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && old[i] === next[j]) { out.push([i, j]); i++; j++; continue; }
    const i0 = i, j0 = j;
    while ((i < n || j < m) && !(i < n && j < m && old[i] === next[j])) {
      if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) i++;
      else j++;
    }
    const pairs = Math.min(i - i0, j - j0);
    for (let k = 0; k < pairs; k++) out.push([i0 + k, j0 + k]);
    for (let k = i0 + pairs; k < i; k++) out.push([k, null]);
    for (let k = j0 + pairs; k < j; k++) out.push([null, k]);
  }
  return out;
}

/** The operations of one save: new channels and components first, what refers to them after. */
class Plan {
  readonly attached: Doc[] = [];
  readonly ops: Doc[] = [];
  registry: string | null;
  /** Tasks to add to the list of a block, after an entry of its order. */
  readonly tasksAdded: { block: number; after: string | null; lines: Wanted[] }[] = [];
  readonly tasksRemoved: { block: number; line: TableLine }[] = [];
  readonly text: NotesText;
  readonly author: Doc;
  constructor(text: NotesText, author: Doc) {
    this.text = text;
    this.author = author;
    this.registry = text.listRegistry;
  }

  page(op: Doc): void { this.ops.push(channelOp(this.text.component, 'text', op)); }

  newList(family: number): string {
    const page = this.text.component;
    if (this.registry === null) {
      this.registry = uuid();
      this.attached.push(attachChannel(page, this.registry, { nodeType: plainValue('ListRegistry') }));
      this.attached.push(channelOp(page, 'root', { key: 'text:list!registry', path: '/', type: 'set', value: plainValue(fluidHandle(`/${page}/${this.registry}`)) }));
    }
    const list = `list!list-${uuid()}`;
    const channel = uuid();
    const storage: Doc = { nodeType: plainValue('List'), 'list!id': plainValue(list) };
    listFormats(family).forEach((format, level) => { storage[`list!itemFormat-${level}`] = plainValue(format); });
    this.attached.push(attachChannel(page, channel, storage));
    this.attached.push(channelOp(page, this.registry, { key: list, path: '/', type: 'set', value: plainValue(fluidHandle(`/${page}/${channel}`)) }));
    return list;
  }

  cell(cell: Cell, typed: string): void {
    const runs = parseInline(typed);
    if (inline(runs) === inline(cell.runs)) return;
    if (cell.id === null) throw refused();
    if (cell.end > 0) this.ops.push(channelOp(cell.id, 'text', { pos1: 0, pos2: cell.end, type: 1 }));
    for (const run of [...runs].reverse()) this.ops.push(channelOp(cell.id, 'text', insertText(0, run.text, run.marks, this.author)));
  }

  /** A task's row: the matrix, the order shown, then a cell per column in the
   *  shape each kind of column takes. */
  private taskRow(table: Table, position: number, after: string | null, wanted: Wanted): { entry: string; event: Doc } {
    const row = uuid(), entry = uuid();
    this.matrix(table, { pos1: position, seg: [1, -2147483648], type: 0, target: 'rows' });
    this.matrix(table, { type: 2, row: position, col: 0, fwwMode: false, value: { metadataProperties: { persistentData: {} }, id: row } });
    this.ops.push(channelOp(table.view, table.rowSequence, { type: 0, entryId: entry, value: row, ...(after === null ? {} : { insertAfterEntryId: after }) }));
    const title = taskTitle(inline(wanted.runs));
    const done = wanted.kind.t === 'check' && wanted.kind.done;
    for (const { position: column, definition } of table.definitions) {
      const kind = definition.type;
      const config = obj(obj(definition.dataTypeProps).initialConfig);
      const preset = obj(config.richTextServicesConfiguration).presetName;
      const storyRoot = { configuration: plainValue({ presetName: preset }), isTextBoxMode: plainValue(true), defaultContentLocale: plainValue('en-us') };
      let component: string | null = null;
      let shown = '';
      if (kind === 'ICheckboxRichText') {
        const text = uuid();
        component = uuid();
        this.attached.push(attachStory(text, `[${TASK_PACKAGE},"ICheckboxRichText","RichText"]`, 'RichText', storyRoot, [parseInline(title)], this.author));
        this.attached.push(attachStore(component, `[${TASK_PACKAGE},"ICheckboxRichText"]`, 'ICheckboxRichText', [attachedTree('root', [
          attachedFile('header', directoryHeader({ ConfigurationType: plainValue({
            checked: done, richTextUrl: '', type: 'CheckboxText', richTextComponentHandle: fluidHandle(`/${text}`),
            richTextServicesConfiguration: { presetName: preset }, contentDirection: 'ltr',
          }) })),
          attachedFile('.attributes', attributes(DIRECTORY)),
        ])]));
      } else if (kind === 'IRichTextData') {
        component = uuid();
        this.attached.push(attachStory(component, `[${TASK_PACKAGE},"IRichTextData"]`, 'IRichTextData', storyRoot, [[]], this.author));
      } else if (kind === 'ILabelData') {
        component = uuid();
        const selected = uuid();
        const id = arr(config.selectedLabelIds)[0];
        const name = obj(arr(config.values).find((v) => obj(v).id === id)).name;
        shown = typeof name === 'string' ? name : '';
        this.attached.push(attachStore(component, `[${TASK_PACKAGE},"ILabelData"]`, 'ILabelData', [
          attachedTree('root', [
            attachedFile('header', directoryHeader({
              contentLocaleKey: plainValue('en-us'),
              categoryIdKey: plainValue(config.categoryId),
              selectedValuesKey: plainValue(fluidHandle(`/${component}/${selected}`)),
              labelPresetsKey: plainValue({}),
              ...(table.labels === null ? {} : { labelComponentHandleKey: plainValue(fluidHandle(`/${table.labels}`)) }),
            })),
            attachedFile('.attributes', attributes(DIRECTORY)),
          ]),
          attachedTree(selected, [
            attachedFile('header', JSON.stringify({ dataArray: [{ entryId: uuid(), value: id, isDeleted: false }] })),
            attachedFile('.attributes', attributes('https://graph.microsoft.com/types/SharedArray')),
          ]),
        ]));
      }
      this.matrix(table, { type: 2, row: position, col: column, fwwMode: false, value: {
        value: { cellValue: shown, ...(component === null ? {} : { componentHandle: fluidHandle(`/${component}`) }) },
        cellDataTypeProps: { type: kind, initialConfig: config },
        attribution: this.author,
      } });
    }
    return { entry, event: { rowId: row, tableEventType: 'RowInserted', viewLayerType: 'CoreViewModel' } };
  }

  private signal(table: Table, events: Doc[]): void {
    if (events.length > 0 && table.signal !== null) {
      this.ops.push(channelOp(table.view, table.signal, { type: 'signal', metadata: { consumerMetadata: { editMode: 'edit' }, tableEventMetadata: events } }));
    }
  }

  /** Tasks added and removed, appended rows first: removing from the end moves none of them. */
  taskChanges(): void {
    const lists = new Set([...this.tasksAdded.map((a) => a.block), ...this.tasksRemoved.map((r) => r.block)]);
    for (const b of lists) {
      const e = this.text.blocks[b]!.embedded;
      if (e?.t !== 'tasks') continue;
      const events: Doc[] = [];
      let position = e.table.matrixRows;
      for (const added of this.tasksAdded.filter((a) => a.block === b)) {
        let after = added.after;
        for (const wanted of added.lines) {
          const row = this.taskRow(e.table, position++, after, wanted);
          after = row.entry;
          events.push(row.event);
        }
      }
      const gone = this.tasksRemoved.filter((r) => r.block === b).map((r) => r.line).sort((x, y) => y.position - x.position);
      for (const line of gone) {
        this.matrix(e.table, { pos1: line.position, pos2: line.position + 1, type: 1, target: 'rows' });
        this.ops.push(channelOp(e.table.view, e.table.rowSequence, { type: 1, entryId: line.entry }));
        events.push({ rowId: line.id, tableEventType: 'RowDeleted', viewLayerType: 'CoreViewModel' });
      }
      this.signal(e.table, events);
    }
  }

  /** A new task list on the page, with its tasks. */
  newTaskList(at: number, lines: readonly Wanted[]): void {
    const made = fromTemplate(NEW_TASK_LIST, true);
    if (made?.embedded.t !== 'tasks') throw refused();
    this.attached.push(...made.attaches);
    this.page(placeComponent(at, made.root, this.author));
    const { table } = made.embedded;
    let after: string | null = null;
    const events: Doc[] = [];
    lines.forEach((wanted, k) => {
      const row = this.taskRow(table, table.matrixRows + k, after, wanted);
      after = row.entry;
      events.push(row.event);
    });
    this.signal(table, events);
  }

  /** A new table on the page, sized and filled from the rows typed. */
  newTable(at: number, lines: readonly string[]): void {
    const made = fromTemplate(NEW_TABLE, false);
    if (made?.embedded.t !== 'table') throw refused();
    this.attached.push(...made.attaches);
    this.page(placeComponent(at, made.root, this.author));
    this.table(made.embedded.table, lines);
  }

  private matrix(table: Table, op: Doc): void { this.ops.push(channelOp(table.data, table.matrix, op)); }

  private newCell(table: Table, row: number, column: number, typed: string): void {
    const id = uuid();
    this.attached.push(attachCell(id, 'RichTextCell', typed, this.author));
    this.matrix(table, { type: 2, row, col: column, fwwMode: false, value: {
      value: { componentHandle: fluidHandle(`/${id}`), cellValue: '' },
      cellDataTypeProps: { type: 'IRichTextData', initialConfig: cellTypeProps('RichTextCell').initialConfig },
      attribution: this.author,
    } });
  }

  /** A table as typed: titles and cells edited in place, rows and columns added
   *  and removed the way Loop's editor does. Mirrors `Plan::table` in the desktop core. */
  table(table: Table, run: readonly string[]): void {
    const isSeparator = (l: string) => { const c = tableCells(l); return c.length > 0 && c.every((x) => /^[-:]+$/.test(x)); };
    const typed = run.filter((l) => !isSeparator(l)).map(tableCells);
    if (typed.length === 0) throw refused();
    const width = Math.max(...typed.map((r) => r.length));
    for (const row of typed) while (row.length < width) row.push('');
    const columns = align(table.grid[0]!.map(cellMarkdown), typed[0]!);
    const kept = columns.filter((c): c is [number, number] => c[0] !== null && c[1] !== null);
    const separator = '\u001f';
    const rows = align(
      table.grid.slice(1).map((row) => kept.map(([o]) => cellMarkdown(row[o]!)).join(separator)),
      typed.slice(1).map((row) => kept.map(([, n]) => row[n]!).join(separator)),
    );
    for (const [o, n] of kept) this.cell(table.grid[0]![o]!, typed[0]![n]!);
    for (const [o, k] of rows) {
      if (o !== null && k !== null) for (const [co, cn] of kept) this.cell(table.grid[o + 1]![co]!, typed[k + 1]![cn]!);
    }
    const events: Doc[] = [];
    let after: string | null = null;
    const positions = new Array<number>(width).fill(0);
    let added = 0;
    columns.forEach(([o, n], index) => {
      if (o !== null && n !== null) { positions[n] = table.columns[o]!.position; after = table.columns[o]!.entry; return; }
      if (n === null) return;
      const position = table.matrixColumns + added++;
      positions[n] = position;
      const column = uuid(), title = uuid(), entry = uuid();
      if (table.counter !== null) this.ops.push(channelOp(table.data, table.counter, { type: 'increment', incrementAmount: 1 }));
      this.matrix(table, { pos1: position, seg: [1, -2147483648], type: 0, target: 'cols' });
      this.attached.push(attachCell(title, 'TableHeaderCell', typed[0]![n]!, this.author));
      this.matrix(table, { type: 2, row: 0, col: position, fwwMode: false, value: {
        type: 'IRichTextData', titleType: 'IRichTextData', id: column,
        title: { componentHandle: fluidHandle(`/${title}`), cellValue: typed[0]![n] },
        dataTypeProps: cellTypeProps('RichTextCell'), titleDataTypeProps: cellTypeProps('TableHeaderCell'),
      } });
      this.ops.push(channelOp(table.view, table.columnSequence, { type: 0, entryId: entry, value: column, ...(after === null ? {} : { insertAfterEntryId: after }) }));
      after = entry;
      if (table.viewBag !== null) {
        this.ops.push(channelOp(table.view, table.viewBag, { subdirName: column, path: '/columnViewDataPropertyBag', type: 'createSubDirectory' }));
        for (const [key, value] of [['width', 170], ['minWidth', 56], ['widthRatio', 1]] as const) {
          this.ops.push(channelOp(table.view, table.viewBag, { key, path: `/columnViewDataPropertyBag/${column}`, type: 'set', value: plainValue(value) }));
        }
      }
      for (const [ro, k] of rows) if (ro !== null && k !== null) this.newCell(table, table.rows[ro]!.position, position, typed[k + 1]![n]!);
      events.push({ columnId: column, columnIndex: index, tableEventType: 'ColumnInserted', viewLayerType: 'CoreViewModel' });
    });
    after = null;
    added = 0;
    rows.forEach(([o, k], index) => {
      if (o !== null && k !== null) { after = table.rows[o]!.entry; return; }
      if (k === null) return;
      const position = table.matrixRows + added++;
      const row = uuid(), entry = uuid();
      this.matrix(table, { pos1: position, seg: [1, -2147483648], type: 0, target: 'rows' });
      this.matrix(table, { type: 2, row: position, col: 0, fwwMode: false, value: { metadataProperties: { persistentData: {} }, id: row } });
      this.ops.push(channelOp(table.view, table.rowSequence, { type: 0, entryId: entry, value: row, ...(after === null ? {} : { insertAfterEntryId: after }) }));
      after = entry;
      positions.forEach((column, n) => this.newCell(table, position, column, typed[k + 1]![n]!));
      events.push({ rowId: row, rowIndex: index, tableEventType: 'RowInserted', viewLayerType: 'CoreViewModel' });
    });
    const remove = (lines: readonly TableLine[], target: 'rows' | 'cols', sequence: string, event: Doc) => {
      for (const l of [...lines].sort((a, b) => b.position - a.position)) {
        this.matrix(table, { pos1: l.position, pos2: l.position + 1, type: 1, target });
        this.ops.push(channelOp(table.view, sequence, { type: 1, entryId: l.entry }));
        events.push({ ...event, [target === 'rows' ? 'rowId' : 'columnId']: l.id, viewLayerType: 'CoreViewModel' });
      }
    };
    remove(rows.filter(([o, k]) => o !== null && k === null).map(([o]) => table.rows[o!]!), 'rows', table.rowSequence, { tableEventType: 'RowDeleted' });
    remove(columns.filter(([o, n]) => o !== null && n === null).map(([o]) => table.columns[o!]!), 'cols', table.columnSequence, { tableEventType: 'ColumnDeleted' });
    this.signal(table, events);
  }
}

type OldLine = { text: string; block: number; part: Part };

/** The operations turning the page into `markdown`, valid against the version
 *  read: within a channel in descending position, new channels and components
 *  before what refers to them. Mirrors `rv_teams::notes::edit`. */
export function notesEdit(text: NotesText, markdown: string, author: Doc): Doc[] {
  const blocks = text.blocks;
  const wanted = parse(markdown);
  const canon = (l: string) => l.replace(/^(\s*)\d+\. /, '$11. ');
  const old: OldLine[] = blocks.flatMap((block, i) => linesOf(block).map((l) => ({ text: canon(l.text), block: i, part: l.part })));
  const next = wanted.map((w) => canon(w.kind.t === 'tableRow'
    ? w.runs[0]?.text ?? ''
    : line({ kind: w.kind, runs: w.runs, start: 0, marker: 0, props: null })));
  const n = old.length, m = next.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = old[i]!.text === next[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  type Hunk = [number, number, number, number];
  const raw: Hunk[] = [];
  {
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && old[i]!.text === next[j]) { i++; j++; continue; }
      const i0 = i, j0 = j;
      while ((i < n || j < m) && !(i < n && j < m && old[i]!.text === next[j])) {
        if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) i++;
        else j++;
      }
      raw.push([i0, i, j0, j]);
    }
  }
  // Within a hunk, a line pairs with the next one it could become.
  const fits = (l: OldLine, kind: Kind) => {
    const e = blocks[l.block]!.embedded;
    if (l.part.t === 'page') return kind.t !== 'tableRow';
    if (l.part.t === 'story') return e?.t === 'story' && sameKind(e.kind, kind);
    if (l.part.t === 'row' || l.part.t === 'separator') return kind.t === 'tableRow';
    return kind.t === 'check';
  };
  let hunks: Hunk[] = [];
  for (const [i0, i1, j0, j1] of raw) {
    let j = j0;
    for (let i = i0; i < i1; i++) {
      let found = -1;
      for (let f = j; f < j1; f++) if (fits(old[i]!, wanted[f]!.kind)) { found = f; break; }
      if (found >= 0) {
        if (found > j) hunks.push([i, i, j, found]);
        hunks.push([i, i + 1, found, found + 1]);
        j = found + 1;
      } else hunks.push([i, i + 1, j, j]);
    }
    if (j < j1) hunks.push([i1, i1, j, j1]);
  }
  // A table changes as a whole: it takes the run of typed rows one of its lines became.
  const matched = new Array<number | null>(n).fill(null);
  {
    let i = 0, j = 0, h = 0;
    while (i < n || j < m) {
      const hunk = hunks[h];
      if (hunk && hunk[0] === i && hunk[2] === j) {
        if (hunk[1] > hunk[0] && hunk[3] > hunk[2]) matched[hunk[0]] = hunk[2];
        i = hunk[1]; j = hunk[3]; h++;
        continue;
      }
      if (i < n && j < m) matched[i] = j;
      i++; j++;
    }
  }
  const tableRuns: { block: number; from: number; to: number }[] = [];
  blocks.forEach((block, b) => {
    if (block.embedded?.t !== 'table') return;
    let first: number | null = null;
    for (let i = 0; i < n && first === null; i++) if (old[i]!.block === b) first = matched[i] ?? null;
    if (first === null || wanted[first]!.kind.t !== 'tableRow') return;
    let from = first, to = first + 1;
    while (from > 0 && wanted[from - 1]!.kind.t === 'tableRow') from--;
    while (to < m && wanted[to]!.kind.t === 'tableRow') to++;
    tableRuns.push({ block: b, from, to });
  });
  const inRun = (j: number) => tableRuns.some((r) => j >= r.from && j < r.to);
  const inTable = (i: number) => tableRuns.some((r) => r.block === old[i]!.block);
  hunks = hunks.flatMap(([i0, i1, j0, j1]): Hunk[] => {
    if (i1 > i0) return inTable(i0) ? [] : [[i0, i1, j0, j1]];
    const parts: Hunk[] = [];
    for (let k = j0; k < j1;) {
      if (inRun(k)) { k++; continue; }
      let end = k;
      while (end < j1 && !inRun(end)) end++;
      parts.push([i0, i1, k, end]);
      k = end;
    }
    return parts;
  });
  // A component all of whose lines go is removed from the page whole.
  const gone = new Array<number>(blocks.length).fill(0);
  for (const [i0, i1, j0, j1] of hunks) {
    const pairs = Math.min(i1 - i0, j1 - j0);
    for (let k = i0 + pairs; k < i1; k++) gone[old[k]!.block]!++;
  }
  const whole = (b: number) => blocks[b]!.embedded !== undefined && gone[b] === linesOf(blocks[b]!).length;
  const last = blocks[blocks.length - 1];
  const pageEnd = last ? last.marker + (last.props ? 1 : 0) : 0;
  const plan = new Plan(text, author);
  for (const run of tableRuns) {
    const e = blocks[run.block]!.embedded;
    if (e?.t === 'table') plan.table(e.table, wanted.slice(run.from, run.to).map((w) => w.runs[0]?.text ?? ''));
  }
  const removedWhole = new Set<number>();
  for (const [i0, i1, j0, j1] of [...hunks].reverse()) {
    const pairs = Math.min(i1 - i0, j1 - j0);
    if (j1 - j0 > pairs) insertNew(plan, old, wanted, i0, i1, j0 + pairs, j1, pageEnd);
    for (let k = i1 - i0 - 1; k >= 0; k--) {
      const { block: b, part } = old[i0 + k]!;
      const block = blocks[b]!;
      const e = block.embedded;
      if (k >= pairs) {
        if (whole(b)) {
          if (!removedWhole.has(b)) { removedWhole.add(b); plan.page({ pos1: block.start, pos2: block.marker + 1, type: 1 }); }
          continue;
        }
        if (part.t === 'page') {
          const end = block.marker + (block.props ? 1 : 0);
          if (end > block.start) plan.page({ pos1: block.start, pos2: end, type: 1 });
        } else if (part.t === 'story' && e?.t === 'story') {
          const inner = e.blocks[part.at]!;
          plan.ops.push(channelOp(e.id, 'text', { pos1: inner.start, pos2: inner.marker + 1, type: 1 }));
        } else if (part.t === 'task' && e?.t === 'tasks') {
          plan.tasksRemoved.push({ block: b, line: e.tasks[part.at]!.row });
        } else throw refused();
        continue;
      }
      const w = wanted[j0 + k]!;
      if (part.t === 'page') rewritePageBlock(plan, block, w.kind, w.runs);
      else if (part.t === 'story' && e?.t === 'story') {
        if (!sameKind(e.kind, w.kind)) throw refused();
        const inner = e.blocks[part.at]!;
        if (!sameRuns(inner.runs, w.runs)) {
          if (inner.marker > inner.start) plan.ops.push(channelOp(e.id, 'text', { pos1: inner.start, pos2: inner.marker, type: 1 }));
          for (const run of [...w.runs].reverse()) plan.ops.push(channelOp(e.id, 'text', insertText(inner.start, run.text, run.marks, author)));
        }
      } else if (part.t === 'task' && e?.t === 'tasks' && w.kind.t === 'check') {
        const task = e.tasks[part.at]!;
        plan.cell(task.title, task.details.length > 0 ? taskTitle(inline(w.runs)) : inline(w.runs));
        if (w.kind.done !== task.done) {
          plan.ops.push(channelOp(task.checkbox, 'root', { key: 'ConfigurationType', path: '/', type: 'set', value: plainValue({ ...task.configuration, checked: w.kind.done }) }));
        }
      } else throw refused();
    }
  }
  plan.taskChanges();
  return [...plan.attached, ...plan.ops];
}

/** The lines a hunk adds: into the quote or code block they extend, else as new
 *  paragraphs where the hunk ends. A list item joins the list of its own kind
 *  right before it, or starts one; a run of quotes makes one quote component. */
function insertNew(plan: Plan, old: readonly OldLine[], wanted: readonly Wanted[], i0: number, i1: number, from: number, to: number, pageEnd: number): void {
  const blocks = plan.text.blocks;
  const author = plan.author;
  const added = wanted.slice(from, to);
  const previous = i1 > 0 ? old[i1 - 1]! : null;
  const before = previous === null ? null : blocks[previous.block]!.embedded;
  if (before?.t === 'story' && previous?.part.t === 'story' && added.every((w) => sameKind(w.kind, before.kind))) {
    const at = before.blocks[previous.part.at]!.marker + 1;
    for (const w of [...added].reverse()) {
      plan.ops.push(channelOp(before.id, 'text', { pos1: at, seg: { marker: { refType: 1 }, props: { attribution: author, markerId: uuid(), nodeType: 'Paragraph' } }, type: 0 }));
      for (const run of [...w.runs].reverse()) plan.ops.push(channelOp(before.id, 'text', insertText(at, run.text, run.marks, author)));
    }
    return;
  }
  const nextLine = old[i1];
  const listBefore = previous !== null && before?.t === 'tasks' ? previous.block : null;
  const listAfter = nextLine?.part.t === 'task' ? nextLine.block : null;
  const listBlock = listBefore ?? listAfter;
  if (listBlock !== null && added.every((w) => w.kind.t === 'check')) {
    const after = before?.t === 'tasks' && previous?.part.t === 'task' ? before.tasks[previous.part.at]!.row.entry : null;
    plan.tasksAdded.push({ block: listBlock, after, lines: added });
    return;
  }
  let at = pageEnd;
  if (i1 < old.length) {
    const nextBlock = old[i1]!.block;
    at = previous?.block === nextBlock ? blocks[nextBlock + 1]?.start ?? pageEnd : blocks[nextBlock]!.start;
  }
  const lists = new Map<number, string>();
  for (let index = from; index < to;) {
    const family = familyOf(wanted[index]!.kind);
    if (family === null) { index++; continue; }
    let end = index;
    while (end < to && familyOf(wanted[end]!.kind) === family) end++;
    const near = index === from && i0 > 0 || index === from && i1 > i0
      ? blocks[old[i1 > i0 ? i1 - 1 : i0 - 1]!.block]!
      : null;
    const joined = near !== null && near.embedded === undefined && familyOf(near.kind) === family ? listOf(near) : null;
    const list = joined ?? plan.newList(family);
    for (let e = index; e < end; e++) lists.set(e, list);
    index = end;
  }
  for (let k = to - 1; k >= from; k--) {
    const w = wanted[k]!;
    if (w.kind.t === 'quote') {
      let first = k;
      while (first > from && wanted[first - 1]!.kind.t === 'quote') first--;
      const id = uuid();
      plan.attached.push(attachQuote(id, wanted.slice(first, k + 1).map((q) => q.runs), author));
      plan.page(placeComponent(at, id, author));
      k = first;
      continue;
    }
    if (w.kind.t === 'tableRow') {
      let first = k;
      while (first > from && wanted[first - 1]!.kind.t === 'tableRow') first--;
      const lines = wanted.slice(first, k + 1).map((r) => r.runs[0]?.text ?? '');
      const cells = lines[1] === undefined ? [] : tableCells(lines[1]);
      if (cells.length > 0 && cells.every((c) => /^[-:]+$/.test(c))) {
        plan.newTable(at, lines);
        k = first;
        continue;
      }
      plan.page(insertMarker(at, { t: 'paragraph' }, null, author));
      plan.page(insertText(at, w.runs[0]?.text ?? '', plain, author));
      continue;
    }
    if (w.kind.t === 'check') {
      let first = k;
      while (first > from && wanted[first - 1]!.kind.t === 'check') first--;
      if (inline(wanted[first]!.runs).includes(TASK_DETAILS)) {
        plan.newTaskList(at, wanted.slice(first, k + 1));
        k = first;
        continue;
      }
    }
    plan.page(insertMarker(at, w.kind, lists.get(k) ?? null, author));
    for (const run of [...w.runs].reverse()) plan.page(insertText(at, run.text, run.marks, author));
  }
}

/** One paragraph of the page changed: its text, its style, its list, its tick. */
function rewritePageBlock(plan: Plan, block: Block, kind: Kind, runs: readonly Run[]): void {
  if (block.props !== null && !sameKind(kind, block.kind)) {
    const family = familyOf(kind);
    if (family !== null && family === familyOf(block.kind)) {
      const list = listOf(block);
      if (list !== null) plan.page({ pos1: block.marker, pos2: block.marker + 1, props: { 'list!reference': listProps(list, kind)['list!reference'] }, type: 2 });
    } else if (family !== null) {
      plan.page({ pos1: block.marker, pos2: block.marker + 1, props: { ...listProps(plan.newList(family), kind), 'style!reference': null }, type: 2 });
    } else plan.page(restyle(block.marker, kind, block.kind));
  }
  const ticked = (k: Kind) => k.t === 'check' && k.done;
  if (!sameRuns(block.runs, runs)) {
    if (block.marker > block.start) plan.page({ pos1: block.start, pos2: block.marker, type: 1 });
    for (const run of [...runs].reverse()) {
      plan.page(insertText(block.start, run.text, { ...run.marks, struck: run.marks.struck || ticked(kind) }, plan.author));
    }
  } else if (ticked(kind) !== ticked(block.kind) && block.marker > block.start) {
    plan.page({ pos1: block.start, pos2: block.marker, props: { 'format!textDecoration': ticked(kind) ? ['strikethrough'] : null }, type: 2 });
  }
}

/** The error a save answers when the page moved on since it was read. */
export const NOTES_SAVE_CONFLICT = 'revision_conflict';

type Socket = {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
};
type SocketFactory = (url: string) => Socket;

const defaultSocket: SocketFactory = (url) => {
  const Ctor = (globalThis as unknown as { WebSocket: new (url: string, protocols?: string[], options?: unknown) => Socket }).WebSocket;
  // React Native takes headers as a third argument; browsers and Node ignore it.
  return new Ctor(url, [], { headers: { Origin: 'https://teams.microsoft.com' } });
};

/** Submits `ops` to the page through Fluid's delta stream, as Loop's editor
 *  does: socket.io on the session's `/fluid` namespace, `connect_document` in
 *  write mode, `submitOp` once our join is sequenced. Resolves with the
 *  sequence number of our last op; someone else's edit meanwhile rejects with
 *  `NOTES_SAVE_CONFLICT`. Mirrors `rv_teams::notes::submit`. */
export function notesSubmit(session: Doc, push: string, read: NotesText, ops: readonly Doc[], open: SocketFactory = defaultSocket): Promise<number> {
  const socketUrl = typeof session.deltaStreamSocketUrl === 'string' ? session.deltaStreamSocketUrl : '';
  const id = typeof session.id === 'string' ? session.id : '';
  const tenant = typeof session.runtimeTenantId === 'string' ? session.runtimeTenantId : typeof session.tenantId === 'string' ? session.tenantId : '';
  if (!socketUrl || !id || !tenant) return Promise.reject(new Error('notes_join_shape'));
  const token = typeof session.socketToken === 'string' && session.socketToken ? session.socketToken : push;
  const url = new URL(socketUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/socket.io/';
  url.search = '?EIO=4&transport=websocket';
  return new Promise((resolve, reject) => {
    const ws = open(url.toString());
    let me: string | null = null;
    let joined = false;
    let sent = 0, acked = 0, sequenced = 0, lastSeen = read.sequence;
    let done = false;
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (error) reject(error); else resolve(sequenced);
    };
    const timer = setTimeout(() => finish(new Error('notes_socket_timeout')), 30_000);
    const emit = (event: string, ...args: unknown[]) => ws.send(`42/fluid,${JSON.stringify([event, ...args])}`);
    const observe = (message: Doc) => {
      const seq = num(message.sequenceNumber) ?? 0;
      if (seq <= read.sequence) return;
      lastSeen = Math.max(lastSeen, seq);
      if (message.type === 'join') {
        let joiner: unknown = null;
        try { joiner = typeof message.data === 'string' ? obj(JSON.parse(message.data)).clientId : null; } catch { joiner = null; }
        if (me !== null && joiner === me) joined = true;
      } else if (message.type === 'op' && message.clientId !== me) {
        finish(new Error(NOTES_SAVE_CONFLICT));
      }
    };
    ws.onerror = () => finish(new Error('notes_socket'));
    ws.onclose = () => finish(new Error('notes_socket_closed'));
    ws.onmessage = ({ data }) => {
      const text = typeof data === 'string' ? data : '';
      if (text.startsWith('0')) { ws.send('40/fluid,'); return; }
      if (text === '2') { ws.send('3'); return; }
      if (text.startsWith('44/fluid')) { finish(new Error('notes_socket_refused')); return; }
      if (text.startsWith('40/fluid')) {
        emit('connect_document', {
          client: { details: { capabilities: { interactive: true }, environment: '; rocket-vibe' }, mode: 'write', permission: [], scopes: [], user: { id: '' } },
          id, mode: 'write', tenantId: tenant, token,
          versions: ['^0.4.0', '^0.3.0', '^0.2.0', '^0.1.0'], driverVersion: '3.7.0', nonce: uuid(),
          supportedFeatures: { api_get_ops: true, submit_signals_v2: true },
        });
        return;
      }
      if (!text.startsWith('42/fluid,')) return;
      let event: unknown[];
      try { event = arr(JSON.parse(text.slice('42/fluid,'.length))); } catch { return; }
      const name = event[0];
      if (name === 'connect_document_success') {
        const details = obj(event[1]);
        if (details.mode === 'read') { finish(new Error('notes_read_only')); return; }
        me = typeof details.clientId === 'string' ? details.clientId : null;
        for (const m of arr(details.initialMessages)) observe(obj(m));
      } else if (name === 'connect_document_error') {
        finish(new Error('notes_connect'));
        return;
      } else if (name === 'nack') {
        finish(new Error('notes_nack'));
        return;
      } else if (name === 'op') {
        for (const m of arr(event[2]).map(obj)) {
          observe(m);
          if (me !== null && m.clientId === me && m.type === 'op') { acked++; sequenced = Math.max(sequenced, num(m.sequenceNumber) ?? 0); }
        }
      }
      if (done || me === null || !joined) return;
      if (sent === 0) {
        const messages = ops.map((contents, n) => ({
          contents: JSON.stringify(contents),
          referenceSequenceNumber: lastSeen, type: 'op', clientSequenceNumber: n + 1,
        }));
        sent = messages.length;
        emit('submitOp', me, [messages]);
      }
      if (sent > 0 && acked >= sent) finish(null);
    };
  });
}
