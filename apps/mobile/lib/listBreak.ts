/**
 * A new line typed in a markdown list continues it: the next bullet (`- `,
 * `* `) or number comes with the line break, and a break on an empty item
 * ends the list instead, removing that item. Outside an open code fence only.
 * The desktop's rule, case for case (`rv-core/src/compose.rs::list_break`).
 *
 * Positions are JS string indices (UTF-16 units), the unit `TextInput`'s
 * selection speaks. `null`: nothing to do, the plain line break stands.
 */
export function listBreak(text: string, cursor: number): { text: string; cursor: number } | null {
  const at = Math.max(0, Math.min(cursor, text.length));
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const nextBreak = text.indexOf('\n', lineStart);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  const fences = text
    .slice(0, lineStart)
    .split('\n')
    .filter((l) => l.trimStart().startsWith('```')).length;
  if (fences % 2 === 1) return null;
  const line = text.slice(lineStart, lineEnd);
  const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
  const rest = line.slice(indent.length);
  let markerLength: number;
  let next: string;
  if (rest.startsWith('- ') || rest.startsWith('* ')) {
    markerLength = 2;
    next = rest.slice(0, 2);
  } else {
    const numbered = /^(\d+)\. /.exec(rest);
    if (numbered === null) return null;
    markerLength = numbered[0].length;
    next = `${Number(numbered[1]) + 1}. `;
  }
  const bodyStart = lineStart + indent.length + markerLength;
  if (at < bodyStart) return null;
  if (text.slice(bodyStart, lineEnd).trim() === '') {
    return { text: text.slice(0, lineStart) + text.slice(lineEnd), cursor: lineStart };
  }
  const inserted = `\n${indent}${next}`;
  return { text: text.slice(0, at) + inserted + text.slice(at), cursor: at + inserted.length };
}

/**
 * Where `after` is `before` with ONE line break typed in, the position of that
 * break; else `null` (a paste, a deletion, autocorrect). The caret is tried
 * first, but it cannot be trusted alone: Android does not promise the order of
 * the text and selection events, and text an input method commits may move
 * the caret late or not at all (seen on the emulator). The difference itself
 * then says where; inside a run of breaks it cannot tell which one is new, and
 * takes the first, the break typed at the end of a line.
 */
export function typedBreak(before: string, after: string, cursor: number): number | null {
  if (after.length !== before.length + 1) return null;
  const at = (i: number) =>
    i >= 0 && after[i] === '\n' && after.slice(0, i) === before.slice(0, i) && after.slice(i + 1) === before.slice(i);
  if (at(cursor)) return cursor;
  if (at(cursor - 1)) return cursor - 1;
  let i = 0;
  while (i < before.length && before[i] === after[i]) i++;
  while (i > 0 && after[i - 1] === '\n') i--;
  return at(i) ? i : null;
}
