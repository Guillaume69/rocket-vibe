/**
 * E2EE orchestration: the private key in memory, the room key cache, and
 * unlocking. Pure crypto lives in `crypto.ts`; this handles the state
 * (locked / unlocked), secure storage of the key, and REST.
 *
 * Usage:
 *   1. `resume()` at startup: if a private key is in the Keystore, it is
 *      reimported without a password, so unlocked silently.
 *   2. otherwise `unlock(password)` on tapping an encrypted room: fetches the
 *      encrypted private key (`e2e.fetchMyKeys`), decrypts it, persists it.
 *   3. `saveRoomKey(rid, E2EKey)` caches a room's AES key (RSA-decrypted
 *      once); `decryptContent(rid, content)` is then SYNCHRONOUS, so it can be
 *      plugged into ingestion; `encrypt(rid, payload)` is too, for sending.
 *   4. `lock()` forgets everything, in memory and in the Keystore.
 *
 * `isUnlocked` is observable (`subscribe`) to drive the UI through
 * `useSyncExternalStore`.
 */

import {
  encryptMessage,
  decryptRoomKey,
  decryptPrivateKey,
  decryptPayload,
  E2EError,
  importRsaPrivateKey,
  keyIdOfE2EKey,
  type RsaPrivateKey,
  type EncryptedContent,
} from './crypto.ts';

/** The bare minimum of `ClientRest`, to test the engine without a network. */
export interface ClientE2E {
  get<T>(path: string, options?: { params?: Record<string, unknown> }): Promise<T>;
}

/** Keystore access, injected (to test without `expo-secure-store`). */
export interface E2EKeyStorage {
  read(): Promise<string | null>;
  save(jwkJson: string): Promise<void>;
  clear(): Promise<void>;
}

type FetchMyKeysResponse = { public_key?: string; private_key?: string };

export class E2EEngine {
  private readonly client: ClientE2E;
  private readonly storage: E2EKeyStorage;
  /** Account userId, the PBKDF2 salt of v1 private keys (legacy). */
  private readonly uid: string;

  private privateKey: RsaPrivateKey | null = null;
  /** rid -> raw bytes of the room AES key (decrypted once). */
  private readonly roomKeys = new Map<string, Buffer>();
  /** rid -> known subscription `E2EKey`, to (re)compute the key when needed. */
  private readonly e2eKeys = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  constructor(deps: { client: ClientE2E; storage: E2EKeyStorage; uid: string }) {
    this.client = deps.client;
    this.storage = deps.storage;
    this.uid = deps.uid;
  }

  get isUnlocked(): boolean {
    return this.privateKey !== null;
  }

  /** Observes locked <-> unlocked transitions (for useSyncExternalStore). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifier(): void {
    for (const e of this.listeners) e();
  }

  /**
   * Silent resume at startup: reimports the private key already in the
   * Keystore. Returns `true` if unlocked afterwards. A corrupt key is cleared
   * rather than blocking.
   */
  async resume(): Promise<boolean> {
    if (this.privateKey !== null) return true;
    const jwk = await this.storage.read();
    if (jwk === null) return false;
    try {
      this.privateKey = importRsaPrivateKey(jwk);
    } catch {
      await this.storage.clear();
      return false;
    }
    this.notifier();
    return true;
  }

  /**
   * Unlocks with the E2E password: fetches the encrypted private key, decrypts
   * it, persists it. Throws `E2EError` if the password is wrong.
   */
  async unlock(password: string): Promise<void> {
    const res = await this.client.get<FetchMyKeysResponse>('e2e.fetchMyKeys');
    if (typeof res.private_key !== 'string') {
      throw new E2EError('no E2E key on this account');
    }
    // `decryptPrivateKey` detects the scheme (v1/v2); the uid is the v1 salt.
    const jwk = decryptPrivateKey(res.private_key, password, this.uid); // throws E2EError if wrong
    this.privateKey = importRsaPrivateKey(jwk);
    await this.storage.save(jwk);
    // Known room keys can now be recomputed on demand.
    this.roomKeys.clear();
    this.notifier();
  }

  /** Forgets every key, memory and Keystore. */
  async lock(): Promise<void> {
    this.privateKey = null;
    this.roomKeys.clear();
    await this.storage.clear();
    this.notifier();
  }

  /**
   * Stores (and decrypts if possible) a room's AES key from its
   * subscription's `E2EKey`. Safe to call while locked (it keeps the `E2EKey`
   * and picks it up on unlock) and repeatedly: idempotent as long as the
   * `E2EKey` does not CHANGE.
   *
   * When it changes, it is a ROTATION (removing a member from the room causes
   * one): the `roomKeys` cache then holds the stale AES key, and
   * `decryptContent` checks it FIRST, so every later message would freeze on
   * the 🔒 placeholder until restart, with no hint of the cause. Hence the
   * purge: the key is recomputed on demand from the new one.
   */
  saveRoomKey(rid: string, e2eKey: string | null): void {
    if (e2eKey === null || e2eKey === '') return;
    const old = this.e2eKeys.get(rid);
    this.e2eKeys.set(rid, e2eKey);
    if (old !== undefined && old !== e2eKey) this.roomKeys.delete(rid);
    if (this.privateKey === null || this.roomKeys.has(rid)) return;
    try {
      this.roomKeys.set(rid, decryptRoomKey(e2eKey, this.privateKey));
    } catch {
      // Unreadable key (other keyID, damaged blob): nothing to cache, this
      // room's messages stay on the placeholder.
    }
  }

  /** The keyID (UUID) expected for a room, or `null` if its `E2EKey` is unknown. */
  roomKeyId(rid: string): string | null {
    const k = this.e2eKeys.get(rid);
    return k === undefined ? null : keyIdOfE2EKey(k);
  }

  /**
   * Decrypts a `content` object for a room: its text, and a file's
   * attachments (JSON). SYNCHRONOUS: plugs into ingestion. Returns `null` if
   * locked, if the room key is missing, or if the content is unreadable; the
   * caller then keeps the ciphertext to retry after unlocking.
   */
  decryptContent(rid: string, content: EncryptedContent): { text: string; attachments: string | null } | null {
    const key = this.roomKey(rid);
    if (key === null) return null;
    try {
      const { msg, attachments } = decryptPayload(content, key);
      return { text: msg, attachments: attachments === null ? null : JSON.stringify(attachments) };
    } catch {
      return null;
    }
  }

  /**
   * Encrypts a payload (`{msg}`...) for a room, under its current key and
   * keyID. Returns `null` if locked or if the room key is missing: sending
   * then waits, it never goes out in plaintext.
   */
  encrypt(rid: string, payload: object): EncryptedContent | null {
    const key = this.roomKey(rid);
    const kid = this.roomKeyId(rid);
    if (key === null || kid === null) return null;
    try {
      return encryptMessage(payload, key, kid);
    } catch {
      return null;
    }
  }

  private roomKey(rid: string): Buffer | null {
    if (this.privateKey === null) return null;
    const known = this.roomKeys.get(rid);
    if (known !== undefined) return known;
    // Not cached yet: try from the known `E2EKey`.
    const e2eKey = this.e2eKeys.get(rid);
    if (e2eKey === undefined) return null;
    try {
      const key = decryptRoomKey(e2eKey, this.privateKey);
      this.roomKeys.set(rid, key);
      return key;
    } catch {
      return null;
    }
  }
}
