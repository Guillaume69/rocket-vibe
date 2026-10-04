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

export function farFromLatest(decalage: number, hauteurVue: number): boolean {
  return hauteurVue > 0 && decalage > hauteurVue;
}

export function onBackToLatestScroll(
  etat: BackToLatestState,
  decalage: number,
  hauteurVue: number,
): BackToLatestState {
  const loin = farFromLatest(decalage, hauteurVue);
  if (etat.backInProgress) return loin ? etat : INITIAL_BACK_TO_LATEST_STATE;
  return etat.visible === loin ? etat : { visible: loin, backInProgress: false };
}

export function onBackToLatestPress(): BackToLatestState {
  return { visible: false, backInProgress: true };
}

export function onBackToLatestSwipe(etat: BackToLatestState): BackToLatestState {
  return etat.backInProgress ? { ...etat, backInProgress: false } : etat;
}
