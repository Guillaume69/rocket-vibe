/**
 * Collapsed sections of the room list, per account (`foldAccount`): same
 * pattern as the language (`ui/i18n.ts`), a module-level store read
 * SYNCHRONOUSLY at load, so that the first render is already collapsed.
 *
 * The device-wide folds of earlier versions seed every signed-in account once,
 * then go; until that sweep ends, an account without folds of its own reads
 * them.
 */

import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

import type { Session } from '../lib/auth.ts';
import { listKnownServers, readSession } from '../lib/sessionStore.ts';
import { FOLDS_BY_ACCOUNT_KEY, readMovedKeySync, STORED_KEYS } from '../lib/storageKeys.ts';

import {
  type FoldsByAccount,
  type SectionKey,
  foldAccount,
  readCollapsedSections,
  readFoldsByAccount,
  seedFolds,
  toggleSection,
  writeFoldsByAccount,
} from './homeSections.ts';

const NONE: ReadonlySet<SectionKey> = new Set();

function readDeviceWide(): ReadonlySet<SectionKey> | null {
  try {
    const raw = readMovedKeySync(
      {
        get: (k) => SecureStore.getItem(k),
        set: (k, v) => SecureStore.setItem(k, v),
        remove: (k) => SecureStore.deleteItemAsync(k).catch(() => {}),
      },
      STORED_KEYS.collapsedSections,
    );
    return raw === null ? null : readCollapsedSections(raw);
  } catch {
    return null;
  }
}

function readFolds(): FoldsByAccount {
  try {
    return readFoldsByAccount(SecureStore.getItem(FOLDS_BY_ACCOUNT_KEY));
  } catch {
    return new Map();
  }
}

let folds = readFolds();
let deviceWide = readDeviceWide();
const listeners = new Set<() => void>();

function save(next: FoldsByAccount): Promise<void> {
  folds = next;
  for (const e of listeners) e();
  return SecureStore.setItemAsync(FOLDS_BY_ACCOUNT_KEY, writeFoldsByAccount(folds));
}

const foldsOf = (account: string): ReadonlySet<SectionKey> => folds.get(account) ?? deviceWide ?? NONE;

export function toggleCollapsedSection(account: string, key: SectionKey): void {
  void save(new Map(folds).set(account, toggleSection(foldsOf(account), key))).catch(() => {});
}

/** Signing out: the account's folds go with it. */
export function forgetCollapsedSections(session: Pick<Session, 'baseUrl' | 'userId'>): void {
  const account = foldAccount(session.baseUrl, session.userId);
  if (!folds.has(account)) return;
  const next = new Map(folds);
  next.delete(account);
  void save(next).catch(() => {});
}

async function sweepDeviceWide(): Promise<void> {
  if (deviceWide === null) return;
  const sessions = await Promise.all((await listKnownServers()).map(readSession));
  const accounts = sessions.flatMap((s) => (s === null ? [] : [foldAccount(s.baseUrl, s.userId)]));
  if (accounts.length === 0 || deviceWide === null) return;
  await save(seedFolds(folds, accounts, deviceWide));
  deviceWide = null;
  await SecureStore.deleteItemAsync(STORED_KEYS.collapsedSections.key);
}

void sweepDeviceWide().catch(() => {});

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useCollapsedSections(account: string): ReadonlySet<SectionKey> {
  return useSyncExternalStore(subscribe, () => foldsOf(account));
}
