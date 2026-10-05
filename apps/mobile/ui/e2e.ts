/**
 * Hook observing the E2EE lock. `E2EEngine` notifies its listeners on every
 * transition; `useSyncExternalStore` reflects `isUnlocked` in the render
 * without duplicated React state.
 */

import { useSyncExternalStore } from 'react';

import type { E2EEngine } from '../lib/e2e/engine.ts';

export function useE2EUnlocked(e2e: E2EEngine | null): boolean {
  return useSyncExternalStore(
    (cb) => (e2e === null ? () => {} : e2e.subscribe(cb)),
    () => e2e !== null && e2e.isUnlocked,
  );
}
