/**
 * Collapsed sections of the room list: same pattern as the language
 * (`ui/i18n.ts`), a module-level store read SYNCHRONOUSLY at load, so that the
 * first render is already collapsed. Device-wide.
 */

import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

import {
  type SectionKey,
  toggleSection,
  writeCollapsedSections,
  readCollapsedSections,
} from './homeSections.ts';

const KEY = 'sections-repliees';

function read(): ReadonlySet<SectionKey> {
  try {
    return readCollapsedSections(SecureStore.getItem(KEY));
  } catch {
    return new Set();
  }
}

let collapsed = read();
const listeners = new Set<() => void>();

export function toggleCollapsedSection(key: SectionKey): void {
  collapsed = toggleSection(collapsed, key);
  void SecureStore.setItemAsync(KEY, writeCollapsedSections(collapsed)).catch(() => {});
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
