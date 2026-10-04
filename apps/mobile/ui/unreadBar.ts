/**
 * The room screen's "new messages" bar: the PURE projection, extracted from
 * the component to be testable under Node (`app/` has no tests).
 *
 * Three conventions meet here, and their simultaneity is what made the logic
 * fragile while it lived in a screen's `useMemo`:
 *   1. the data is DESC (newest first): the OLDEST unread message is thus
 *      the LAST match of the predicate, not the first;
 *   2. the list is INVERTED on display: the item at index i+1 renders ABOVE
 *      item i, so inserting "after" places the bar above;
 *   3. my own messages do not count: posting in a room with unread backlog
 *      must not place the bar under my message.
 * An "optimization" with a `break` on the first match would place the bar
 * under the newest message, with no immediate symptom to tell.
 */

export type BarRow = { bar: true; id: string };

export const UNREAD_BAR_ID = 'unread-bar';

/**
 * `dataDesc`: the room's messages, newest to oldest.
 * `lastSeen`: the `ls` snapshot taken at mount; `undefined` (not read from
 * the database yet) or `null` (subscription without `ls`) return the list AS
 * IS, same reference: no bar without a read boundary.
 * `myUid`: `undefined` when `client.auth` is null; the "someone else's"
 * predicate can then exclude nothing and the bar may land above one of MY
 * messages: current behaviour, pinned by the tests.
 */
export function insertUnreadBar<M extends { id: string; ts: number; authorId: string }>(
  dataDesc: M[],
  lastSeen: number | null | undefined,
  myUid: string | undefined,
): (M | BarRow)[] {
  if (typeof lastSeen !== 'number') return dataDesc;
  let firstUnread = -1;
  for (let i = 0; i < dataDesc.length; i++) {
    const m = dataDesc[i];
    if (m.ts > lastSeen && m.authorId !== myUid) firstUnread = i;
  }
  if (firstUnread === -1) return dataDesc;
  return [
    ...dataDesc.slice(0, firstUnread + 1),
    { bar: true, id: UNREAD_BAR_ID },
    ...dataDesc.slice(firstUnread + 1),
  ];
}
