import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  attachmentEncryption,
  encryptFile,
  encryptMessage,
  decryptPayload,
  decryptPrivateKey,
  decryptRoomKey,
  decryptFile,
  decryptMessage,
  E2EError,
  importRsaPrivateKey,
  keyIdOfE2EKey,
  type EncryptedContent,
  type PrivateKeyEnvelope,
} from './crypto.ts';

/**
 * Cross test, offline, with no committed secret: WebCrypto (the official web
 * client's implementation) ENCRYPTS in Rocket.Chat's exact format, our
 * `node:crypto` module DECRYPTS. If both sides agree, the module does follow
 * the `rc.v2.aes-sha2` format. The Phase 0 spike proved the other half
 * (against a real server); together they cover the chain.
 */

const { subtle } = webcrypto;
const enc = new TextEncoder();
const b64 = (u8: Uint8Array): string => Buffer.from(u8).toString('base64');
// Arrays backed by an ArrayBuffer (not ArrayBufferLike) to satisfy the
// WebCrypto types' `BufferSource`, a classic TS friction.
const rand = (n: number): Uint8Array<ArrayBuffer> => {
  const a = new Uint8Array(n);
  webcrypto.getRandomValues(a);
  return a;
};
const bytes = (s: string): Uint8Array<ArrayBuffer> => {
  const u = enc.encode(s);
  const a = new Uint8Array(u.length);
  a.set(u);
  return a;
};

const PASSWORD = 'oppose update message economy float mail palace drive horse';
const SALT = 'v2:osR3JzQEiM2H77m46:d280e4f2-c685-4813-80f7-13438befaddd';
const ITERATIONS = 1000; // low for test speed; the code reads the envelope's value
const MESSAGE = 'message secret e2e alice 42';

/** Builds a full encrypted dataset in the RC format, via WebCrypto. */
async function make(): Promise<{
  wrapper: PrivateKeyEnvelope;
  e2eKey: string;
  content: EncryptedContent;
  keyId: string;
}> {
  // 1. RSA-OAEP/SHA-256 pair, private key exported as JWK.
  const pair = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  const privateJwk = JSON.stringify(await subtle.exportKey('jwk', pair.privateKey));

  // 2. PBKDF2 master key -> AES-GCM, encrypts the private JWK.
  const base = await subtle.importKey('raw', bytes(PASSWORD), 'PBKDF2', false, ['deriveKey']);
  const masterKey = await subtle.deriveKey(
    { name: 'PBKDF2', salt: bytes(SALT), iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const privateIv = rand(12);
  const privateCt = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: privateIv }, masterKey, bytes(privateJwk)),
  );
  const wrapper: PrivateKeyEnvelope = {
    iv: b64(privateIv),
    ciphertext: b64(privateCt),
    salt: SALT,
    iterations: ITERATIONS,
  };

  // 3. AES-GCM room key, RSA-OAEP-encrypted for the public key, prefixed with the keyID.
  const roomKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const roomJwk = JSON.stringify(await subtle.exportKey('jwk', roomKey));
  const rk = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, pair.publicKey, bytes(roomJwk)));
  const keyId = webcrypto.randomUUID(); // 36 characters
  const e2eKey = keyId + b64(rk);

  // 4. message encrypted with the room key.
  const ivMsg = rand(12);
  const ctMsg = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: ivMsg }, roomKey, bytes(JSON.stringify({ msg: MESSAGE }))),
  );
  const content: EncryptedContent = {
    algorithm: 'rc.v2.aes-sha2',
    kid: keyId,
    iv: b64(ivMsg),
    ciphertext: b64(ctMsg),
  };

  return { wrapper, e2eKey, content, keyId };
}

/**
 * Fixture in the LEGACY v1 format (old account, measured on chat.barrut.me):
 *   - private key `{"$binary": base64(IV(16) || AES-CBC)}`, salt = userId, 1000 iters;
 *   - room key with a 12-character keyID (356-char `E2EKey`);
 *   - the message itself in v2 (GCM `content`): a v1 room whose new messages
 *     are encrypted by the recent client.
 */
async function makeV1(): Promise<{
  privateKey: string;
  uid: string;
  e2eKey: string;
  content: EncryptedContent;
}> {
  const uid = 'osR3JzQEiM2H77m46';
  const pair = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  const privateJwk = JSON.stringify(await subtle.exportKey('jwk', pair.privateKey));

  // v1 master key: PBKDF2(password, salt = uid, 1000, SHA-256) -> AES-CBC.
  const base = await subtle.importKey('raw', bytes(PASSWORD), 'PBKDF2', false, ['deriveKey']);
  const master = await subtle.deriveKey(
    { name: 'PBKDF2', salt: bytes(uid), iterations: 1000, hash: 'SHA-256' },
    base,
    { name: 'AES-CBC', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const iv = rand(16);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, master, bytes(privateJwk)));
  const inner = new Uint8Array(iv.length + ct.length);
  inner.set(iv);
  inner.set(ct, iv.length);
  const privateKey = JSON.stringify({ $binary: b64(inner) }); // EJSON wrapping as in prod

  // v1 room key: AES-128, 12-character keyID + base64(RSA(sessionJWK)) -> 356-char E2EKey.
  const roomKey = await subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt', 'decrypt']);
  const roomJwk = JSON.stringify(await subtle.exportKey('jwk', roomKey));
  const rk = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, pair.publicKey, bytes(roomJwk)));
  const keyId = 'af587341640c'; // 12 characters, as measured in prod
  const e2eKey = keyId + b64(rk);

  // v2 message (GCM content) with the room key.
  const ivM = rand(12);
  const ctM = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: ivM }, roomKey, bytes(JSON.stringify({ msg: MESSAGE }))),
  );
  const content: EncryptedContent = { algorithm: 'rc.v2.aes-sha2', kid: keyId, iv: b64(ivM), ciphertext: b64(ctM) };

  return { privateKey, uid, e2eKey, content };
}

describe('crypto e2e: legacy v1 format', () => {
  test('$binary/CBC private key + keyID-12 room key + v2 message -> plaintext', async () => {
    const { privateKey, uid, e2eKey, content } = await makeV1();

    const jwk = decryptPrivateKey(privateKey, PASSWORD, uid);
    assert.match(jwk, /"kty"\s*:\s*"RSA"/);

    const priv = importRsaPrivateKey(jwk);
    assert.equal(e2eKey.length, 356); // same length as measured in prod
    assert.equal(keyIdOfE2EKey(e2eKey), 'af587341640c'); // keyID of 12 computed, not 36

    const key = decryptRoomKey(e2eKey, priv);
    assert.equal(key.length, 16); // A128, as measured in prod
    assert.equal(decryptMessage(content, key), MESSAGE);
  });

  test('wrong password on a v1 key -> E2EError', async () => {
    const { privateKey, uid } = await makeV1();
    assert.throws(() => decryptPrivateKey(privateKey, 'wrong', uid), E2EError);
  });
});

/**
 * Raw bytes of an AES key (Buffer) + WebCrypto AES-CBC key. A room key
 * created by the old web client is 16 bytes (`A128CBC` JWK, measured on
 * chat.barrut.me); a recent room, 32.
 */
async function aesKey(size: 16 | 32) {
  const raw = rand(size);
  const wc = await subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['encrypt']);
  return { keyBytes: Buffer.from(raw), wc };
}

for (const size of [16, 32] as const) describe(`crypto e2e: CBC messages, ${size}-byte room key`, () => {
  test('rc.v1: ciphertext = keyID(12) + base64(IV(16) || CBC) -> plaintext', async () => {
    const { keyBytes, wc } = await aesKey(size);
    const iv = rand(16);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, wc, bytes(JSON.stringify({ msg: MESSAGE }))));
    const blob = new Uint8Array(16 + ct.length);
    blob.set(iv);
    blob.set(ct, 16);
    const content: EncryptedContent = { algorithm: 'rc.v1.aes-sha2', ciphertext: 'af587341640c' + b64(blob) };
    assert.equal(decryptMessage(content, keyBytes), MESSAGE);
  });

  test('rc.v2 CBC: separate 16-byte iv -> plaintext', async () => {
    const { keyBytes, wc } = await aesKey(size);
    const iv = rand(16);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, wc, bytes(JSON.stringify({ msg: MESSAGE }))));
    const content: EncryptedContent = { algorithm: 'rc.v2.aes-sha2', kid: 'eyJhbGciOiJB', iv: b64(iv), ciphertext: b64(ct) };
    assert.equal(decryptMessage(content, keyBytes), MESSAGE);
  });

  test('legacy raw-text message (no JSON) -> text as is', async () => {
    const { keyBytes, wc } = await aesKey(size);
    const iv = rand(16);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, wc, bytes('hey without json')));
    const content: EncryptedContent = { algorithm: 'rc.v1.aes-sha2', ciphertext: 'af587341640c' + b64(new Uint8Array([...iv, ...ct])) };
    assert.equal(decryptMessage(content, keyBytes), 'hey without json');
  });

  test('rc.v2 GCM: 12-byte iv -> plaintext', async () => {
    const raw = rand(size);
    const wc = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = rand(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, wc, bytes(JSON.stringify({ msg: MESSAGE }))));
    const content: EncryptedContent = { algorithm: 'rc.v2.aes-sha2', kid: 'eyJhbGciOiJB', iv: b64(iv), ciphertext: b64(ct) };
    assert.equal(decryptMessage(content, Buffer.from(raw)), MESSAGE);
  });
});

test('room key of unexpected size -> E2EError, not a crash', () => {
  const content: EncryptedContent = { algorithm: 'rc.v2.aes-sha2', kid: 'k', iv: b64(rand(16)), ciphertext: b64(rand(32)) };
  assert.throws(() => decryptMessage(content, Buffer.from(rand(20))), E2EError);
});

describe('crypto e2e: full chain', () => {
  test('WebCrypto encrypts, we decrypt -> plaintext message', async () => {
    const { wrapper, e2eKey, content } = await make();

    const privateJwk = decryptPrivateKey(JSON.stringify(wrapper), PASSWORD, 'uid-ignore');
    assert.match(privateJwk, /"kty"\s*:\s*"RSA"/);

    const privateKey = importRsaPrivateKey(privateJwk);
    const roomKey = decryptRoomKey(e2eKey, privateKey);
    assert.equal(roomKey.length, 32); // AES-256 = 32 bytes

    const plain = decryptMessage(content, roomKey);
    assert.equal(plain, MESSAGE);
  });

  test('the message keyID matches the room key keyID', async () => {
    const { e2eKey, content, keyId } = await make();
    assert.equal(keyIdOfE2EKey(e2eKey), keyId);
    assert.equal(content.kid, keyId);
  });

  test('wrong password -> E2EError, not a crash', async () => {
    const { wrapper } = await make();
    assert.throws(() => decryptPrivateKey(JSON.stringify(wrapper), 'wrong', 'uid'), E2EError);
  });

  test('tampered message (invalid GCM tag) -> E2EError', async () => {
    const { wrapper, e2eKey, content } = await make();
    const privateKey = importRsaPrivateKey(decryptPrivateKey(JSON.stringify(wrapper), PASSWORD, 'uid'));
    const roomKey = decryptRoomKey(e2eKey, privateKey);
    // Corrupt one ciphertext byte.
    const keyBytes = Buffer.from(content.ciphertext, 'base64');
    keyBytes[0] ^= 0xff;
    const forged: EncryptedContent = { ...content, ciphertext: keyBytes.toString('base64') };
    assert.throws(() => decryptMessage(forged, roomKey), E2EError);
  });
});

describe('crypto e2e: encrypting sent messages', () => {
  const cases = [
    { size: 16, algo: { name: 'AES-CBC' }, ivSize: 16 },
    { size: 32, algo: { name: 'AES-GCM' }, ivSize: 12 },
  ] as const;

  for (const { size, algo, ivSize } of cases) {
    test(`${size}-byte key: WebCrypto (the web client) reads back what we encrypt`, async () => {
      const raw = rand(size);
      const payload = { msg: 'encrypted reply 🔒' };
      const content = encryptMessage(payload, Buffer.from(raw), 'eyJhbGciOiJB');

      assert.equal(content.algorithm, 'rc.v2.aes-sha2');
      assert.equal(content.kid, 'eyJhbGciOiJB');
      const iv = new Uint8Array(Buffer.from(content.iv ?? '', 'base64'));
      assert.equal(iv.length, ivSize);

      const key = await subtle.importKey('raw', raw, algo, false, ['decrypt']);
      const plain = await subtle.decrypt({ ...algo, iv }, key, new Uint8Array(Buffer.from(content.ciphertext, 'base64')));
      assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), payload);
      assert.equal(decryptMessage(content, Buffer.from(raw)), payload.msg);
    });
  }

  test('two sends of the same text do not look alike (fresh IV)', () => {
    const key = Buffer.from(rand(32));
    const a = encryptMessage({ msg: 'same' }, key, 'k');
    const b = encryptMessage({ msg: 'same' }, key, 'k');
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  test('key of unexpected size -> E2EError', () => {
    assert.throws(() => encryptMessage({ msg: 'x' }, Buffer.from(rand(20)), 'k'), E2EError);
  });
});

test('a file payload: text and attachments, file key included', () => {
  const key = Buffer.from(rand(32));
  const attachments = [{ title: 'photo.jpg', encryption: { key: { k: 'abc' }, iv: 'aXY=' } }];
  const content = encryptMessage({ msg: 'caption', attachments }, key, 'k');
  assert.deepEqual(decryptPayload(content, key), { msg: 'caption', attachments });
  assert.deepEqual(decryptPayload(encryptMessage({ msg: 'nothing' }, key, 'k'), key), { msg: 'nothing', attachments: null });
});

describe('crypto e2e: files', () => {
  /** What the web client does: fresh AES-CTR 256 key, 16-byte counter, plaintext digest. */
  async function webFile(plain: Uint8Array<ArrayBuffer>) {
    const key = await subtle.generateKey({ name: 'AES-CTR', length: 256 }, true, ['encrypt']);
    const iv = rand(16);
    const encrypted = new Uint8Array(await subtle.encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, key, plain));
    const fingerprint = Buffer.from(await subtle.digest('SHA-256', plain)).toString('hex');
    const jwk = await subtle.exportKey('jwk', key);
    const attachment = { title: 'photo.jpg', encryption: { key: jwk, iv: b64(iv) }, hashes: { sha256: fingerprint } };
    return { encrypted: Buffer.from(encrypted), attachment };
  }

  test('what the web client encrypts, we read back', async () => {
    const plain = rand(60_000);
    const { encrypted, attachment } = await webFile(plain);
    const encryption = attachmentEncryption(attachment);
    assert.notEqual(encryption, null);
    assert.deepEqual(decryptFile(encrypted, encryption!), Buffer.from(plain));
  });

  test('an altered byte or another key: rejected by the digest', async () => {
    const { encrypted, attachment } = await webFile(rand(1000));
    const encryption = attachmentEncryption(attachment)!;
    const tampered = Buffer.from(encrypted);
    tampered[10] ^= 1;
    assert.throws(() => decryptFile(tampered, encryption), E2EError);
    const other = await webFile(rand(1000));
    assert.throws(() => decryptFile(encrypted, attachmentEncryption(other.attachment)!), E2EError);
  });

  test('what we encrypt, the web client reads back (reimportable JWK key)', async () => {
    const plain = rand(50_000);
    const { encrypted, key, iv, sha256 } = encryptFile(Buffer.from(plain));
    const webKey = await subtle.importKey('jwk', key, { name: 'AES-CTR' }, true, ['encrypt', 'decrypt']);
    const reread = await subtle.decrypt(
      { name: 'AES-CTR', counter: new Uint8Array(Buffer.from(iv, 'base64')), length: 64 },
      webKey,
      new Uint8Array(encrypted),
    );
    assert.deepEqual(Buffer.from(reread), Buffer.from(plain));
    assert.equal(sha256, Buffer.from(await subtle.digest('SHA-256', plain)).toString('hex'));
    const attachment = { encryption: { key, iv }, hashes: { sha256 } };
    assert.deepEqual(decryptFile(encrypted, attachmentEncryption(attachment)!), Buffer.from(plain));
  });

  test('an ordinary attachment has no encryption', () => {
    assert.equal(attachmentEncryption({ title: 'a.pdf', title_link: '/file-upload/x/a.pdf' }), null);
    assert.equal(attachmentEncryption({ encryption: { iv: 'x' } }), null);
    assert.equal(attachmentEncryption(null), null);
  });
});
