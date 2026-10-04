/**
 * Keystore (`expo-secure-store`) key names, derived here and nowhere else.
 *
 * Isolated in its own module, with no `expo` dependency, for the same reason
 * as `db/fileName.ts`: what decides the ISOLATION between accounts must be
 * proven by tests, not by rereading. The digest is injected (`Hasher`), so the
 * tests run under Node with `node:crypto` where the app uses `expo-crypto`.
 *
 * Two scopes, and that is the whole point:
 *
 * - the **session** is stored per SERVER. That is right: one session per
 *   server is meant to coexist, and the account is what is read from it.
 * - the **E2EE private key** is stored per (SERVER, ACCOUNT). It was not, and
 *   that was a real hole: at startup, `e2e.resume()` re-imported the previous
 *   account's key for the next account. The JWK being valid, the import
 *   SUCCEEDS, the app believes it is unlocked, and decrypting the room keys
 *   fails silently: "encrypted, read-only" with no visible path to the unlock
 *   screen.
 *
 * `expo-secure-store` only accepts `[A-Za-z0-9._-]` in its keys, while the URL
 * carries `:` and `/`. Hence the digest, truncated to 32 characters: 128 bits
 * of a SHA-256, far beyond what a collision between the few servers of one
 * device would require.
 */

import type { Hasher } from './auth.ts';

/**
 * The storage key, the "last server" pointer and the comparison in
 * `readSession` must reduce the URL EXACTLY the same way, otherwise a saved
 * session cannot be found at startup. A single source of truth.
 */
export const withoutTrailingSlash = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

/** A server's session key. Deliberately independent of the account. */
export async function sessionStorageKey(baseUrl: string, hash: Hasher): Promise<string> {
  return `session-${(await hash(withoutTrailingSlash(baseUrl))).slice(0, 32)}`;
}

/**
 * E2EE private key, specific to the (server, account) pair.
 *
 * The `|` separator can appear neither in a reduced URL nor in a Mongo id:
 * without it, `('https://x/a', 'b')` and `('https://x/ab', '')` would hash
 * the same.
 */
export async function e2eStorageKey(
  baseUrl: string,
  userId: string,
  hash: Hasher,
): Promise<string> {
  const fingerprint = await hash(`${withoutTrailingSlash(baseUrl)}|${userId}`);
  return `e2e-${fingerprint.slice(0, 32)}`;
}

/**
 * The OLD E2EE key, derived from the server alone.
 *
 * It is never read any more: reading it would replay exactly the defect being
 * fixed. It only serves to ERASE the orphaned entry: what it holds is a
 * **decrypted** RSA JWK, the app's most sensitive secret, and
 * `expo-secure-store` cannot enumerate its keys; without this derivation,
 * nothing could ever find it again to delete it.
 */
export async function legacyE2eStorageKey(baseUrl: string, hash: Hasher): Promise<string> {
  return `e2e-${(await hash(withoutTrailingSlash(baseUrl))).slice(0, 32)}`;
}

/**
 * The fixed keys, under their English names since migration 0016, and the
 * French name each had before. A value still under its old name is moved on
 * first read: the new name is written BEFORE the old one is deleted, so a kill
 * in between loses nothing.
 */
export const STORED_KEYS = {
  lastServer: { key: 'last-server', legacy: 'dernier-serveur' },
  knownServers: { key: 'known-servers', legacy: 'serveurs-connus' },
  devicePushToken: { key: 'device-push-token', legacy: 'jeton-push-appareil' },
  pendingLogouts: { key: 'pending-logouts', legacy: 'deconnexions-en-suspens' },
  collapsedSections: { key: 'collapsed-sections', legacy: 'sections-repliees' },
  preferredLanguage: { key: 'preferred-language', legacy: 'langue-preferee' },
} as const;

export type StoredKey = { readonly key: string; readonly legacy: string };

export type AsyncKeyStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

export type SyncKeyStore = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): unknown;
};

export async function readMovedKey(store: AsyncKeyStore, { key, legacy }: StoredKey): Promise<string | null> {
  const value = await store.get(key);
  if (value !== null) return value;
  const old = await store.get(legacy);
  if (old === null) return null;
  await store.set(key, old);
  await store.remove(legacy);
  return old;
}

export function readMovedKeySync(store: SyncKeyStore, { key, legacy }: StoredKey): string | null {
  const value = store.get(key);
  if (value !== null) return value;
  const old = store.get(legacy);
  if (old === null) return null;
  store.set(key, old);
  void store.remove(legacy);
  return old;
}
