/**
 * A chat's Notes tab: a Loop page in SharePoint Embedded, read whole and turned
 * into markdown. Its text is a Fluid merge-tree: the summary in the latest
 * snapshot, then the operations sequenced since, replayed in order. Read-only.
 * Mirrors `rv_teams::notes` in the desktop core.
 */

type Doc = Record<string, unknown>;
type Props = Record<string, unknown>;

/** The system message Teams posts when a chat's notes are created; its text is the page's address. */
export const NOTES_CREATED = 'rv-notes-created';

export type NotesPage = { host: string; drive: string; item: string };

export type NotesText = { markdown: string; sequence: number; updatedBy: string | null; updatedAt: number | null };

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
  const text: NotesText = { markdown: '', sequence: base, updatedBy: null, updatedAt: null };
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
  text.markdown = markdown(all);
  return text;
}

function flag(props: Props, keys: readonly string[]): boolean {
  return keys.some((k) => {
    const v = props[k];
    return v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v !== '' && v !== 'false' && v !== '0');
  });
}

function link(props: Props): string | null {
  for (const k of ['link', 'hyperlink', 'href', 'url']) {
    const v = props[k];
    if (typeof v === 'string' && v) return v;
    const o = obj(v);
    const u = o.url ?? o.href;
    if (typeof u === 'string') return u;
  }
  return null;
}

const escaped = (text: string) => text.replace(/[\\*_[\]`]/g, (c) => `\\${c}`);

function inline(runs: { text: string; props: Props }[]): string {
  return runs.map(({ text, props }) => {
    if (text.trim() === '') return text;
    let out = escaped(text);
    if (flag(props, ['code', 'inlineCode'])) out = `\`${text.replace(/`/g, "'")}\``;
    if (flag(props, ['strikethrough', 'strike'])) out = `~~${out}~~`;
    if (flag(props, ['italic'])) out = `*${out}*`;
    if (flag(props, ['bold'])) out = `**${out}**`;
    const url = link(props);
    return url === null ? out : `[${out}](${url})`;
  }).join('');
}

function block(props: Props): { prefix: string; listed: boolean } {
  const kind = String(props.nodeType ?? 'Paragraph').toLowerCase();
  const level = ['indentLevel', 'listLevel', 'level'].map((k) => num(props[k])).find((v) => v !== null) ?? 0;
  const indent = '  '.repeat(Math.min(8, level));
  if (kind.includes('heading') || kind.includes('title')) {
    const digits = Number.parseInt(kind.replace(/\D/g, ''), 10);
    const n = Math.min(6, Math.max(1, num(props.headingLevel) ?? (Number.isNaN(digits) ? 1 : digits)));
    return { prefix: `${'#'.repeat(n)} `, listed: false };
  }
  if (kind.includes('check') || kind.includes('task') || kind.includes('todo')) {
    return { prefix: `${indent}- [${flag(props, ['checked', 'isChecked', 'completed', 'done']) ? 'x' : ' '}] `, listed: true };
  }
  if (kind.includes('number') || (kind.includes('ordered') && !kind.includes('unordered'))) return { prefix: `${indent}1. `, listed: true };
  if (kind.includes('list') || kind.includes('bullet')) return { prefix: `${indent}- `, listed: true };
  if (kind.includes('quote')) return { prefix: '> ', listed: false };
  if (kind.includes('code')) return { prefix: '```', listed: false };
  return { prefix: '', listed: false };
}

const sameProps = (a: Props, b: Props) => JSON.stringify(a) === JSON.stringify(b);

function markdown(all: readonly Unit[]): string {
  const blocks: { line: string; listed: boolean }[] = [];
  let runs: { text: string; props: Props }[] = [];
  let pending: number[] = [];
  let pendingProps: Props | null = null;
  const flush = () => {
    if (pending.length > 0) runs.push({ text: String.fromCharCode(...pending), props: pendingProps ?? {} });
    pending = [];
    pendingProps = null;
  };
  for (const unit of all) {
    if ('marker' in unit) {
      flush();
      const { prefix, listed } = block(unit.props);
      const body = inline(runs);
      runs = [];
      blocks.push({ line: prefix === '```' ? `\`\`\`\n${body}\n\`\`\`` : `${prefix}${body}`, listed });
    } else {
      if (pendingProps !== null && !sameProps(pendingProps, unit.props)) flush();
      pendingProps ??= unit.props;
      pending.push(unit.code);
    }
  }
  flush();
  if (runs.length > 0) blocks.push({ line: inline(runs), listed: false });
  let out = '';
  blocks.forEach(({ line, listed }, i) => {
    if (i > 0) out += listed && blocks[i - 1]!.listed ? '\n' : '\n\n';
    out += line;
  });
  return out.trim();
}
