/**
 * Rocket.Chat E2EE primitives (`rc.v2.aes-sha2` scheme): decryption, and
 * encryption of sent messages.
 *
 * PURE functions, no React or network, testable under Node. All of the
 * client's cryptographic knowledge lives here; orchestration (session, keys in
 * memory, REST) lives in `lib/e2e/engine.ts`.
 *
 * Crypto goes through the `node:crypto` API: under Node (tests) it is the
 * native OpenSSL implementation; in the RN app, Metro aliases `crypto` and
 * `buffer` to `react-native-quick-crypto` (native Nitro module, New Arch):
 * same API, same OpenSSL, native PBKDF2 instead of ~400 ms in pure JS.
 * Aliasing in `metro.config.js`.
 *
 * The EXACT formats are checked against a real 8.5 server (memory
 * `e2ee-protocole-rc85`). In short:
 *   - private key: JSON envelope `{iv, ciphertext, salt, iterations}`, salt =
 *     literal ASCII string, PBKDF2-SHA256 -> AES-GCM -> RSA JWK;
 *   - room key: `E2EKey` = keyID (36-char UUID) + base64(RSA-OAEP) -> AES JWK;
 *   - message: `content` object `{algorithm, kid, iv, ciphertext}` -> AES-GCM ->
 *     JSON `{"msg": "<plaintext>"}`.
 *
 * WebCrypto GCM convention (server/official side): the 16-byte tag is
 * APPENDED to `ciphertext`. `createDecipheriv` wants it separate through
 * `setAuthTag`, hence the split.
 */

import {
  constants,
  createCipheriv,
  createHash,
  createDecipheriv,
  createPrivateKey,
  pbkdf2Sync,
  privateDecrypt,
  randomBytes,
  type KeyObject,
} from 'crypto';
import { Buffer } from 'buffer';

/** Private key envelope as returned by `e2e.fetchMyKeys`. */
export type PrivateKeyEnvelope = {
  /** base64, 12 bytes (GCM nonce). */
  iv: string;
  /** base64, ciphertext + GCM tag (last 16 bytes). */
  ciphertext: string;
  /** Literal ASCII string `v2:<uid>:<uuid>`, used AS IS (no base64). */
  salt: string;
  iterations: number;
};

/**
 * `content` object of an encrypted message. Three observed shapes:
 *   - `rc.v2` GCM (recent server): `{kid, iv(12 B), ciphertext(+tag)}`;
 *   - `rc.v2` CBC (old account): `{kid, iv(16 B), ciphertext}`;
 *   - `rc.v1` (legacy): `{ciphertext}` alone, where `ciphertext = keyID(12) +
 *     base64(IV(16) || AES-CBC)`, with no separate `iv`/`kid` field.
 * Hence OPTIONAL `iv`/`kid`.
 */
export type EncryptedContent = {
  algorithm: string;
  ciphertext: string;
  kid?: string;
  iv?: string;
};

/** Imported RSA private key, opaque, kept in memory for a session. */
export type RsaPrivateKey = KeyObject;

/** Decryption error: a wrong password lands here, not in a crash. */
export class E2EError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2EError';
  }
}

const GCM_TAG_SIZE = 16;
/** AES-CBC IV = 16 bytes (the GCM IV is 12). Here the v1 CBC IV. */
const CBC_IV_SIZE = 16;
/**
 * An `E2EKey` = keyID + base64(RSA-OAEP-encrypted room key). RSA-2048 output
 * is 256 bytes = 344 base64 characters. The keyID is therefore the remaining
 * PREFIX: 36 (UUID, v2 scheme) or 12 (v1 scheme). It is COMPUTED instead of
 * hard-coded: an account can mix both depending on age.
 */
const RSA_B64_LENGTH = 344;
function longueurKeyId(e2eKey: string): number {
  return Math.max(0, e2eKey.length - RSA_B64_LENGTH);
}

function base64ToBytes(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

/** base64url (JWK) -> bytes. */
function base64urlToBytes(s: string): Buffer {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4 !== 0) b += '=';
  return Buffer.from(b, 'base64');
}

/**
 * The AES cipher matching the key size: a room key created by the old web
 * client is a 16-byte `A128CBC` JWK, not 32.
 */
function bitsAes(key: Buffer): 128 | 192 | 256 | null {
  const bits = key.length * 8;
  return bits === 128 || bits === 192 || bits === 256 ? bits : null;
}

/**
 * Decrypts an AES-GCM block. `ctWithTag` carries the 16-byte tag at the end
 * (WebCrypto convention). Returns `null` if authentication fails, the only
 * reliable way to detect a wrong password or key.
 */
function decryptGcm(key: Buffer, iv: Buffer, ctWithTag: Buffer): Buffer | null {
  const bits = bitsAes(key);
  if (bits === null || ctWithTag.length < GCM_TAG_SIZE) return null;
  const body = ctWithTag.subarray(0, ctWithTag.length - GCM_TAG_SIZE);
  const tag = ctWithTag.subarray(ctWithTag.length - GCM_TAG_SIZE);
  try {
    const decryptor = createDecipheriv(`aes-${bits}-gcm`, key, iv);
    decryptor.setAuthTag(tag);
    return Buffer.concat([decryptor.update(body), decryptor.final()]);
  } catch {
    return null;
  }
}

/** Decrypts an AES-CBC block (PKCS#7 padding checked by `final`). */
function decryptCbc(key: Buffer, iv: Buffer, ct: Buffer): Buffer | null {
  const bits = bitsAes(key);
  if (bits === null) return null;
  try {
    const decryptor = createDecipheriv(`aes-${bits}-cbc`, key, iv);
    return Buffer.concat([decryptor.update(ct), decryptor.final()]);
  } catch {
    return null;
  }
}

/**
 * `private_key` (as returned by `e2e.fetchMyKeys`) -> JWK JSON of the RSA
 * private key. Detects the scheme:
 *   - **v2**: JSON envelope `{iv, ciphertext, salt, iterations}`, PBKDF2 ->
 *     AES-GCM, salt in the envelope.
 *   - **v1** (legacy): `{"$binary":"<b64>"}` (or bare base64), whose bytes are
 *     `IV(16) || AES-CBC`. PBKDF2(password, salt = **userId**, **1000**
 *     iterations, SHA-256) -> AES-CBC. The `uid` is the salt, hence the param.
 * Throws `E2EError` if the password does not decrypt.
 */
export function decryptPrivateKey(privateKey: string, password: string, uid: string): string {
  const raw = privateKey.trim();
  if (raw.startsWith('{')) {
    let obj: Record<string, unknown> | null = null;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      obj = null;
    }
    // v2: full envelope.
    if (obj !== null && typeof obj.iterations === 'number' && typeof obj.salt === 'string') {
      const env = obj as unknown as PrivateKeyEnvelope;
      const masterKey = pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(env.salt, 'utf8'), env.iterations, 32, 'sha256');
      const plain = decryptGcm(masterKey, base64ToBytes(env.iv), base64ToBytes(env.ciphertext));
      if (plain === null) throw new E2EError('invalid E2E password');
      return plain.toString('utf8');
    }
    // v1 wrapped in EJSON binary.
    if (obj !== null && typeof obj.$binary === 'string') {
      return decryptPrivateKeyV1(base64ToBytes(obj.$binary), password, uid);
    }
  }
  // v1 as bare base64.
  return decryptPrivateKeyV1(base64ToBytes(raw), password, uid);
}

/**
 * v1 private key: bytes = `IV(16) || AES-CBC(JWK)`, master key derived from
 * the userId (salt) and 1000 PBKDF2-SHA256 iterations. A wrong password breaks
 * the PKCS#7 padding -> `E2EError`. In the rare case the padding passes by
 * chance, the plaintext is not a valid JWK -> `JSON.parse` throws, which is
 * treated as a wrong password.
 */
function decryptPrivateKeyV1(bytes: Buffer, password: string, uid: string): string {
  const masterKey = pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(uid, 'utf8'), 1000, 32, 'sha256');
  const plain = decryptCbc(masterKey, bytes.subarray(0, CBC_IV_SIZE), bytes.subarray(CBC_IV_SIZE));
  if (plain === null) throw new E2EError('invalid E2E password');
  const text = plain.toString('utf8');
  try {
    JSON.parse(text);
  } catch {
    throw new E2EError('invalid E2E password');
  }
  return text;
}

/** JWK JSON -> RSA private key object. `createPrivateKey` imports the JWK natively. */
export function importRsaPrivateKey(jwkJson: string): RsaPrivateKey {
  const jwk = JSON.parse(jwkJson) as JsonWebKey;
  return createPrivateKey({ key: jwk, format: 'jwk' });
}

/** The keyID at the head of an `E2EKey` (v2 UUID or v1 prefix), matched to `content.kid`. */
export function keyIdOfE2EKey(e2eKey: string): string {
  return e2eKey.substring(0, longueurKeyId(e2eKey));
}

/**
 * Subscription `E2EKey` -> room AES key (raw bytes). Strips the keyID (36
 * chars in v2, 12 in v1, computed), RSA-OAEP/SHA-256 with the private key ->
 * AES JWK, whose raw `k` is returned.
 */
export function decryptRoomKey(e2eKey: string, privateKey: RsaPrivateKey): Buffer {
  const encrypted = base64ToBytes(e2eKey.substring(longueurKeyId(e2eKey)));
  let jwkJson: string;
  try {
    jwkJson = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      encrypted,
    ).toString('utf8');
  } catch {
    throw new E2EError('room key decryption failed');
  }
  const jwk = JSON.parse(jwkJson) as { k?: string };
  if (typeof jwk.k !== 'string') throw new E2EError('room key without a k field');
  return base64urlToBytes(jwk.k);
}

/**
 * What an encrypted message carries once opened: its text, and for a file its
 * attachments, which hold the file key.
 */
export type PlainPayload = { msg: string; attachments: unknown[] | null };

/** `content` object + room key (bytes) -> message plaintext. */
export function decryptMessage(content: EncryptedContent, roomKeyBytes: Buffer): string {
  return decryptPayload(content, roomKeyBytes).msg;
}

/**
 * `content` object + room key (bytes) -> plain payload. The plaintext is JSON
 * `{"msg": "...", "attachments": [...]}` (sometimes `text`). Throws `E2EError`
 * if authentication fails.
 */
export function decryptPayload(content: EncryptedContent, roomKeyBytes: Buffer): PlainPayload {
  let plain: Buffer | null;
  if (typeof content.iv === 'string' && content.iv !== '') {
    // Modern structure: separate iv and ciphertext. 12-byte IV -> GCM (tag
    // appended); 16 -> CBC (the scheme of this old account).
    const iv = base64ToBytes(content.iv);
    const ct = base64ToBytes(content.ciphertext);
    plain = iv.length === 12 ? decryptGcm(roomKeyBytes, iv, ct) : decryptCbc(roomKeyBytes, iv, ct);
  } else {
    // Legacy rc.v1 structure: ciphertext = keyID(12) + base64(IV(16) || CBC).
    const blob = base64ToBytes(content.ciphertext.substring(12));
    plain = decryptCbc(roomKeyBytes, blob.subarray(0, CBC_IV_SIZE), blob.subarray(CBC_IV_SIZE));
  }
  if (plain === null) throw new E2EError('message decryption failed');
  const text = plain.toString('utf8');
  // The plaintext is usually JSON `{"msg": "..."}`; some legacy messages carry
  // raw text, which is the fallback.
  try {
    const obj = JSON.parse(text) as { msg?: unknown; text?: unknown; attachments?: unknown };
    const attachments = Array.isArray(obj.attachments) ? obj.attachments : null;
    if (typeof obj.msg === 'string') return { msg: obj.msg, attachments };
    if (typeof obj.text === 'string') return { msg: obj.text, attachments };
    if (attachments !== null) return { msg: '', attachments };
  } catch {
    // not JSON: raw text.
  }
  return { msg: text, attachments: null };
}

/**
 * Plain payload (`{msg}`, plus `attachments`/`files`/`file` for a file) ->
 * `rc.v2.aes-sha2` `content` object, as the web client produces it. The mode
 * follows the room key, like WebCrypto on the web where the key is imported
 * according to its JWK `alg`: `A128CBC` (16 bytes) -> CBC, 16-byte IV;
 * `A256GCM` (32) -> GCM, 12-byte IV, tag appended to `ciphertext`.
 */
export function encryptMessage(payload: object, roomKeyBytes: Buffer, kid: string): EncryptedContent {
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  let iv: Buffer;
  let ct: Buffer;
  if (roomKeyBytes.length === 16) {
    iv = randomBytes(CBC_IV_SIZE);
    const encryptor = createCipheriv('aes-128-cbc', roomKeyBytes, iv);
    ct = Buffer.concat([encryptor.update(plain), encryptor.final()]);
  } else if (roomKeyBytes.length === 32) {
    iv = randomBytes(12);
    const encryptor = createCipheriv('aes-256-gcm', roomKeyBytes, iv);
    ct = Buffer.concat([encryptor.update(plain), encryptor.final(), encryptor.getAuthTag()]);
  } else {
    throw new E2EError('room key of unexpected size');
  }
  return { algorithm: 'rc.v2.aes-sha2', kid, iv: iv.toString('base64'), ciphertext: ct.toString('base64') };
}

/**
 * A file's encryption, as its attachment describes it (in the message
 * plaintext): its own AES-CTR key (JWK), a 16-byte initial counter, and the
 * SHA-256 digest of the plain file.
 */
export type FileEncryption = { key: { k: string }; iv: string; sha256: string | null };

/** An attachment's encryption description, or `null` if it is not encrypted. */
export function attachmentEncryption(attachment: unknown): FileEncryption | null {
  if (typeof attachment !== 'object' || attachment === null) return null;
  const { encryption, hashes } = attachment as { encryption?: unknown; hashes?: unknown };
  if (typeof encryption !== 'object' || encryption === null) return null;
  const { key, iv } = encryption as { key?: unknown; iv?: unknown };
  const k = typeof key === 'object' && key !== null ? (key as { k?: unknown }).k : undefined;
  if (typeof k !== 'string' || typeof iv !== 'string') return null;
  const sha256 =
    typeof hashes === 'object' && hashes !== null ? (hashes as { sha256?: unknown }).sha256 : undefined;
  return { key: { k }, iv, sha256: typeof sha256 === 'string' ? sha256 : null };
}

/**
 * Downloaded bytes -> plain file. AES-CTR has no padding or tag, so a wrong
 * key yields noise without error: the SHA-256 digest decides, when the sender
 * provided it. Throws `E2EError` otherwise.
 */
export function decryptFile(bytes: Buffer, encryption: FileEncryption): Buffer {
  const key = base64urlToBytes(encryption.key.k);
  const bits = bitsAes(key);
  const iv = base64ToBytes(encryption.iv);
  if (bits === null || iv.length !== 16) throw new E2EError('unreadable file encryption');
  const decryptor = createDecipheriv(`aes-${bits}-ctr`, key, iv);
  const plain = Buffer.concat([decryptor.update(bytes), decryptor.final()]);
  if (encryption.sha256 !== null && sha256Digest(plain) !== encryption.sha256.toLowerCase()) {
    throw new E2EError('tampered file or wrong key');
  }
  return plain;
}

/** SHA-256 in hex, the shape of Rocket.Chat `hashes.sha256`. */
export function sha256Digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A sent file's key, in the JWK shape the web client reimports (AES-CTR, extractable). */
export type FileJwk = { kty: 'oct'; alg: 'A256CTR'; k: string; ext: true; key_ops: ['encrypt', 'decrypt'] };

/**
 * Plain file -> bytes to upload, and what is needed to read it back: a fresh
 * AES-CTR 256 key, a 16-byte initial counter, the SHA-256 digest of the
 * plaintext; what the web client puts in the attachment.
 */
export function encryptFile(plain: Buffer): {
  encrypted: Buffer;
  key: FileJwk;
  iv: string;
  sha256: string;
} {
  const key = randomBytes(32);
  const iv = randomBytes(16);
  const encryptor = createCipheriv('aes-256-ctr', key, iv);
  return {
    encrypted: Buffer.concat([encryptor.update(plain), encryptor.final()]),
    key: { kty: 'oct', alg: 'A256CTR', k: toBase64url(key), ext: true, key_ops: ['encrypt', 'decrypt'] },
    iv: iv.toString('base64'),
    sha256: sha256Digest(plain),
  };
}

function toBase64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
