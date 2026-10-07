/**
 * The pill over the top of the room that jumps to the "new messages" bar
 * while the bar is above the view. Pure, so Node can test it.
 *
 * The data is DESC and the list inverted: a GREATER index renders HIGHER on
 * screen, so the bar is above the view when its index passes the last
 * visible one.
 */

import { UNREAD_BAR_ID } from './unreadBar.ts';

type Row = { id: string; authorId?: string; ts?: number };

export type UnreadSummary = {
  /** The bar's index in the list data. */
  barIndex: number;
  /** Messages from someone else newer than the bar. */
  count: number;
  /** The oldest unread message, right under the bar. */
  oldestTs: number | null;
};

export function unreadSummary(rows: readonly Row[], me: string | undefined): UnreadSummary | null {
  const barIndex = rows.findIndex((r) => r.id === UNREAD_BAR_ID);
  if (barIndex < 0) return null;
  let count = 0;
  let oldestTs: number | null = null;
  for (let i = 0; i < barIndex; i++) {
    const r = rows[i];
    if (r.authorId === undefined) continue;
    if (typeof r.ts === 'number') oldestTs = r.ts;
    if (r.authorId !== me) count++;
  }
  return { barIndex, count, oldestTs };
}

export type PillState = { seen: boolean; visible: boolean };

export const INITIAL_PILL_STATE: PillState = { seen: false, visible: false };

/**
 * Once the bar has been on screen (or scrolled past), the pill is done for
 * this visit. Without a measured range the state stays as it is.
 */
export function nextPillState(
  state: PillState,
  barIndex: number | null,
  range: { startIndex: number; endIndex: number } | undefined,
): PillState {
  if (state.seen) return state.visible ? { seen: true, visible: false } : state;
  if (barIndex === null) return state.visible ? INITIAL_PILL_STATE : state;
  if (range === undefined || range.startIndex < 0) return state;
  if (barIndex <= range.endIndex) return { seen: true, visible: false };
  return state.visible ? state : { seen: false, visible: true };
}

export function onPillPress(): PillState {
  return { seen: true, visible: false };
}
