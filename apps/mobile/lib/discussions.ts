/** A message's first non-empty line, shortened: the suggested name of its discussion. */
export function suggestedName(text: string | undefined): string {
  const line = (text ?? '').split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
