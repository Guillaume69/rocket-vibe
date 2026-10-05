/**
 * Visual grouping of consecutive messages from the same author: the row that
 * CONTINUES the one above shows neither avatar nor header, just its body,
 * aligned on the gutter (as the Rocket.Chat and Discord clients do). PURE
 * projection, pulled out of the screens to be testable under Node;
 * `MessageRow` (prop `continuation`) turns the marking into compact rendering.
 *
 * A row is a "continuation" when NO break separates it from the message above:
 *   - different author;
 *   - more than `GROUP_WINDOW_MS` apart: without a time bound, a reply hours
 *     later would stick to yesterday's message with no landmark;
 *   - either is a SYSTEM message ("joined", video call...), except `e2e`,
 *     which renders like an ordinary message (decrypted, or its "encrypted
 *     message" stand-in) and so groups normally;
 *   - an inserted row ("new messages" bar, day separator): the first unread and
 *     the first message of the day keep their header, nothing splits a group
 *     into two anonymous halves. (The separator also catches the case the
 *     window lets through: 23:58 then 00:02.)
 */

/** 5 min, Rocket.Chat's default `Message_GroupingPeriod`. */
export const GROUP_WINDOW_MS = 5 * 60_000;

type Groupable = {
  id: string;
  authorId: string;
  ts: number;
  systemType: string | null;
};

/**
 * The ids of the rows that continue the message above. `order` says how to
 * read the array: the room screen projects DESC (`'newest-first'`, inverted
 * list), the thread screen ASC (`'oldest-first'`); the wrong order would group
 * messages under their NEXT one, not their predecessor.
 */
export function continuationIds(
  rows: readonly (Groupable | { id: string })[],
  order: 'newest-first' | 'oldest-first',
): Set<string> {
  const continuations = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const current = rows[i];
    const prev = rows[order === 'newest-first' ? i + 1 : i - 1];
    if (prev === undefined) continue;
    if (!isMessage(current) || !isMessage(prev)) continue;
    if (!groups(current) || !groups(prev)) continue;
    if (current.authorId !== prev.authorId) continue;
    if (current.ts - prev.ts > GROUP_WINDOW_MS) continue;
    continuations.add(current.id);
  }
  return continuations;
}

/**
 * Among `continuations`, the rows whose DISPLAYED time (hour:minute) is that
 * of the message above: their gutter stays empty. Same logic as for avatar
 * and username: information already on screen is not repeated. Within a
 * same-minute chain, comparing each row to its DIRECT predecessor is enough:
 * the last time rendered above is necessarily the chain's ("same minute" is
 * transitive).
 */
export function repeatedTimeIds(
  rows: readonly (Groupable | { id: string })[],
  order: 'newest-first' | 'oldest-first',
  continuations: ReadonlySet<string>,
): Set<string> {
  const repeated = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const current = rows[i];
    if (!continuations.has(current.id)) continue;
    const prev = rows[order === 'newest-first' ? i + 1 : i - 1];
    if (prev === undefined || !isMessage(current) || !isMessage(prev)) continue;
    if (shownMinute(current.ts) === shownMinute(prev.ts)) {
      repeated.add(current.id);
    }
  }
  return repeated;
}

/**
 * Two timestamps in the same EPOCH minute show the same hour:minute in any
 * time zone: all offsets (India +5:30, Nepal +5:45 included) are whole
 * multiples of a minute, so an epoch minute boundary stays a local minute
 * boundary. Comparing this value equals comparing the rendered string, without
 * depending on the formatter.
 */
function shownMinute(ms: number): number {
  return Math.floor(ms / 60_000);
}

function groups(m: Groupable): boolean {
  return m.systemType === null || m.systemType === 'e2e';
}

/** A message, as opposed to inserted rows (unread bar, day separator). */
function isMessage(l: Groupable | { id: string }): l is Groupable {
  return typeof (l as Groupable).authorId === 'string';
}
