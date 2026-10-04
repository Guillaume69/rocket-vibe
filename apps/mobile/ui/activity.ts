/**
 * Lecture React de l'activité réseau de fond (indicateur « mise à jour… »).
 * `useSyncExternalStore` : le moteur est un magasin volatil, pas de SQLite —
 * même mécanique que `usePresence`.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { useSynchro } from './sync.tsx';

const RIEN = () => {};

/**
 * `true` tant qu'un fetch de fond est en vol pour cette portée : `'global'`
 * pour le rattrapage à l'ouverture de l'app, un `rid` pour l'historique d'un
 * salon. `false` hors phase « pret » — l'écran plein de chargement couvre ce cas.
 */
export function useActivite(cle: string): boolean {
  const synchro = useSynchro();
  const activite = synchro.phase === 'pret' ? synchro.activite : null;

  // Identités STABLES (cf. usePresence) : un `subscribe` recréé à chaque rendu
  // ferait désabonner/réabonner l'en-tête à chaque re-rendu.
  const abonner = useCallback(
    (relire: () => void) => (activite === null ? RIEN : activite.surChangement(relire)),
    [activite],
  );
  const lire = useCallback(
    () => (activite === null ? false : activite.actif(cle)),
    [activite, cle],
  );
  return useSyncExternalStore(abonner, lire);
}
