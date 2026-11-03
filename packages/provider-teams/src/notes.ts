/**
 * A chat's Notes tab: a Loop page in SharePoint Embedded, read whole and turned
 * into markdown. Its text is a Fluid merge-tree: the summary in the latest
 * snapshot, then the operations sequenced since, replayed in order. Saving
 * rewrites the paragraphs that changed through Fluid's delta stream (`save.ts`).
 * Mirrors `rv_teams::notes` in the desktop core.
 */

type Doc = Record<string, unknown>;
type Props = Record<string, unknown>;

/** The system message Teams posts when a chat's notes are created; its text is the page's address. */
export const NOTES_CREATED = 'rv-notes-created';

export type NotesPage = { host: string; drive: string; item: string };

export type NotesText = { markdown: string; sequence: number; updatedBy: string | null; updatedAt: number | null; component: string; blocks: Block[] };

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

function units(segment: unknown): Unit[] {
  if (typeof segment === 'string') return Array.from({ length: segment.length }, (_, i) => ({ code: segment.charCodeAt(i), props: {} }));
  const s = obj(segment);
  const props = { ...obj(s.props) };
  if (s.marker !== undefined) return [{ marker: true, props }];
  const text = typeof s.text === 'string' ? s.text : '';
  return Array.from({ length: text.length }, (_, i) => ({ code: text.charCodeAt(i), props: { ...props } }));
}

function mergeOps(contents: Doc, component: string): Doc[] {
  if (contents.type === 'groupedBatch') return arr(contents.contents).flatMap((inner) => mergeOps(obj(obj(inner).contents), component));
  if (contents.type !== 'component') return [];
  const envelope = obj(contents.contents);
  const content = obj(obj(envelope.contents).content);
  return envelope.address === component && content.address === 'text' ? [obj(content.contents)] : [];
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

/** The page's text from its latest snapshot (JSON form) and operations fetched after it. */
export function readNotes(snapshot: Doc, later: readonly unknown[] = []): NotesText | null {
  const tree = obj(arr(snapshot.trees)[0]);
  const blobs = new Map(arr(snapshot.blobs).map((b) => [String(obj(b).id), obj(b)]));
  const blob = (id: string): string | null => {
    const b = blobs.get(id);
    if (!b || typeof b.content !== 'string') return null;
    return b.encoding === 'base64' ? decodeBase64(b.content) : b.content;
  };
  const entries = arr(tree.entries).map((e) => ({ path: String(obj(e).path ?? ''), id: String(obj(e).id ?? '') }));
  const headerEntry = entries.find((e) => e.path.endsWith('/.channels/text/content/header'));
  if (!headerEntry) return null;
  const component = headerEntry.path.replace(/^\.app\/\.channels\//, '').split('/')[0] ?? '';
  let header: Doc;
  try { header = obj(JSON.parse(blob(headerEntry.id) ?? 'null')); } catch { return null; }
  const folder = headerEntry.path.slice(0, -'header'.length);
  const meta = obj(header.headerMetadata);
  const chunks = arr(meta.orderedChunkMetadata).map((c) => String(obj(c).id ?? '')).filter(Boolean);
  const all: Unit[] = [];
  for (const chunk of chunks.length > 0 ? chunks : ['header']) {
    let body: Doc = header;
    if (chunk !== 'header') {
      const entry = entries.find((e) => e.path === `${folder}${chunk}`);
      try { body = entry ? obj(JSON.parse(blob(entry.id) ?? 'null')) : {}; } catch { body = {}; }
    }
    for (const segment of arr(body.segmentTexts)) all.push(...units(segment));
  }
  const base = num(meta.sequenceNumber) ?? 0;
  const lists = listsIn(snapshot, blob);
  const text: NotesText = { markdown: '', sequence: base, updatedBy: null, updatedAt: null, component, blocks: [] };
  const sequenced = [...arr(snapshot.ops), ...later].map(obj).sort((a, b) => sequenceOf(a) - sequenceOf(b));
  const seen = new Set<number>();
  for (const entry of sequenced) {
    const seq = sequenceOf(entry);
    if (seq <= base || seen.has(seq)) continue;
    seen.add(seq);
    const op = entry.op === undefined ? entry : obj(entry.op);
    let contents: Doc | null = null;
    try { contents = typeof op.contents === 'string' ? obj(JSON.parse(op.contents)) : null; } catch { contents = null; }
    if (contents !== null) {
      let changed = false;
      for (const merge of mergeOps(contents, component)) changed = apply(all, merge, text) || changed;
      if (changed) text.updatedAt = num(op.timestamp) ?? text.updatedAt;
    }
    text.sequence = Math.max(text.sequence, seq);
  }
  text.blocks = blocksOf(all, lists);
  text.markdown = render(text.blocks);
  return text;
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
  | { t: 'bullet'; level: number } | { t: 'numbered'; level: number } | { t: 'check'; level: number; done: boolean };

const listed = (k: Kind) => k.t === 'bullet' || k.t === 'numbered' || k.t === 'check';
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
  const level = levelOf(props);
  const list = textOf(props, 'list!reference');
  if (list !== null) {
    const format = lists.get(list)?.[level] ?? '';
    if (format.includes('%cb') || checkedOf(props)) return { t: 'check', level, done: checkedOf(props) };
    if (format.includes('%cd') && !format.includes('cssClass')) return { t: 'numbered', level };
    return { t: 'bullet', level };
  }
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
type Block = { kind: Kind; runs: Run[]; start: number; marker: number; props: Props | null };

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
  }
}

/** 1 bullets, 2 numbers, 3 checkboxes, native or written as text. */
function listFamily(block: Block): number | null {
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

function listsIn(snapshot: Doc, blob: (id: string) => string | null): Lists {
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
  for (const b of arr(snapshot.blobs)) {
    const text = blob(String(obj(b).id));
    if (text?.includes('list!id')) { try { walk(JSON.parse(text)); } catch { /* not JSON */ } }
  }
  return out;
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
    if ('marker' in unit) {
      flush();
      out.push({ kind: kindOf(unit.props, lists), runs, start, marker: pos, props: { ...unit.props } });
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
  let out = '';
  let previous: number | null | undefined;
  for (let i = 0; i < blocks.length;) {
    const block = blocks[i]!;
    const family = listFamily(block);
    if (previous !== undefined) out += family !== null && family === previous ? '\n' : '\n\n';
    if (block.kind.t === 'code') {
      const lines: string[] = [];
      while (i < blocks.length && blocks[i]!.kind.t === 'code') { lines.push(blockText(blocks[i]!)); i++; }
      out += `\`\`\`\n${lines.join('\n')}\n\`\`\``;
      previous = null;
      continue;
    }
    out += line(block);
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

type Wanted = { kind: Kind; runs: Run[]; prefix: string };

function parse(markdown: string): Wanted[] {
  const out: Wanted[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trimStart().startsWith('```')) {
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith('```'); i++) {
        out.push({ kind: { t: 'code' }, runs: [{ text: lines[i]!, marks: plain }], prefix: '' });
      }
      continue;
    }
    if (raw.trim() === '') continue;
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
    out.push({ kind, runs: parseInline(body), prefix: raw.slice(0, raw.length - body.length) });
  }
  return out;
}

/** What a paragraph is written as: a quote is a Loop component and a list
 *  needs one to join, so those stay readable as their markdown prefix. */
function written(w: Wanted, list: Block | null): { kind: Kind; runs: Run[] } {
  const prefixed = (prefix: string) => {
    const runs = w.runs.map((r) => ({ ...r }));
    if (runs[0] && sameMarks(runs[0].marks, plain)) runs[0].text = prefix + runs[0].text;
    else runs.unshift({ text: prefix, marks: plain });
    return { kind: { t: 'paragraph' } as Kind, runs };
  };
  if (w.kind.t === 'quote') return prefixed('> ');
  if (listed(w.kind) && list === null) return prefixed(w.prefix);
  return { kind: w.kind, runs: w.runs };
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

function insertMarker(at: number, kind: Kind, neighbour: Block | null, author: Doc): Doc {
  const props: Props = { attribution: author, markerId: uuid(), nodeType: 'Paragraph' };
  const style = styleOf(kind);
  if (style !== null) props['style!reference'] = style;
  if (listed(kind) && neighbour?.props) for (const [k, v] of Object.entries(neighbour.props)) if (k.startsWith('list!')) props[k] = v;
  return { pos1: at, seg: { marker: { refType: 1 }, props }, type: 0 };
}

function restyle(at: number, to: Kind, from: Kind): Doc {
  const props: Props = { 'style!reference': styleOf(to) };
  if (listed(from) && !listed(to)) props['list!reference'] = null;
  return { pos1: at, pos2: at + 1, props, type: 2 };
}

/** The merge-tree operations turning the page's blocks into `markdown`, in
 *  descending position so each is valid against the version read; paragraphs
 *  that render the same are left alone. Mirrors `rv_teams::notes::edit`. */
export function notesEdit(blocks: readonly Block[], markdown: string, author: Doc): Doc[] {
  const wanted = parse(markdown);
  const old = blocks.map(line);
  const fresh = wanted.map((w) => {
    const { kind, runs } = written(w, null);
    return sameKind(kind, w.kind) ? line({ kind, runs, start: 0, marker: 0, props: null }) : w.prefix + inline(w.runs);
  });
  const n = old.length, m = fresh.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = old[i] === fresh[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const hunks: [number, number, number, number][] = [];
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && old[i] === fresh[j]) { i++; j++; continue; }
    const i0 = i, j0 = j;
    while ((i < n || j < m) && !(i < n && j < m && old[i] === fresh[j])) {
      if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) i++;
      else j++;
    }
    hunks.push([i0, i, j0, j]);
  }
  const last = blocks[blocks.length - 1];
  const pageEnd = last ? last.marker + (last.props ? 1 : 0) : 0;
  const ops: Doc[] = [];
  for (const [i0, i1, j0, j1] of hunks.reverse()) {
    const pairs = Math.min(i1 - i0, j1 - j0);
    if (j1 - j0 > pairs) {
      const at = i1 < n ? blocks[i1]!.start : pageEnd;
      let neighbour: Block | null = null;
      for (let k = i1 - 1; k >= 0 && neighbour === null; k--) if (listed(blocks[k]!.kind)) neighbour = blocks[k]!;
      for (let k = j1 - 1; k >= j0 + pairs; k--) {
        const { kind, runs } = written(wanted[k]!, neighbour);
        ops.push(insertMarker(at, kind, neighbour, author));
        for (const r of [...runs].reverse()) ops.push(insertText(at, r.text, r.marks, author));
      }
    }
    for (let k = Math.max(i1 - i0, pairs) - 1; k >= 0; k--) {
      const block = blocks[i0 + k]!;
      if (k >= pairs) {
        const end = block.marker + (block.props ? 1 : 0);
        if (end > block.start) ops.push({ pos1: block.start, pos2: end, type: 1 });
        continue;
      }
      const { kind, runs } = written(wanted[j0 + k]!, listed(block.kind) ? block : null);
      if (!sameKind(kind, block.kind) && block.props && !(listed(kind) && listed(block.kind))) ops.push(restyle(block.marker, kind, block.kind));
      if (!sameRuns(block.runs, runs)) {
        if (block.marker > block.start) ops.push({ pos1: block.start, pos2: block.marker, type: 1 });
        for (const r of [...runs].reverse()) ops.push(insertText(block.start, r.text, r.marks, author));
      }
    }
  }
  return ops;
}

export type { Block as NotesBlock };

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
        const messages = ops.map((merge, n) => ({
          contents: JSON.stringify({ type: 'component', contents: { address: read.component, contents: { content: { address: 'text', contents: merge }, type: 'op' } } }),
          referenceSequenceNumber: lastSeen, type: 'op', clientSequenceNumber: n + 1,
        }));
        sent = messages.length;
        emit('submitOp', me, [messages]);
      }
      if (sent > 0 && acked >= sent) finish(null);
    };
  });
}
