/**
 * Hook d'observation du verrouillage E2EE. `MoteurE2E` notifie ses écouteurs à
 * chaque transition ; `useSyncExternalStore` reflète `estDeverrouille` dans le
 * rendu sans état React dupliqué.
 */

import { useSyncExternalStore } from 'react';

import type { E2EEngine } from '../lib/e2e/engine.ts';

export function useE2EUnlocked(e2e: E2EEngine | null): boolean {
  return useSyncExternalStore(
    (cb) => (e2e === null ? () => {} : e2e.subscribe(cb)),
    () => e2e !== null && e2e.isUnlocked,
  );
}
