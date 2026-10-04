/**
 * Lecture React de l'activité réseau de fond (indicateur « mise à jour… »).
 * `useSyncExternalStore` : le moteur est un magasin volatil, pas de SQLite —
 * même mécanique que `usePresence`.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { useSync } from './sync.tsx';

const RIEN = () => {};

/**
 * `true` tant qu'un fetch de fond est en vol pour cette portée : `'global'`
 * pour le rattrapage à l'ouverture de l'app, un `rid` pour l'historique d'un
 * salon. `false` hors phase « pret » — l'écran plein de chargement couvre ce cas.
 */
export function useActivity(cle: string): boolean {
  const synchro = useSync();
  const activite = synchro.phase === 'ready' ? synchro.activity : null;

  // Identités STABLES (cf. usePresence) : un `subscribe` recréé à chaque rendu
  // ferait désabonner/réabonner l'en-tête à chaque re-rendu.
  const abonner = useCallback(
    (relire: () => void) => (activite === null ? RIEN : activite.onChange(relire)),
    [activite],
  );
  const lire = useCallback(
    () => (activite === null ? false : activite.active(cle)),
    [activite, cle],
  );
  return useSyncExternalStore(abonner, lire);
}
