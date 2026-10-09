import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
const KEY = 'experimental-providers';
let enabled = false;
try { enabled = SecureStore.getItem(KEY) === '1'; } catch { /* Locked vault: keep hidden. */ }
const listeners = new Set<() => void>();
export async function setExperimentalProviders(value: boolean): Promise<void> {
  if (value) await SecureStore.setItemAsync(KEY,'1'); else await SecureStore.deleteItemAsync(KEY);
  enabled = value; for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useExperimentalProviders(): boolean { return useSyncExternalStore(subscribe,() => enabled); }
