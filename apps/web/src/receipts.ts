/**
 * Read receipts (Vibez): under my most recent root message, "Seen" in a
 * direct room, "Seen by Bob, Carol" in a group, from the live frame's
 * `reads`. The rule shared by every app: brain/features/read-receipts.md.
 */
import type { Message, ReadMark } from "./protocol";

/** Decimal positions compared as numbers, without leaving strings. */
export function atLeast(position: string, bound: string): boolean {
  return position.length !== bound.length
    ? position.length > bound.length
    : position >= bound;
}

export type Seen = { id: string; readers: string[] };

/** My latest confirmed root message and who read it, or nothing. */
export function seen(
  messages: Message[],
  mine: string,
  reads: ReadMark[] | undefined,
): Seen | undefined {
  if (!reads?.length) return undefined;
  const last = messages.findLast(
    (message) =>
      message.author.id === mine &&
      !message.system &&
      !message.deleted &&
      !message.reply_to,
  );
  if (!last) return undefined;
  const readers = reads
    .filter(
      (mark) =>
        mark.user_id !== mine && atLeast(mark.root_position, last.position),
    )
    .map((mark) => mark.user_id);
  return readers.length ? { id: last.id, readers } : undefined;
}

/**
 * "Seen", or "Seen by" up to three known names then "and 1 other" / "and N
 * others"; a reader without a known name is counted, never shown as an id,
 * and with no known name at all the line is "Seen".
 */
export function seenText(
  readers: string[],
  direct: boolean,
  name: (id: string) => string | undefined,
  words: {
    seen: string;
    seenBy: string;
    other: string;
    others: (n: number) => string;
  },
): string {
  const known = readers.map(name).filter((n): n is string => !!n);
  if (direct || !known.length) return words.seen;
  const shown = known.slice(0, 3);
  const rest = readers.length - shown.length;
  const tail = rest === 1 ? words.other : rest > 1 ? words.others(rest) : "";
  return words.seenBy + " " + shown.join(", ") + (tail ? " " + tail : "");
}
