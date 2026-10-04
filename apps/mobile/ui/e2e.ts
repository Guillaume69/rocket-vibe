/**
 * Hook d'observation du verrouillage E2EE. `MoteurE2E` notifie ses écouteurs à
 * chaque transition ; `useSyncExternalStore` reflète `estDeverrouille` dans le
 * rendu sans état React dupliqué.
 */

import { useSyncExternalStore } from 'react';

import type { MoteurE2E } from '../lib/e2e/engine.ts';

export function useE2EDeverrouille(e2e: MoteurE2E | null): boolean {
  return useSyncExternalStore(
    (cb) => (e2e === null ? () => {} : e2e.souscrire(cb)),
    () => e2e !== null && e2e.estDeverrouille,
  );
}
