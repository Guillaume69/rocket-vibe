/**
 * Transferts de pièces jointes en cours (enregistrer, partager), et leur
 * progression. Un magasin au niveau module : l'action se lance depuis une
 * feuille qui se referme aussitôt, mais sa progression s'affiche sur la ligne
 * du message, qui l'écoute par la même clé (le chemin serveur du fichier).
 */

import { useCallback, useSyncExternalStore } from 'react';

/** Fraction 0..1, ou `null` tant que la taille totale est inconnue. */
export type Progress = number | null;

let inProgress = new Map<string, Progress>();
const subscribers = new Set<() => void>();

function publish(key: string, value: Progress | undefined): void {
  const next = new Map(inProgress);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  inProgress = next;
  for (const subscriber of subscribers) subscriber();
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

/** `undefined` : aucun transfert en cours pour ce fichier. */
export function useProgress(key: string | null): Progress | undefined {
  const read = useCallback(() => (key === null ? undefined : inProgress.get(key)), [key]);
  return useSyncExternalStore(subscribe, read);
}

/**
 * Lance un transfert sous cette clé. Un second lancement pendant le premier
 * est ignoré : deux téléchargements vers la même destination s'écraseraient.
 * Rend `false` dans ce cas.
 */
export async function transfer(
  key: string,
  work: (onProgress: (p: Progress) => void) => Promise<void>,
): Promise<boolean> {
  if (inProgress.has(key)) return false;
  publish(key, null);
  try {
    await work((p) => publish(key, p));
  } finally {
    publish(key, undefined);
  }
  return true;
}

/** « 37 % », ou « … » tant que la taille est inconnue. */
export function progressLabel(p: Progress): string {
  return p === null ? '…' : `${Math.round(p * 100)} %`;
}
