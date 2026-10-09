/**
 * "Hide the server rail": same pattern as the collapsed sections
 * (`ui/collapsedSections.ts`), read SYNCHRONOUSLY at load so the first render
 * already has the right layout. Device-wide, off by default; switching and
 * adding a server stay reachable from Settings > Accounts.
 */

import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

const KEY = 'hide-server-rail';

function read(): boolean {
  try {
    return SecureStore.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let hidden = read();
const listeners = new Set<() => void>();

export function setServerRailHidden(value: boolean): void {
  hidden = value;
  const write = value ? SecureStore.setItemAsync(KEY, '1') : SecureStore.deleteItemAsync(KEY);
  void write.catch(() => {});
  for (const e of listeners) e();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useServerRailHidden(): boolean {
  return useSyncExternalStore(subscribe, () => hidden);
}
