/**
 * Session persistence, **one per server**.
 *
 * The token lives in the Android Keystore through `expo-secure-store`, never in
 * `AsyncStorage`. The key derives from the host: several servers coexist
 * without a logout on one touching the other.
 *
 * The only transport-layer module that depends on the platform. All the rest
 * (`rest`, `auth`, `ddp`) runs under Node, so it is tested for real.
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import type { Session } from './auth.ts';
import {
  type AsyncKeyStore,
  e2eStorageKey,
  legacyE2eStorageKey,
  readMovedKey,
  sessionStorageKey,
  STORED_KEYS,
  withoutTrailingSlash,
} from './storageKeys.ts';
import type { PendingLogout } from './deferredLogout.ts';
import { parsePendingLogouts, parseSession } from './storedRecords.ts';

/** Hex SHA-256: the app-side implementation of `Hasher`. */
export function hash(text: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);
}

/**
 * Key name derivation lives in `lib/storageKeys.ts`, with no `expo`
 * dependency, because it decides the isolation between accounts, and that is
 * proven by tests, not by a reread.
 */
const key = (baseUrl: string): Promise<string> => sessionStorageKey(baseUrl, hash);

const secureStore: AsyncKeyStore = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  remove: (k) => SecureStore.deleteItemAsync(k),
};

/**
 * iOS: readable by the Notification Service Extension, which also runs with
 * the screen locked (plugins/ios-notification-service). The default
 * `WHEN_UNLOCKED` would hide it from every push received with the phone in a
 * pocket. No effect on Android.
 */
const PUSH_EXTENSION_ACCESS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export async function saveSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(await key(session.baseUrl), JSON.stringify(session), PUSH_EXTENSION_ACCESS);
}

export async function readSession(baseUrl: string): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync(await key(baseUrl));
  if (raw === null) return null;
  return parseSession(raw, baseUrl);
}

export async function clearSession(baseUrl: string): Promise<void> {
  await SecureStore.deleteItemAsync(await key(baseUrl));
}

/**
 * Decrypted E2EE private key (JWK JSON), stored in the Keystore per
 * **(server, account)**, like the SQLite database and unlike the session,
 * which really is per server. Its presence = this account is "unlocked": on
 * restart we reimport without asking for the E2E password again. Locking =
 * erasing it. We store the DECRYPTED JWK (the server's encrypted blob would be
 * useless without the password): the same trade-off as the plaintext session
 * in the Keystore, protected by the device lock screen, outside the E2EE
 * threat model (which targets the server).
 *
 * Indexing by account is not a convenience: stored per server alone, one
 * account's key was reimported for the next. See `storageKeys.ts`.
 */
export async function saveE2EPrivateKey(
  baseUrl: string,
  userId: string,
  jwkJson: string,
): Promise<void> {
  await SecureStore.setItemAsync(await e2eStorageKey(baseUrl, userId, hash), jwkJson);
}

export async function readE2EPrivateKey(
  baseUrl: string,
  userId: string,
): Promise<string | null> {
  return SecureStore.getItemAsync(await e2eStorageKey(baseUrl, userId, hash));
}

export async function clearE2EPrivateKey(
  baseUrl: string,
  userId: string,
): Promise<void> {
  await SecureStore.deleteItemAsync(await e2eStorageKey(baseUrl, userId, hash));
}

/**
 * Erases the E2EE entry in the OLD format, indexed by server alone.
 *
 * Without it, the fix above would leave on the device, forever, a
 * **decrypted** RSA JWK that no code could find again: `expo-secure-store`
 * does not enumerate its keys. We NEVER read it: reading it to "migrate" it
 * would replay exactly the fixed defect, since nothing says which account it
 * belonged to.
 *
 * Called at connection setup rather than at logout: a user who never logs out
 * is the common case, and precisely the one who keeps the orphan.
 */
export async function purgeLegacyE2EKey(baseUrl: string): Promise<void> {
  await SecureStore.deleteItemAsync(await legacyE2eStorageKey(baseUrl, hash));
}

/**
 * The same sweep, over ALL the servers where a session existed.
 *
 * Purging only the active server is not enough, and that is the trap of this
 * migration: a user who unlocked E2E on a server then left it (switch, or a
 * logout from before the fix, which did not erase the key) keeps their
 * decrypted RSA JWK under a key nobody derives any more. "Unfindable" would
 * then mean **indestructible**.
 *
 * The `known-servers` registry exists exactly to work around the Keystore's
 * non-enumerability, and it is already populated by earlier sessions. Run once
 * per startup: a few deletions of absent entries, which `deleteItemAsync`
 * handles without error.
 */
export async function purgeAllLegacyE2EKeys(): Promise<void> {
  for (const url of await listKnownServers()) {
    await purgeLegacyE2EKey(url);
  }
}

/**
 * The server of the last opened session. Sessions are stored by URL digest:
 * without this pointer, startup would not know which one to resume. Step 5.3
 * (multi-server) makes it the "active server".
 */
export async function saveLastServer(baseUrl: string): Promise<void> {
  await SecureStore.setItemAsync(STORED_KEYS.lastServer.key, withoutTrailingSlash(baseUrl));
}

export async function readLastServer(): Promise<string | null> {
  return readMovedKey(secureStore, STORED_KEYS.lastServer);
}

/**
 * Registry of the servers where a session existed. Needed because
 * `expo-secure-store` CANNOT enumerate its keys: without this list, there is
 * no way to offer "switch back to that server".
 */
export async function listKnownServers(): Promise<string[]> {
  const raw = await readMovedKey(secureStore, STORED_KEYS.knownServers);
  if (raw === null) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveKnownServer(baseUrl: string): Promise<void> {
  const clean = withoutTrailingSlash(baseUrl);
  const list = await listKnownServers();
  if (list.includes(clean)) return;
  await SecureStore.setItemAsync(STORED_KEYS.knownServers.key, JSON.stringify([...list, clean]));
}

/**
 * The last FCM token we registered with a server.
 *
 * Remembered at REGISTRATION, not when it is used. Logout needed it and asked
 * `getFcmToken()` for it again, which has two defects: the function creates the
 * notification channel and calls `requestPermissionsAsync()` (so logging out
 * could pop a system prompt), and on a device without Play Services it returns
 * nothing at all, so no `DELETE` was even attempted. The FCM token belongs to
 * the DEVICE, not the server: a single key is enough.
 */
export async function rememberPushToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(STORED_KEYS.devicePushToken.key, token);
  await SecureStore.deleteItemAsync(STORED_KEYS.devicePushToken.legacy);
}

export function readRememberedPushToken(): Promise<string | null> {
  return readMovedKey(secureStore, STORED_KEYS.devicePushToken);
}

/**
 * Logouts the network did not let through, to finish on the next startup. See
 * `lib/deferredLogout.ts` for why.
 *
 * Same pattern as `known-servers`: `expo-secure-store` cannot enumerate its
 * keys, hence a JSON list under a fixed key. The name deliberately does NOT
 * start with `session-`: the native notification service scans the
 * preferences for that prefix (`plugins/with-fcm-deeplink.js`), and it is
 * better not to rely on its internal guards to skip it.
 *
 * One entry per server, overwritten if it exists: logging out twice from the
 * same server cannot grow the queue.
 */
export async function listPendingLogouts(): Promise<PendingLogout[]> {
  const raw = await readMovedKey(secureStore, STORED_KEYS.pendingLogouts);
  if (raw === null) return [];
  return parsePendingLogouts(raw);
}

export async function addPendingLogout(entry: PendingLogout): Promise<void> {
  const clean = { ...entry, baseUrl: withoutTrailingSlash(entry.baseUrl) };
  const others = (await listPendingLogouts()).filter((d) => d.baseUrl !== clean.baseUrl);
  await SecureStore.setItemAsync(STORED_KEYS.pendingLogouts.key, JSON.stringify([...others, clean]));
}

export async function removePendingLogout(baseUrl: string): Promise<void> {
  const clean = withoutTrailingSlash(baseUrl);
  const remaining = (await listPendingLogouts()).filter((d) => d.baseUrl !== clean);
  if (remaining.length === 0) {
    await SecureStore.deleteItemAsync(STORED_KEYS.pendingLogouts.key);
    return;
  }
  await SecureStore.setItemAsync(STORED_KEYS.pendingLogouts.key, JSON.stringify(remaining));
}
