/**
 * React view of background network activity (the "updating…" indicator).
 * `useSyncExternalStore`: the engine is a volatile store, not SQLite, same
 * mechanics as `usePresence`.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { useSync } from './sync.tsx';

const NOTHING = () => {};

/**
 * `true` while a background fetch is in flight for this scope: `'global'`
 * for the catch-up at app start, a `rid` for a room's history. `false` outside
 * the `ready` phase: the full loading screen covers that case.
 */
export function useActivity(key: string): boolean {
  const sync = useSync();
  const activity = sync.phase === 'ready' ? sync.activity : null;

  // STABLE identities (see usePresence): a `subscribe` recreated on every render
  // would unsubscribe/resubscribe the header on every re-render.
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
