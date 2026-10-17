/**
 * Choice of a message's markdown tree, and its flattening to plain text.
 *
 * The server pre-parses every message into `msg.md`: the preferred source,
 * guaranteed consistent with what other clients show. **But `md` is missing
 * from old messages** (older than its introduction) and could be corrupted in
 * the database: falling back to a local `parse()` is not optional, it is the
 * contract of step 4.3.
 *
 * Pure module, no React: the choice logic and the flattening are testable under
 * Node. The nested <Text> rendering lives in `ui/markdown.tsx`.
 */

import { parse, type Inlines, type Root } from '@rocket.chat/message-parser';

import { withoutQuoteLinks } from './quote.ts';
import { unicodeOfShortcode } from './emojis.ts';

export type { Root };

/**
 * The character of an `EMOJI` node, or `null` if it is not one.
 *
 * The server delivers either `unicode` (the author typed the glyph) or an
 * UNVALIDATED `shortCode`: the parser accepts `:anything:`. So this is where,
 * and nowhere else, "emoji or not" is decided: rendering uses it to refuse to
 * enlarge a `BIG_EMOJI` that is not one.
 */
export function emojiUnicode(node: unknown): string | null {
  if (typeof node !== 'object' || node === null) return null;
  const n = node as { type?: unknown; unicode?: unknown; shortCode?: unknown };
  if (n.type !== 'EMOJI') return null;
  if (typeof n.unicode === 'string') return n.unicode;
  if (typeof n.shortCode === 'string') return unicodeOfShortcode(n.shortCode);
  return null;
}

/** A plausible node: an object with a string `type`. Anything else is poison. */
function plausibleNode(n: unknown): boolean {
  return typeof n === 'object' && n !== null && typeof (n as { type?: unknown }).type === 'string';
}

/** A shortcode with a letter beyond ASCII (Slack's custom `:göring:`), which the parser leaves as text. */
const ACCENTED_EMOJI = /:([\p{L}\p{N}_+-]*(?![\x00-\x7f])\p{L}[\p{L}\p{N}_+-]*):/gu;

/** `EMOJI` nodes for those shortcodes inside plain text; everything else as parsed. */
export function accentedEmoji(nodes: unknown): unknown {
  if (Array.isArray(nodes)) return nodes.flatMap((n) => splitPlain(n) ?? [accentedEmoji(n)]);
  if (typeof nodes !== 'object' || nodes === null) return nodes;
  const node = nodes as { type?: unknown; value?: unknown };
  if (node.type === 'CODE' || node.type === 'INLINE_CODE' || !Array.isArray(node.value)) return node;
  return { ...node, value: accentedEmoji(node.value) };
}

function splitPlain(node: unknown): unknown[] | null {
  const n = node as { type?: unknown; value?: unknown };
  if (n?.type !== 'PLAIN_TEXT' || typeof n.value !== 'string' || !ACCENTED_EMOJI.test(n.value)) return null;
  ACCENTED_EMOJI.lastIndex = 0;
  const out: unknown[] = [];
  let last = 0;
  for (const m of n.value.matchAll(ACCENTED_EMOJI)) {
    if (m.index > last) out.push({ type: 'PLAIN_TEXT', value: n.value.slice(last, m.index) });
    out.push({ type: 'EMOJI', value: { type: 'PLAIN_TEXT', value: m[1] }, shortCode: m[1] });
    last = m.index + m[0].length;
  }
  if (last < n.value.length) out.push({ type: 'PLAIN_TEXT', value: n.value.slice(last) });
  return out;
}

/**
 * A GFM pipe table, which `@rocket.chat/message-parser` does not know:
 * Mattermost and Slack integrations post them. Built here, from text parsed
 * locally only, and drawn by `ui/markdown.tsx` as a grid.
 */
export type TableAlign = 'left' | 'center' | 'right' | null;
export type TableCell = { type: 'TABLE_CELL'; value: Inlines[] };
export type TableRow = { type: 'TABLE_ROW'; header: boolean; value: TableCell[] };
export type Table = { type: 'TABLE'; align: TableAlign[]; value: TableRow[] };

export function isTable(node: unknown): node is Table {
  return typeof node === 'object' && node !== null && (node as { type?: unknown }).type === 'TABLE' && Array.isArray((node as { value?: unknown }).value);
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const DELIMITER = /^\s*:?-+:?\s*$/;

function rowCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function alignments(header: string, delimiter: string): TableAlign[] | null {
  if (!header.includes('|') || !delimiter.includes('|')) return null;
  const cells = rowCells(delimiter);
  if (cells.length !== rowCells(header).length || !cells.every((c) => DELIMITER.test(c))) return null;
  return cells.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
}

function cellInlines(cell: string): Inlines[] {
  if (cell === '') return [];
  const plain: Inlines[] = [{ type: 'PLAIN_TEXT', value: cell }];
  try {
    const blocks = parse(cell) as unknown[];
    const inlines = blocks.flatMap((block): Inlines[] => {
      const b = block as { type?: unknown; value?: unknown };
      if ((b.type === 'PARAGRAPH' || b.type === 'BIG_EMOJI') && Array.isArray(b.value)) return b.value as Inlines[];
      return b.type === 'LINE_BREAK' ? [] : plain;
    });
    return accentedEmoji(inlines) as Inlines[];
  } catch {
    return plain;
  }
}

function table(lines: string[], align: TableAlign[]): Table {
  const row = (line: string, header: boolean): TableRow => {
    const cells = rowCells(line);
    return { type: 'TABLE_ROW', header, value: align.map((_, i) => ({ type: 'TABLE_CELL', value: cellInlines(cells[i] ?? '') })) };
  };
  return { type: 'TABLE', align, value: [row(lines[0]!, true), ...lines.slice(2).map((l) => row(l, false))] };
}

/** The text cut into tables and the runs of text around them; `null` without a table. */
export function splitTables(text: string): ({ text: string } | { table: Table })[] | null {
  if (!text.includes('|')) return null;
  const lines = text.split('\n');
  const out: ({ text: string } | { table: Table })[] = [];
  let run: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    while (run.length > 0 && run[0]!.trim() === '') run.shift();
    while (run.length > 0 && run[run.length - 1]!.trim() === '') run.pop();
    if (run.length > 0) out.push({ text: run.join('\n') });
    run = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const opening = FENCE.exec(line)?.[1] ?? null;
    if (fence !== null) {
      if (opening !== null && opening[0] === fence[0] && opening.length >= fence.length) fence = null;
      run.push(line);
      continue;
    }
    const align = opening === null && i + 1 < lines.length ? alignments(line, lines[i + 1]!) : null;
    if (align === null) {
      if (opening !== null) fence = opening;
      run.push(line);
      continue;
    }
    let end = i + 2;
    while (end < lines.length && lines[end]!.trim() !== '' && lines[end]!.includes('|') && !FENCE.test(lines[end]!)) end++;
    flush();
    out.push({ table: table(lines.slice(i, end), align) });
    i = end - 1;
  }
  if (out.length === 0) return null;
  flush();
  return out;
}

function parsed(text: string): Root {
  try {
    return accentedEmoji(parse(text)) as Root;
  } catch {
    // The parser (generated PEG grammar) may throw on input it does not
    // consume: raw text beats a dead screen.
    return [{ type: 'PARAGRAPH', value: [{ type: 'PLAIN_TEXT', value: text }] }];
  }
}

function localTree(text: string): Root {
  const chunks = splitTables(text);
  if (chunks === null) return parsed(text);
  return chunks.flatMap((chunk) => ('table' in chunk ? [chunk.table] : (parsed(chunk.text) as unknown[]))) as unknown as Root;
}

export function messageTree(md: string | null, text: string | null): Root | null {
  // A quote's permalink (`[ ](…?msg=…)`) is stripped from the body: the quote
  // renders separately (`message_link` attachment), and for an optimistic send,
  // as the local preview. A message that was ONLY the quote returns null.
  const stripped = (tree: Root): Root | null => {
    const filter = withoutQuoteLinks(tree);
    return filter.length > 0 ? filter : null;
  };
  if (md !== null) {
    try {
      const tree = JSON.parse(md) as Root;
      // The shape of the ELEMENTS matters as much as the array's: a `[null]`
      // or a node without `type` would reach rendering and crash the whole
      // screen, durably, since `md` is persisted. Re-parsing the text is
      // better: the content survives.
      if (Array.isArray(tree) && tree.length > 0 && tree.every(plausibleNode)) {
        return stripped(tree);
      }
    } catch {
      // Unreadable `md`: fall back to the text, as if it did not exist.
    }
  }
  if (text !== null && text.trim() !== '') return stripped(localTree(text));
  return null;
}

/**
 * Plain text of a node, recursively. The last-resort fallback: a node type the
 * renderer does not know must show its content, not disappear.
 */
export function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && node !== null) {
    const obj = node as {
      type?: unknown;
      value?: unknown;
      shortCode?: unknown;
      unicode?: unknown;
      fallback?: unknown;
    };
    if (obj.type === 'TABLE' && Array.isArray(obj.value)) return obj.value.map(textOf).join('\n');
    if (obj.type === 'TABLE_ROW' && Array.isArray(obj.value)) return obj.value.map(textOf).join(' | ');
    if (obj.type === 'EMOJI') {
      const glyph = emojiUnicode(obj);
      // Unknown short code (server custom emoji, typo): the literal is
      // readable, a white square is not.
      if (glyph !== null) return glyph;
      if (typeof obj.shortCode === 'string') return `:${obj.shortCode}:`;
    }
    if (typeof obj.unicode === 'string') return obj.unicode;
    const byValue = 'value' in obj ? textOf(obj.value) : '';
    if (byValue !== '') return byValue;
    // TIMESTAMP (and the like): `value` is an opaque object, but the parser
    // provides `fallback`, a Plain node meant for exactly this case.
    if ('fallback' in obj) return textOf(obj.fallback);
  }
  return '';
}

function online(node: unknown): string {
  if (Array.isArray(node)) return node.map(online).join('');
  if (typeof node !== 'object' || node === null) return textOf(node);
  const n = node as { type?: unknown; value?: unknown };
  const value = n.value as { src?: unknown; label?: unknown } | undefined;
  switch (n.type) {
    case 'LINK': {
      const label = online(value?.label ?? []).trim();
      return label !== '' ? label : textOf(value?.src);
    }
    case 'MENTION_USER':
      return `@${textOf(n.value)}`;
    case 'MENTION_CHANNEL':
      return `#${textOf(n.value)}`;
    case 'CODE':
    case 'QUOTE':
      return Array.isArray(n.value) ? n.value.map(online).join(' ') : textOf(n.value);
    case 'UNORDERED_LIST':
    case 'ORDERED_LIST':
    case 'TASKS':
      return Array.isArray(n.value)
        ? n.value.map((item) => `• ${online((item as { value?: unknown }).value)}`).join(' ')
        : '';
    case 'BIG_EMOJI':
      return Array.isArray(n.value) ? n.value.map(textOf).join(' ') : textOf(n.value);
    case 'LINE_BREAK':
      return ' ';
    case 'TABLE':
      return Array.isArray(n.value)
        ? n.value
            .map((row) => (Array.isArray((row as { value?: unknown }).value) ? ((row as { value: unknown[] }).value) : []).map(online).filter((cell) => cell.trim() !== '').join(' | '))
            .join(' · ')
        : '';
    case 'EMOJI':
    case 'PLAIN_TEXT':
      return textOf(node);
    default:
      return 'value' in n ? online(n.value) : textOf(node);
  }
}

/**
 * How an `@username` mention reads: under the person's name when the server
 * names people apart from usernames (`names`, Mattermost), else as written.
 * A sentence's punctuation the parser kept (`@bob.`) stays after the name.
 */
export function mentionOf(written: string, names: ReadonlyMap<string, string>): { username: string; label: string } {
  if (written === 'all' || written === 'here' || written === 'channel' || names.size === 0) return { username: written, label: `@${written}` };
  const trail = /[._-]+$/.exec(written)?.[0] ?? '';
  for (const [username, rest] of [[written, ''], [written.slice(0, written.length - trail.length), trail]] as const) {
    const name = names.get(username) ?? names.get(username.toLowerCase());
    if (username !== '' && name !== undefined) return { username, label: `@${name}${rest}` };
  }
  return { username: written, label: `@${written}` };
}

/** A message on one line, without syntax: the room list preview. */
export function textPreview(text: string): string {
  const tree = messageTree(null, text);
  if (tree === null) return text;
  return tree.map(online).join(' ').replace(/\s+/g, ' ').trim();
}
