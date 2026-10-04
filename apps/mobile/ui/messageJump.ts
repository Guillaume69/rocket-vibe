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

const targets = new Map<string, JumpTarget>();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

export function requestJump(rid: string, target: JumpTarget): void {
  targets.set(rid, target);
  notify();
}

export function consumeJump(rid: string, id: string): void {
  if (targets.get(rid)?.id === id && targets.delete(rid)) notify();
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => void subscribers.delete(subscriber);
}

export function useJump(rid: string): JumpTarget | null {
  return useSyncExternalStore(subscribe, () => targets.get(rid) ?? null);
}
