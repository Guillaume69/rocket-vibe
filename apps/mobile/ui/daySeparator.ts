/**
 * Day separators in message lists: without them, "12:00" then "12:30" read as
 * half an hour apart when a whole day may have passed, since the time alone
 * does not carry the date. PURE projection, testable under Node; the
 * rendering (line + "Today" / "Yesterday" / date label) lives in `ui/kit.tsx`,
 * the label in `dayFormatter` (ui/messages.ts).
 *
 * A separator goes BETWEEN two loaded messages from different local days,
 * titled with the newer one's day, never above the oldest loaded one: the
 * history page not loaded yet may continue the same day, and a separator
 * there would lie once the page arrives. Non-message rows already inserted
 * ("new messages" bar) stay in place; at a shared boundary the separator goes
 * ABOVE the bar: the day is more structural than the read state.
 */

export type DayRow = { day: true; id: string; ts: number };

/** LOCAL calendar day (device time zone), comparable and sortable. */
export function dayKey(ms: number): number {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/**
 * `order`: like `continuationIds`, the room screen projects DESC
 * (`'newest-first'`), the thread screen ASC (`'oldest-first'`). Without a day
 * boundary, the SAME reference is returned: the screen's useMemo does not
 * re-render for nothing.
 */
export function insertDaySeparators<L extends { id: string }>(
  rows: L[],
  order: 'newest-first' | 'oldest-first',
): (L | DayRow)[] {
  const result: (L | DayRow)[] = [];
  let prev: { ts: number } | null = null;
  for (const row of rows) {
    if (isMessage(row)) {
      if (prev !== null && dayKey(row.ts) !== dayKey(prev.ts)) {
        // The separator is titled with the NEWER message's day at the boundary: the
        // one already pushed in DESC, the incoming one in ASC.
        const recent = order === 'newest-first' ? prev : row;
        result.push({
          day: true,
          id: `day-${dayKey(recent.ts)}`,
          ts: recent.ts,
        });
      }
      prev = row;
    }
    result.push(row);
  }
  return result.length === rows.length ? rows : result;
}

/** A message, as opposed to rows already inserted (unread bar). */
function isMessage<L extends { id: string }>(l: L): l is L & { ts: number } {
  return typeof (l as { ts?: unknown }).ts === 'number';
}
