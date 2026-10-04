/**
 * History pagination exhaustion predicates, extracted from `loadMore` (room
 * screen) to be testable under Node.
 *
 * They encode two lessons paid for in 429s:
 *
 *   - `inclusive: true` returns the bound AND all its twins of the same
 *     millisecond (bot burst, import). "The page holds more than one message"
 *     therefore does NOT prove it moved back: a group of ties at the tail of
 *     history kept `n > 1` forever, `passExhausted` never set, and
 *     re-ingestion re-triggered `onEndReached` (FlashList v2 re-arms it on
 *     EVERY data change), a self-sustaining loop until the 429. The only
 *     reliable criterion: a message STRICTLY older than the bound
 *     (`pageMovedBack`).
 *
 *   - And as a net independent of response content: if the bound message
 *     has not changed after two consecutive pages, pagination is no longer
 *     advancing, whatever the responses say (`advanceBound` + `boundIsStuck`).
 */

/** The current bound message and the number of pages requested ON that bound. */
export type PaginationBound = { id: string; pages: number };

/** Pages tolerated on a stuck bound before declaring the past exhausted. */
export const MAX_PAGES_AT_BOUND = 2;

/** On every page request: same bound → count; new bound → back to 1. */
export function advanceBound(
  previous: PaginationBound | null,
  oldestId: string,
): PaginationBound {
  return previous !== null && previous.id === oldestId
    ? { id: oldestId, pages: previous.pages + 1 }
    : { id: oldestId, pages: 1 };
}

/** True once the bound has used up its pages: the past is declared exhausted. */
export function boundIsStuck(bound: PaginationBound): boolean {
  return bound.pages > MAX_PAGES_AT_BOUND;
}

/**
 * True if the page REALLY moved back into the past: it holds a message
 * strictly older than the requested bound. `pageOldest` is `null` for an
 * empty page.
 */
export function pageMovedBack(
  pageOldest: number | null,
  horodatageBorne: number,
): boolean {
  return pageOldest !== null && pageOldest < horodatageBorne;
}
