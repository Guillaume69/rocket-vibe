/**
 * Sections repliées de la liste des salons : même patron que la langue
 * (`ui/i18n.ts`), un store module-level lu de façon SYNCHRONE au chargement,
 * pour que le premier rendu soit déjà replié. Globale à l'appareil.
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
