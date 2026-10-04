/**
 * Saut vers un message — canal entre la liste des épinglés/favoris et l'écran
 * du salon resté dessous. Même famille que `ui/reply.ts` : la liste arme la
 * cible et se referme ; le salon, déjà monté, l'amène dans sa fenêtre, défile
 * jusqu'à elle, puis la consomme. Clé = `rid`. Mémoire seule.
 */

import { useSyncExternalStore } from 'react';

export type JumpTarget = {
  id: string;
  /** Pour savoir jusqu'où remonter l'historique quand le message n'est pas en base. */
  ts: number;
};

const cibles = new Map<string, JumpTarget>();
const abonnes = new Set<() => void>();

function notifier(): void {
  for (const abonne of abonnes) abonne();
}

export function requestJump(rid: string, cible: JumpTarget): void {
  cibles.set(rid, cible);
  notifier();
}

export function consumeJump(rid: string, id: string): void {
  if (cibles.get(rid)?.id === id && cibles.delete(rid)) notifier();
}

function abonner(abonne: () => void): () => void {
  abonnes.add(abonne);
  return () => void abonnes.delete(abonne);
}

export function useJump(rid: string): JumpTarget | null {
  return useSyncExternalStore(abonner, () => cibles.get(rid) ?? null);
}
