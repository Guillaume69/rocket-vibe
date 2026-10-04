/**
 * Lecture React de l'activité réseau de fond (indicateur « mise à jour… »).
 * `useSyncExternalStore` : le moteur est un magasin volatil, pas de SQLite —
 * même mécanique que `usePresence`.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { useSync } from './sync.tsx';

const NOTHING = () => {};

/**
 * `true` tant qu'un fetch de fond est en vol pour cette portée : `'global'`
 * pour le rattrapage à l'ouverture de l'app, un `rid` pour l'historique d'un
 * salon. `false` hors phase « pret » — l'écran plein de chargement couvre ce cas.
 */
export function useActivity(key: string): boolean {
  const sync = useSync();
  const activity = sync.phase === 'ready' ? sync.activity : null;

  // Identités STABLES (cf. usePresence) : un `subscribe` recréé à chaque rendu
  // ferait désabonner/réabonner l'en-tête à chaque re-rendu.
  const subscribe = useCallback(
    (reread: () => void) => (activity === null ? NOTHING : activity.onChange(reread)),
    [activity],
  );
  const read = useCallback(
    () => (activity === null ? false : activity.active(key)),
    [activity, key],
  );
  return useSyncExternalStore(subscribe, read);
}
