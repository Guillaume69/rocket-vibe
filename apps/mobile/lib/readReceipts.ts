/**
 * Read receipts on a RocketVibe server (brain/features/read-receipts.md): the
 * pure rule every app follows. The live frame carries the other members' read
 * positions (`LiveRoom.reads`); the room screen shows, under MY most recent
 * confirmed root message, who read at least that far.
 *
 * Positions are canonical decimal strings that may exceed 2^53: they are
 * compared as text, a longer string being the greater one.
 */

export type ReceiptMark = { user_id: string; root_position: string };

/** What the receipt rule needs of a timeline row. */
export type ReceiptRow = {
  id: string;
  authorId: string;
  systemType?: string | null;
  threadId?: string | null;
};

export type ReceiptLine =
  | { kind: 'seen' }
  | { kind: 'seenBy'; names: string[]; others: number };

/** Names shown before "and N others". */
export const RECEIPT_NAMES = 3;

/** -1, 0 or 1, as numbers: a longer decimal string is greater, equal lengths compare as text. */
export function comparePositions(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * My most recent root message the server confirmed, from the rows newest
 * first: mine, not a system message, not a thread reply (even one also sent to
 * the room), with a server position (a deleted message has no row), not in the
 * outbox. `null` when there is none.
 */
export function receiptAnchor(
  rowsDesc: readonly ReceiptRow[],
  me: string,
  positions: ReadonlyMap<string, string>,
  pending: { has(id: string): boolean },
): { id: string; position: string } | null {
  for (const row of rowsDesc) {
    if (row.authorId !== me || row.systemType != null || row.threadId != null || pending.has(row.id)) continue;
    const position = positions.get(row.id);
    if (position !== undefined) return { id: row.id, position };
  }
  return null;
}

/** The marks that reached `position`, in the frame's order. */
export function readersAt(marks: readonly ReceiptMark[], position: string): ReceiptMark[] {
  return marks.filter((m) => comparePositions(m.root_position, position) >= 0);
}

/**
 * The line under that message: "Seen" in a direct room, else up to three
 * names (`name` gives the display name, else the username, `null` when the
 * frame has no profile for it: counted with the others), then how many more.
 * `null` when nobody read it.
 */
export function receiptLine(
  readers: readonly ReceiptMark[],
  direct: boolean,
  name: (uid: string) => string | null,
): ReceiptLine | null {
  if (readers.length === 0) return null;
  if (direct) return { kind: 'seen' };
  const names: string[] = [];
  for (const r of readers) {
    if (names.length === RECEIPT_NAMES) break;
    const n = name(r.user_id);
    if (n) names.push(n);
  }
  return { kind: 'seenBy', names, others: readers.length - names.length };
}

/** The whole rule: which message carries the line, and the line. */
export function readReceipt(input: {
  rowsDesc: readonly ReceiptRow[];
  me: string;
  positions: ReadonlyMap<string, string>;
  pending: { has(id: string): boolean };
  marks: readonly ReceiptMark[];
  direct: boolean;
  name: (uid: string) => string | null;
}): { messageId: string; line: ReceiptLine } | null {
  if (input.marks.length === 0) return null;
  const anchor = receiptAnchor(input.rowsDesc, input.me, input.positions, input.pending);
  if (anchor === null) return null;
  const line = receiptLine(readersAt(input.marks, anchor.position), input.direct, input.name);
  return line === null ? null : { messageId: anchor.id, line };
}
