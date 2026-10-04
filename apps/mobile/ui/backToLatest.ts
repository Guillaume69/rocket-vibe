/**
 * Le bouton « aller aux derniers messages » d'un salon : visible dès qu'on est
 * remonté de plus d'un écran dans l'historique (liste inversée, le décalage se
 * compte donc depuis le plus récent).
 *
 * Après un appui, le défilement animé repasse par des décalages encore
 * lointains : sans `retourEnCours`, le bouton se rallumerait le temps de
 * l'animation. Un glissé du doigt reprend la main et lève le verrou.
 */

export type EtatRetour = { visible: boolean; retourEnCours: boolean };

export const ETAT_RETOUR_INITIAL: EtatRetour = { visible: false, retourEnCours: false };

export function loinDuPlusRecent(decalage: number, hauteurVue: number): boolean {
  return hauteurVue > 0 && decalage > hauteurVue;
}

export function surDefilementRetour(
  etat: EtatRetour,
  decalage: number,
  hauteurVue: number,
): EtatRetour {
  const loin = loinDuPlusRecent(decalage, hauteurVue);
  if (etat.retourEnCours) return loin ? etat : ETAT_RETOUR_INITIAL;
  return etat.visible === loin ? etat : { visible: loin, retourEnCours: false };
}

export function surAppuiRetour(): EtatRetour {
  return { visible: false, retourEnCours: true };
}

export function surGlisseRetour(etat: EtatRetour): EtatRetour {
  return etat.retourEnCours ? { ...etat, retourEnCours: false } : etat;
}
