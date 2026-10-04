/**
 * Collapsed sections of the room list: same pattern as the language
 * (`ui/i18n.ts`), a module-level store read SYNCHRONOUSLY at load, so that the
 * first render is already collapsed. Device-wide.
 */

import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

import { readMovedKeySync, STORED_KEYS } from '../lib/storageKeys.ts';

import {
  type SectionKey,
  toggleSection,
  writeCollapsedSections,
  readCollapsedSections,
} from './homeSections.ts';

const KEY = STORED_KEYS.collapsedSections;

function read(): ReadonlySet<SectionKey> {
  try {
    return readCollapsedSections(
      readMovedKeySync(
        {
          get: (k) => SecureStore.getItem(k),
          set: (k, v) => SecureStore.setItem(k, v),
          remove: (k) => SecureStore.deleteItemAsync(k).catch(() => {}),
        },
        KEY,
      ),
    );
  } catch {
    return new Set();
  }
}

let collapsed = read();
const listeners = new Set<() => void>();

export function toggleCollapsedSection(key: SectionKey): void {
  collapsed = toggleSection(collapsed, key);
  void SecureStore.setItemAsync(KEY.key, writeCollapsedSections(collapsed)).catch(() => {});
  for (const e of listeners) e();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useCollapsedSections(): ReadonlySet<SectionKey> {
  return useSyncExternalStore(subscribe, () => collapsed);
}
