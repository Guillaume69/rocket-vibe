/**
 * The composer's formatting buttons: Rocket.Chat markers toggled around the
 * selection, or before its lines. The desktop's rules, case for case
 * (`rv-core/src/compose.rs`: `toggle_wrap`, `toggle_lines`, `code_block`,
 * `link`), so a draft formats the same in every app.
 *
 * Positions are JS string indices (UTF-16 units), as `TextInput`'s selection.
 */

export type Edited = { text: string; start: number; end: number };

export type LineKind = 'quote' | 'heading' | 'bullet' | 'numbered';

function bounds(text: string, start: number, end: number): [number, number] {
  const s = Math.max(0, Math.min(start, text.length));
  return [s, Math.max(s, Math.min(end, text.length))];
}

/** `*bold*`, `_italic_`, `~strike~`, `` `code` ``: added, or removed from either side of the markers. */
export function toggleWrap(text: string, start: number, end: number, marker: string): Edited {
  const [s, e] = bounds(text, start, end);
  const n = marker.length;
  const outside = s >= n && e + n <= text.length && text.slice(s - n, s) === marker && text.slice(e, e + n) === marker;
  if (outside && s < e) {
    return { text: text.slice(0, s - n) + text.slice(s, e) + text.slice(e + n), start: s - n, end: e - n };
  }
  if (e - s >= 2 * n && text.slice(s, s + n) === marker && text.slice(e - n, e) === marker) {
    return { text: text.slice(0, s) + text.slice(s + n, e - n) + text.slice(e), start: s, end: e - 2 * n };
  }
  return { text: text.slice(0, s) + marker + text.slice(s, e) + marker + text.slice(e), start: s + n, end: e + n };
}

function linePrefix(kind: LineKind, number: number): string {
  return kind === 'quote' ? '> ' : kind === 'heading' ? '# ' : kind === 'bullet' ? '- ' : `${number}. `;
}

/** The prefix a line already has for `kind`, by length; `null` without. */
function hasPrefix(line: string, kind: LineKind): number | null {
  if (kind === 'numbered') {
    const m = /^\d+\. /.exec(line);
    return m === null ? null : m[0].length;
  }
  return line.startsWith(linePrefix(kind, 0)) ? 2 : null;
}

/** Quote, heading, bullets or numbers before every line the selection touches; removed when all have it. */
export function toggleLines(text: string, start: number, end: number, kind: LineKind): Edited {
  const [s, e] = bounds(text, start, end);
  const first = text.lastIndexOf('\n', s - 1) + 1;
  const next = text.indexOf('\n', e);
  const last = next === -1 ? text.length : next;
  const lines = text.slice(first, last).split('\n');
  const all = lines.every((l) => hasPrefix(l, kind) !== null);
  let shiftStart = 0;
  const replaced = lines.map((line, i) => {
    const length = hasPrefix(line, kind);
    let delta = 0;
    let out = line;
    if (all && length !== null) {
      out = line.slice(length);
      delta = -length;
    } else if (length === null) {
      const prefix = linePrefix(kind, i + 1);
      out = prefix + line;
      delta = prefix.length;
    }
    if (i === 0) shiftStart = delta;
    return out;
  }).join('\n');
  const total = replaced.length - (last - first);
  return {
    text: text.slice(0, first) + replaced + text.slice(last),
    start: Math.max(s + shiftStart, first),
    end: Math.max(e + total, first),
  };
}

/** The selection as a fenced code block, on lines of its own. */
export function codeBlock(text: string, start: number, end: number): Edited {
  const [s, e] = bounds(text, start, end);
  const before = s > 0 && text[s - 1] !== '\n' ? '\n' : '';
  const after = e < text.length && text[e] !== '\n' ? '\n' : '';
  const open = `${before}\`\`\`\n`;
  const inner = s + open.length;
  return {
    text: text.slice(0, s) + open + text.slice(s, e) + `\n\`\`\`${after}` + text.slice(e),
    start: inner,
    end: inner + (e - s),
  };
}

/** `[selection](https://)`, the address selected to be typed over. */
export function link(text: string, start: number, end: number): Edited {
  const [s, e] = bounds(text, start, end);
  const address = 'https://';
  const head = `${text.slice(0, s)}[${text.slice(s, e)}](`;
  return { text: `${head}${address})${text.slice(e)}`, start: head.length, end: head.length + address.length };
}
