/**
 * Le bouton « aller aux derniers messages » d'un salon : visible dès qu'on est
 * remonté de plus d'un écran dans l'historique (liste inversée, le décalage se
 * compte donc depuis le plus récent).
 *
 * Après un appui, le défilement animé repasse par des décalages encore
 * lointains : sans `retourEnCours`, le bouton se rallumerait le temps de
 * l'animation. Un glissé du doigt reprend la main et lève le verrou.
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
