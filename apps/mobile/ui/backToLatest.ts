/**
 * A room's "go to latest messages" button: visible once scrolled up more than
 * one screen into the history (inverted list, so the offset counts from the
 * newest).
 *
 * After a press, the animated scroll passes through offsets that are still
 * far: without `backInProgress`, the button would light up again for the
 * duration of the animation. A finger drag takes over and lifts the lock.
 */

export type BackToLatestState = { visible: boolean; backInProgress: boolean };

export const INITIAL_BACK_TO_LATEST_STATE: BackToLatestState = { visible: false, backInProgress: false };

export function farFromLatest(offset: number, viewHeight: number): boolean {
  return viewHeight > 0 && offset > viewHeight;
}

export function onBackToLatestScroll(
  state: BackToLatestState,
  offset: number,
  viewHeight: number,
): BackToLatestState {
  const far = farFromLatest(offset, viewHeight);
  if (state.backInProgress) return far ? state : INITIAL_BACK_TO_LATEST_STATE;
  return state.visible === far ? state : { visible: far, backInProgress: false };
}

export function onBackToLatestPress(): BackToLatestState {
  return { visible: false, backInProgress: true };
}

export function onBackToLatestSwipe(state: BackToLatestState): BackToLatestState {
  return state.backInProgress ? { ...state, backInProgress: false } : state;
}
