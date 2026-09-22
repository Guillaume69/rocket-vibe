/**
 * Transferts de pièces jointes en cours (enregistrer, partager), et leur
 * progression. Un magasin au niveau module : l'action se lance depuis une
 * feuille qui se referme aussitôt, mais sa progression s'affiche sur la ligne
 * du message, qui l'écoute par la même clé (le chemin serveur du fichier).
 */

import { useCallback, useSyncExternalStore } from 'react';

/** Fraction 0..1, ou `null` tant que la taille totale est inconnue. */
export type Progression = number | null;

let enCours = new Map<string, Progression>();
const abonnes = new Set<() => void>();

function publier(cle: string, valeur: Progression | undefined): void {
  const suivant = new Map(enCours);
  if (valeur === undefined) suivant.delete(cle);
  else suivant.set(cle, valeur);
  enCours = suivant;
  for (const abonne of abonnes) abonne();
}

function abonner(abonne: () => void): () => void {
  abonnes.add(abonne);
  return () => {
    abonnes.delete(abonne);
  };
}

/** `undefined` : aucun transfert en cours pour ce fichier. */
export function useProgression(cle: string | null): Progression | undefined {
  const lire = useCallback(() => (cle === null ? undefined : enCours.get(cle)), [cle]);
  return useSyncExternalStore(abonner, lire);
}

/**
 * Lance un transfert sous cette clé. Un second lancement pendant le premier
 * est ignoré : deux téléchargements vers la même destination s'écraseraient.
 * Rend `false` dans ce cas.
 */
export async function transferer(
  cle: string,
  travail: (surProgression: (p: Progression) => void) => Promise<void>,
): Promise<boolean> {
  if (enCours.has(cle)) return false;
  publier(cle, null);
  try {
    await travail((p) => publier(cle, p));
  } finally {
    publier(cle, undefined);
  }
  return true;
}

/** « 37 % », ou « … » tant que la taille est inconnue. */
export function libelleProgression(p: Progression): string {
  return p === null ? '…' : `${Math.round(p * 100)} %`;
}
