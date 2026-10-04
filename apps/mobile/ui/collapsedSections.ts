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

const CLE = 'sections-repliees';

function lire(): ReadonlySet<SectionKey> {
  try {
    return readCollapsedSections(SecureStore.getItem(CLE));
  } catch {
    return new Set();
  }
}

let repliees = lire();
const ecouteurs = new Set<() => void>();

export function toggleCollapsedSection(cle: SectionKey): void {
  repliees = toggleSection(repliees, cle);
  void SecureStore.setItemAsync(CLE, writeCollapsedSections(repliees)).catch(() => {});
  for (const e of ecouteurs) e();
}

function sabonner(cb: () => void): () => void {
  ecouteurs.add(cb);
  return () => {
    ecouteurs.delete(cb);
  };
}

export function useCollapsedSections(): ReadonlySet<SectionKey> {
  return useSyncExternalStore(sabonner, () => repliees);
}
