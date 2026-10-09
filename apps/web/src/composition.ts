export function listBreak(
  value: string,
  cursor: number,
): { text: string; cursor: number } | undefined {
  const start = value.lastIndexOf("\n", cursor - 1) + 1,
    line = value.slice(start, cursor),
    match = /^(\s*)([-*+]|[0-9]+\.) (.*)$/.exec(line);
  if (!match) return;
  if (!match[3]) {
    const text = value.slice(0, start) + value.slice(cursor);
    return { text, cursor: start };
  }
  const marker = /^[0-9]/.test(match[2])
      ? String(Number.parseInt(match[2], 10) + 1) + "."
      : match[2],
    insert = "\n" + match[1] + marker + " ";
  return {
    text: value.slice(0, cursor) + insert + value.slice(cursor),
    cursor: cursor + insert.length,
  };
}
