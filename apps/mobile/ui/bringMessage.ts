/**
 * Brings a message into a room's local window before jumping to it.
 *
 * The room list projects SQLite through `ORDER BY timestamp DESC LIMIT n`: to
 * show a message, the database must contain it AND `n` must exceed its rank.
 * When it is missing from the database, we walk the history back page by
 * page from the oldest local message, never an isolated page around it,
 * which would leave an invisible gap between it and the rest of the list.
 * Bounded: each page is a REST request, and the route is limited to 10 per
 * minute.
 */

import { pageMovedBack } from './roomPagination.ts';

export const MAX_JUMP_PAGES = 4;

export async function bringMessage(options: {
  ts: number;
  /** Number of main-stream messages NEWER than the target, or `null` if it is not in the database. */
  rank: () => Promise<number | null>;
  /** Timestamp of the room's oldest local message, `null` if none. */
  older: () => Promise<number | null>;
  /** Loads the history page before `latest` (ms). */
  loadPage: (latest: number) => Promise<{ oldest: number | null }>;
  pagesMax?: number;
}): Promise<number | null> {
  const pagesMax = options.pagesMax ?? MAX_JUMP_PAGES;
  let rank = await options.rank();
  for (let page = 0; rank === null && page < pagesMax; page++) {
    const bound = await options.older();
    // Already scrolled back past the target without finding it: it is not in
    // the main stream (thread reply, deleted message). Loading more would
    // change nothing.
    if (bound === null || bound < options.ts) return null;
    const { oldest } = await options.loadPage(bound);
    rank = await options.rank();
    if (rank === null && !pageMovedBack(oldest, bound)) return null;
  }
  return rank;
}
