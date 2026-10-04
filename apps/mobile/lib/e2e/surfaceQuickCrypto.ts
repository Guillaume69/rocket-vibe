/**
 * TYPE assertions on the `react-native-quick-crypto` surface actually used by
 * `lib/e2e/crypto.ts`.
 *
 * The `crypto.test.ts` tests run under Node, so against `node:crypto`, never
 * against quick-crypto, the implementation the Metro alias
 * (`metro.config.js`) ships on the device. An upgrade that removed or changed
 * one of the calls used would pass the whole suite and produce "Unlock
 * failed" in production, with no signal.
 *
 * This file replays each `crypto.ts` call against the TYPE of the aliased
 * module: `npx tsc --noEmit`, the exit criterion of every workstream, checks
 * it. It has NO runtime existence: type imports only, values declared as
 * ambient, never imported by the app or by a test. Breaking one of these
 * calls on a quick-crypto bump becomes a compile error instead of a crash on
 * the device.
 *
 * Accepted limit: a type can lie (a stable signature over a native that
 * changes behaviour). BEHAVIOUR is proven only by the `crypto.test.ts`
 * vectors under OpenSSL/Node, the same library as native quick-crypto, and by
 * a real unlock on the device.
 */

import type { Buffer as BufferEmbarque } from '@craftzdog/react-native-buffer';

/** The module Metro serves when `crypto.ts` imports `crypto`. */
type ModuleQuickCrypto = typeof import('react-native-quick-crypto');
/** The module Metro serves when `crypto.ts` imports `buffer`. */
type BundledBufferModule = typeof import('@craftzdog/react-native-buffer');

declare const qc: ModuleQuickCrypto;
declare const moduleBuffer: BundledBufferModule;
declare const bytes: BufferEmbarque;

/**
 * The private RSA JWK as Rocket.Chat actually delivers it (WebCrypto
 * `exportKey('jwk')`, checked on 8.5, memory `e2ee-protocole-rc85`). NOT the
 * Node-typed `JsonWebKey` that `crypto.ts` shows: quick-crypto narrows `kty` to
 * a union (`'RSA' | ...`) where Node says `string`. The runtime VALUE is what
 * must be accepted, so that is what is modelled; if quick-crypto dropped
 * `'RSA'` from the union or the `format: 'jwk'` field, this line would break.
 */
declare const jwk: {
  kty: 'RSA';
  alg: string;
  n: string;
  e: string;
  d: string;
  p: string;
  q: string;
  dp: string;
  dq: string;
  qi: string;
  ext: boolean;
  key_ops: 'decrypt'[];
};

/**
 * Never called: only its TYPING matters. Each block is an exact copy of a
 * `crypto.ts` call, in file order.
 */
export function surfaceUsedByCryptoTs(): void {
  // `Buffer.from` / `Buffer.concat` (base64ToBytes, decryptGcm...).
  const b64 = moduleBuffer.Buffer.from('AA==', 'base64');
  const utf8 = moduleBuffer.Buffer.from('texte', 'utf8');
  const concat: BufferEmbarque = moduleBuffer.Buffer.concat([b64, utf8]);
  void concat.subarray(0, 16);
  void concat.toString('utf8');

  // decryptGcm: GCM with variable key size, tag separated via setAuthTag, update/final -> Buffer.
  const encrypted: string = `aes-${bytes.length * 8}-gcm`;
  const gcm = qc.createDecipheriv(encrypted, bytes, bytes);
  gcm.setAuthTag(bytes);
  const gcmPlain: BufferEmbarque = moduleBuffer.Buffer.concat([gcm.update(bytes), gcm.final()]);
  void gcmPlain;

  // decryptCbc: CBC with variable key size, padding checked by final.
  const cbc = qc.createDecipheriv(encrypted, bytes, bytes);
  const cbcPlain: BufferEmbarque = moduleBuffer.Buffer.concat([cbc.update(bytes), cbc.final()]);
  void cbcPlain;

  // decryptPrivateKey: PBKDF2-SHA256 -> 32 bytes of master key.
  const masterKey: BufferEmbarque = qc.pbkdf2Sync(utf8, utf8, 1000, 32, 'sha256');
  void masterKey;

  // importRsaPrivateKey: native JWK import.
  const privateKey = qc.createPrivateKey({ key: jwk, format: 'jwk' });

  // decryptRoomKey: RSA-OAEP/SHA-256 with the padding constant.
  const padding: number = qc.constants.RSA_PKCS1_OAEP_PADDING;
  const roomJwk: BufferEmbarque = qc.privateDecrypt(
    { key: privateKey, padding, oaepHash: 'sha256' },
    bytes,
  );
  void roomJwk.toString('utf8');

  // encryptMessage: random IV, CBC 128 or GCM 256 (tag read after final).
  const iv: BufferEmbarque = qc.randomBytes(16);
  const toCbc = qc.createCipheriv('aes-128-cbc', bytes, iv);
  const cbcCiphertext: BufferEmbarque = moduleBuffer.Buffer.concat([toCbc.update(bytes), toCbc.final()]);
  void cbcCiphertext.toString('base64');
  const toGcm = qc.createCipheriv('aes-256-gcm', bytes, iv);
  const gcmCiphertext: BufferEmbarque = moduleBuffer.Buffer.concat([
    toGcm.update(bytes),
    toGcm.final(),
    toGcm.getAuthTag(),
  ]);
  void gcmCiphertext;

  // decryptFile: AES-CTR with variable key size, SHA-256 digest in hex.
  const ctr = qc.createDecipheriv(`aes-${bytes.length * 8}-ctr`, bytes, iv);
  const file: BufferEmbarque = moduleBuffer.Buffer.concat([ctr.update(bytes), ctr.final()]);
  const fingerprint: string = qc.createHash('sha256').update(file).digest('hex');
  void fingerprint;

  // encryptFile: AES-256-CTR, random key and counter.
  const toCtr = qc.createCipheriv('aes-256-ctr', qc.randomBytes(32), iv);
  const ctrCiphertext: BufferEmbarque = moduleBuffer.Buffer.concat([toCtr.update(bytes), toCtr.final()]);
  void ctrCiphertext;
}
