import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { describe, test } from 'node:test';

import { E2EError, type EncryptedContent, type PrivateKeyEnvelope } from './crypto.ts';
import { E2EEngine, type ClientE2E, type E2EKeyStorage } from './engine.ts';

const { subtle } = webcrypto;
const enc = new TextEncoder();
const b64 = (u8: Uint8Array): string => Buffer.from(u8).toString('base64');
// ArrayBuffer-backed (not ArrayBufferLike) to satisfy `BufferSource`.
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

const RID = '6a5548728d3f0c034622efbc';
const PASSWORD = 'correct horse battery staple';
const MESSAGE = 'message secret e2e alice 42';

/** Encrypted fixture in the RC format via WebCrypto (as the official client would). */
async function make(): Promise<{
  fetchMyKeys: { public_key: string; private_key: string };
  e2eKey: string;
  content: EncryptedContent;
}> {
  const pair = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  const privateJwk = JSON.stringify(await subtle.exportKey('jwk', pair.privateKey));
  const publicJwk = JSON.stringify(await subtle.exportKey('jwk', pair.publicKey));

  const salt = `v2:osR3JzQEiM2H77m46:${webcrypto.randomUUID()}`;
  const base = await subtle.importKey('raw', bytes(PASSWORD), 'PBKDF2', false, ['deriveKey']);
  const masterKey = await subtle.deriveKey(
    { name: 'PBKDF2', salt: bytes(salt), iterations: 1000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const ivP = rand(12);
  const ctP = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: ivP }, masterKey, bytes(privateJwk)));
  const wrapper: PrivateKeyEnvelope = { iv: b64(ivP), ciphertext: b64(ctP), salt, iterations: 1000 };

  const roomKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const roomJwk = JSON.stringify(await subtle.exportKey('jwk', roomKey));
  const rk = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, pair.publicKey, bytes(roomJwk)));
  const keyId = webcrypto.randomUUID();
  const e2eKey = keyId + b64(rk);

  const ivM = rand(12);
  const ctM = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: ivM }, roomKey, bytes(JSON.stringify({ msg: MESSAGE }))),
  );
  const content: EncryptedContent = { algorithm: 'rc.v2.aes-sha2', kid: keyId, iv: b64(ivM), ciphertext: b64(ctM) };

  void publicJwk;
  return { fetchMyKeys: { public_key: publicJwk, private_key: JSON.stringify(wrapper) }, e2eKey, content };
}

/**
 * One MORE room key, under the same RSA pair, to simulate the rotation caused
 * by removing a member from the room.
 */
async function makeRoomKey(
  publicJwk: string,
  message: string,
): Promise<{ e2eKey: string; content: EncryptedContent }> {
  const publicKey = await subtle.importKey(
    'jwk',
    JSON.parse(publicJwk) as JsonWebKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    ['encrypt'],
  );
  const roomKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const roomJwk = JSON.stringify(await subtle.exportKey('jwk', roomKey));
  const rk = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, bytes(roomJwk)));
  const keyId = webcrypto.randomUUID();

  const iv = rand(12);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, roomKey, bytes(JSON.stringify({ msg: message }))),
  );
  return {
    e2eKey: keyId + b64(rk),
    content: { algorithm: 'rc.v2.aes-sha2', kid: keyId, iv: b64(iv), ciphertext: b64(ct) },
  };
}

function fake(fetchMyKeys: unknown): { client: ClientE2E; storage: E2EKeyStorage; read: () => string | null } {
  const client: ClientE2E = { get: async () => fetchMyKeys as never };
  let stored: string | null = null;
  const storage: E2EKeyStorage = {
    read: async () => stored,
    save: async (v) => { stored = v; },
    clear: async () => { stored = null; },
  };
  return { client, storage, read: () => stored };
}

describe('E2EEngine', () => {
  test('unlocks, caches the room key, decrypts a message', async () => {
    const { fetchMyKeys, e2eKey, content } = await make();
    const { client, storage, read } = fake(fetchMyKeys);
    const m = new E2EEngine({ client, storage, uid: 'osR3JzQEiM2H77m46' });

    assert.equal(m.isUnlocked, false);
    assert.equal(m.decryptContent(RID, content), null); // locked -> null

    await m.unlock(PASSWORD);
    assert.equal(m.isUnlocked, true);
    assert.notEqual(read(), null); // private key persisted

    m.saveRoomKey(RID, e2eKey);
    assert.equal(m.decryptContent(RID, content)?.text, MESSAGE);
  });

  test('decrypts even if saveRoomKey happens before unlocking', async () => {
    const { fetchMyKeys, e2eKey, content } = await make();
    const { client, storage } = fake(fetchMyKeys);
    const m = new E2EEngine({ client, storage, uid: 'osR3JzQEiM2H77m46' });
    m.saveRoomKey(RID, e2eKey); // E2EKey known before the private key
    await m.unlock(PASSWORD);
    assert.equal(m.decryptContent(RID, content)?.text, MESSAGE);
  });

  test('a room key ROTATION is taken into account, not ignored', async () => {
    // Removing a member from the room rotates its key: the server pushes a NEW
    // E2EKey on the same rid. The `roomKeys` cache then holds the stale AES
    // key, and `decryptContent` checks it FIRST; without invalidation, every
    // later message stayed on the 🔒 placeholder until the app restarted, with
    // no hint of the cause.
    const { fetchMyKeys, e2eKey, content } = await make();
    const { client, storage } = fake(fetchMyKeys);
    const m = new E2EEngine({ client, storage, uid: 'osR3JzQEiM2H77m46' });
    await m.unlock(PASSWORD);
    m.saveRoomKey(RID, e2eKey);
    assert.equal(m.decryptContent(RID, content)?.text, MESSAGE);

    const AFTER = 'message posté après la rotation';
    const rot = await makeRoomKey(fetchMyKeys.public_key, AFTER);
    m.saveRoomKey(RID, rot.e2eKey);
    assert.equal(m.decryptContent(RID, rot.content)?.text, AFTER);
    assert.equal(m.roomKeyId(RID), rot.e2eKey.slice(0, 36));
  });

  test('saving the SAME key again breaks nothing (idempotent)', async () => {
    const { fetchMyKeys, e2eKey, content } = await make();
    const { client, storage } = fake(fetchMyKeys);
    const m = new E2EEngine({ client, storage, uid: 'osR3JzQEiM2H77m46' });
    await m.unlock(PASSWORD);
    m.saveRoomKey(RID, e2eKey);
    m.saveRoomKey(RID, e2eKey);
    m.saveRoomKey(RID, e2eKey);
    assert.equal(m.decryptContent(RID, content)?.text, MESSAGE);
  });

  test('resume() reimports the Keystore key without a password', async () => {
    const { fetchMyKeys, e2eKey, content } = await make();
    const { client, storage } = fake(fetchMyKeys);
    await new E2EEngine({ client, storage, uid: 'osR3JzQEiM2H77m46' }).unlock(PASSWORD); // fills the Keystore

    const m2 = new E2EEngine({ client, storage, uid: 'osR3JzQEiM2H77m46' });
    assert.equal(await m2.resume(), true);
    assert.equal(m2.isUnlocked, true);
    m2.saveRoomKey(RID, e2eKey);
    assert.equal(m2.decryptContent(RID, content)?.text, MESSAGE);
  });

  test('lock() forgets everything and clears the Keystore', async () => {
    const { fetchMyKeys, e2eKey, content } = await make();
    const { client, storage, read } = fake(fetchMyKeys);
    const m = new E2EEngine({ client, storage, uid: 'osR3JzQEiM2H77m46' });
    await m.unlock(PASSWORD);
    m.saveRoomKey(RID, e2eKey);

    await m.lock();
    assert.equal(m.isUnlocked, false);
    assert.equal(read(), null);
    assert.equal(m.decryptContent(RID, content), null);
  });

  test('wrong password -> E2EError, stays locked', async () => {
    const { fetchMyKeys } = await make();
    const { client, storage, read } = fake(fetchMyKeys);
    const m = new E2EEngine({ client, storage, uid: 'osR3JzQEiM2H77m46' });
    await assert.rejects(() => m.unlock('mauvais'), E2EError);
    assert.equal(m.isUnlocked, false);
    assert.equal(read(), null);
  });

  test('subscribe is notified on unlock and on lock', async () => {
    const { fetchMyKeys } = await make();
    const { client, storage } = fake(fetchMyKeys);
    const m = new E2EEngine({ client, storage, uid: 'osR3JzQEiM2H77m46' });
    let n = 0;
    m.subscribe(() => { n += 1; });
    await m.unlock(PASSWORD);
    await m.lock();
    assert.equal(n, 2);
  });
});

describe('E2EEngine: encrypt', () => {
  test('locked or without a room key -> null, never plaintext', async () => {
    const { fetchMyKeys, e2eKey } = await make();
    const { client, storage } = fake(fetchMyKeys);
    const m = new E2EEngine({ client, storage, uid: 'osR3JzQEiM2H77m46' });
    m.saveRoomKey(RID, e2eKey);
    assert.equal(m.encrypt(RID, { msg: 'x' }), null);
    await m.unlock(PASSWORD);
    assert.equal(m.encrypt('autre-salon', { msg: 'x' }), null);
  });

  test('encrypts under the room key and keyID, read back by decryptContent', async () => {
    const { fetchMyKeys, e2eKey } = await make();
    const { client, storage } = fake(fetchMyKeys);
    const m = new E2EEngine({ client, storage, uid: 'osR3JzQEiM2H77m46' });
    await m.unlock(PASSWORD);
    m.saveRoomKey(RID, e2eKey);

    const content = m.encrypt(RID, { msg: 'envoyé chiffré' });
    assert.notEqual(content, null);
    assert.equal(content?.kid, e2eKey.slice(0, 36));
    assert.equal(m.decryptContent(RID, content as EncryptedContent)?.text, 'envoyé chiffré');
  });

  test('after a rotation, encrypts under the NEW key', async () => {
    const { fetchMyKeys, e2eKey } = await make();
    const { client, storage } = fake(fetchMyKeys);
    const m = new E2EEngine({ client, storage, uid: 'osR3JzQEiM2H77m46' });
    await m.unlock(PASSWORD);
    m.saveRoomKey(RID, e2eKey);
    m.encrypt(RID, { msg: 'avant' });

    const rot = await makeRoomKey(fetchMyKeys.public_key, 'ignoré');
    m.saveRoomKey(RID, rot.e2eKey);
    const content = m.encrypt(RID, { msg: 'après' });
    assert.equal(content?.kid, rot.e2eKey.slice(0, 36));
    assert.equal(m.decryptContent(RID, content as EncryptedContent)?.text, 'après');
  });
});
