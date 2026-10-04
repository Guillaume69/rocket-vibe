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
 * Test croisé, hors-ligne, sans secret commité : WebCrypto (l'implémentation
 * du client web officiel) CHIFFRE dans le format exact de Rocket.Chat, notre
 * module `node:crypto` DÉCHIFFRE. Si les deux mondes s'accordent, le module
 * respecte bien le format `rc.v2.aes-sha2`. Le spike de Phase 0 a prouvé l'autre
 * moitié (contre un vrai serveur) ; ensemble ils tiennent la chaîne.
 */

const { subtle } = webcrypto;
const enc = new TextEncoder();
const b64 = (u8: Uint8Array): string => Buffer.from(u8).toString('base64');
// Tableaux adossés à un ArrayBuffer (et non ArrayBufferLike) pour satisfaire
// `BufferSource` des types WebCrypto — friction TS classique.
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
const ITERATIONS = 1000; // bas pour la vitesse du test ; le code lit la valeur de l'enveloppe
const MESSAGE = 'message secret e2e alice 42';

/** Fabrique un jeu de données chiffré complet dans le format RC, via WebCrypto. */
async function make(): Promise<{
  wrapper: PrivateKeyEnvelope;
  e2eKey: string;
  content: EncryptedContent;
  keyId: string;
}> {
  // 1. paire RSA-OAEP/SHA-256, clé privée exportée en JWK.
  const pair = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  const privateJwk = JSON.stringify(await subtle.exportKey('jwk', pair.privateKey));

  // 2. clé maître PBKDF2 → AES-GCM, chiffre le JWK privé.
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

  // 3. clé de salon AES-GCM, chiffrée RSA-OAEP pour la clé publique, préfixée du keyID.
  const roomKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const roomJwk = JSON.stringify(await subtle.exportKey('jwk', roomKey));
  const rk = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, pair.publicKey, bytes(roomJwk)));
  const keyId = webcrypto.randomUUID(); // 36 caractères
  const e2eKey = keyId + b64(rk);

  // 4. message chiffré avec la clé de salon.
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
 * Jeu au format HÉRITÉ v1 (compte ancien, mesuré sur chat.barrut.me) :
 *   - clé privée `{"$binary": base64(IV(16) || AES-CBC)}`, sel = userId, 1000 iters ;
 *   - clé de salon avec keyID de 12 caractères (`E2EKey` de 356) ;
 *   - message, lui, en v2 (`content` GCM) — un salon v1 dont les nouveaux
 *     messages sont chiffrés par le client récent.
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

  // clé maître v1 : PBKDF2(mot de passe, sel = uid, 1000, SHA-256) → AES-CBC.
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
  const privateKey = JSON.stringify({ $binary: b64(inner) }); // emballage EJSON comme en prod

  // clé de salon v1 : AES-128, keyID de 12 caractères + base64(RSA(sessionJWK)) → E2EKey de 356.
  const roomKey = await subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt', 'decrypt']);
  const roomJwk = JSON.stringify(await subtle.exportKey('jwk', roomKey));
  const rk = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, pair.publicKey, bytes(roomJwk)));
  const keyId = 'af587341640c'; // 12 caractères, comme le relevé prod
  const e2eKey = keyId + b64(rk);

  // message v2 (content GCM) avec la clé de salon.
  const ivM = rand(12);
  const ctM = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: ivM }, roomKey, bytes(JSON.stringify({ msg: MESSAGE }))),
  );
  const content: EncryptedContent = { algorithm: 'rc.v2.aes-sha2', kid: keyId, iv: b64(ivM), ciphertext: b64(ctM) };

  return { privateKey, uid, e2eKey, content };
}

describe('crypto e2e — format hérité v1', () => {
  test('clé privée $binary/CBC + clé de salon keyID 12 + message v2 → clair', async () => {
    const { privateKey, uid, e2eKey, content } = await makeV1();

    const jwk = decryptPrivateKey(privateKey, PASSWORD, uid);
    assert.match(jwk, /"kty"\s*:\s*"RSA"/);

    const priv = importRsaPrivateKey(jwk);
    assert.equal(e2eKey.length, 356); // même longueur que le relevé prod
    assert.equal(keyIdOfE2EKey(e2eKey), 'af587341640c'); // keyID de 12 calculé, pas 36

    const key = decryptRoomKey(e2eKey, priv);
    assert.equal(key.length, 16); // A128, comme le relevé prod
    assert.equal(decryptMessage(content, key), MESSAGE);
  });

  test('mauvais mot de passe sur une clé v1 → ErreurE2E', async () => {
    const { privateKey, uid } = await makeV1();
    assert.throws(() => decryptPrivateKey(privateKey, 'mauvais', uid), E2EError);
  });
});

/**
 * Octets bruts d'une clé AES (Buffer) + clé WebCrypto AES-CBC. Une clé de salon
 * créée par l'ancien client web fait 16 octets (JWK `A128CBC`, relevé sur
 * chat.barrut.me) ; un salon récent, 32.
 */
async function aesKey(size: 16 | 32) {
  const raw = rand(size);
  const wc = await subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['encrypt']);
  return { keyBytes: Buffer.from(raw), wc };
}

for (const size of [16, 32] as const) describe(`crypto e2e — messages CBC, clé de salon de ${size} octets`, () => {
  test('rc.v1 : ciphertext = keyID(12) + base64(IV(16) || CBC) → clair', async () => {
    const { keyBytes, wc } = await aesKey(size);
    const iv = rand(16);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, wc, bytes(JSON.stringify({ msg: MESSAGE }))));
    const blob = new Uint8Array(16 + ct.length);
    blob.set(iv);
    blob.set(ct, 16);
    const content: EncryptedContent = { algorithm: 'rc.v1.aes-sha2', ciphertext: 'af587341640c' + b64(blob) };
    assert.equal(decryptMessage(content, keyBytes), MESSAGE);
  });

  test('rc.v2 CBC : iv de 16 octets séparé → clair', async () => {
    const { keyBytes, wc } = await aesKey(size);
    const iv = rand(16);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, wc, bytes(JSON.stringify({ msg: MESSAGE }))));
    const content: EncryptedContent = { algorithm: 'rc.v2.aes-sha2', kid: 'eyJhbGciOiJB', iv: b64(iv), ciphertext: b64(ct) };
    assert.equal(decryptMessage(content, keyBytes), MESSAGE);
  });

  test('message hérité au texte brut (pas de JSON) → texte tel quel', async () => {
    const { keyBytes, wc } = await aesKey(size);
    const iv = rand(16);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, wc, bytes('coucou sans json')));
    const content: EncryptedContent = { algorithm: 'rc.v1.aes-sha2', ciphertext: 'af587341640c' + b64(new Uint8Array([...iv, ...ct])) };
    assert.equal(decryptMessage(content, keyBytes), 'coucou sans json');
  });

  test('rc.v2 GCM : iv de 12 octets → clair', async () => {
    const raw = rand(size);
    const wc = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = rand(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, wc, bytes(JSON.stringify({ msg: MESSAGE }))));
    const content: EncryptedContent = { algorithm: 'rc.v2.aes-sha2', kid: 'eyJhbGciOiJB', iv: b64(iv), ciphertext: b64(ct) };
    assert.equal(decryptMessage(content, Buffer.from(raw)), MESSAGE);
  });
});

test('clé de salon de taille inattendue → ErreurE2E, pas un crash', () => {
  const content: EncryptedContent = { algorithm: 'rc.v2.aes-sha2', kid: 'k', iv: b64(rand(16)), ciphertext: b64(rand(32)) };
  assert.throws(() => decryptMessage(content, Buffer.from(rand(20))), E2EError);
});

describe('crypto e2e — chaîne complète', () => {
  test('WebCrypto chiffre, forge déchiffre → message clair', async () => {
    const { wrapper, e2eKey, content } = await make();

    const privateJwk = decryptPrivateKey(JSON.stringify(wrapper), PASSWORD, 'uid-ignore');
    assert.match(privateJwk, /"kty"\s*:\s*"RSA"/);

    const privateKey = importRsaPrivateKey(privateJwk);
    const roomKey = decryptRoomKey(e2eKey, privateKey);
    assert.equal(roomKey.length, 32); // AES-256 = 32 octets

    const plain = decryptMessage(content, roomKey);
    assert.equal(plain, MESSAGE);
  });

  test('le keyID du message correspond au keyID de la clé de salon', async () => {
    const { e2eKey, content, keyId } = await make();
    assert.equal(keyIdOfE2EKey(e2eKey), keyId);
    assert.equal(content.kid, keyId);
  });

  test('mauvais mot de passe → ErreurE2E, pas un crash', async () => {
    const { wrapper } = await make();
    assert.throws(() => decryptPrivateKey(JSON.stringify(wrapper), 'mauvais', 'uid'), E2EError);
  });

  test('message falsifié (tag GCM invalide) → ErreurE2E', async () => {
    const { wrapper, e2eKey, content } = await make();
    const privateKey = importRsaPrivateKey(decryptPrivateKey(JSON.stringify(wrapper), PASSWORD, 'uid'));
    const roomKey = decryptRoomKey(e2eKey, privateKey);
    // Corrompre un octet du ciphertext.
    const keyBytes = Buffer.from(content.ciphertext, 'base64');
    keyBytes[0] ^= 0xff;
    const forged: EncryptedContent = { ...content, ciphertext: keyBytes.toString('base64') };
    assert.throws(() => decryptMessage(forged, roomKey), E2EError);
  });
});

describe('crypto e2e — chiffrement des messages envoyés', () => {
  const cases = [
    { size: 16, algo: { name: 'AES-CBC' }, ivSize: 16 },
    { size: 32, algo: { name: 'AES-GCM' }, ivSize: 12 },
  ] as const;

  for (const { size, algo, ivSize } of cases) {
    test(`clé de ${size} octets : WebCrypto (le client web) relit ce que l'on chiffre`, async () => {
      const raw = rand(size);
      const payload = { msg: 'réponse chiffrée 🔒' };
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

  test('deux envois du même texte ne se ressemblent pas (IV neuf)', () => {
    const key = Buffer.from(rand(32));
    const a = encryptMessage({ msg: 'pareil' }, key, 'k');
    const b = encryptMessage({ msg: 'pareil' }, key, 'k');
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  test('clé de taille inattendue → ErreurE2E', () => {
    assert.throws(() => encryptMessage({ msg: 'x' }, Buffer.from(rand(20)), 'k'), E2EError);
  });
});

test('la charge d’un fichier : texte et pièces jointes, clé du fichier comprise', () => {
  const key = Buffer.from(rand(32));
  const attachments = [{ title: 'photo.jpg', encryption: { key: { k: 'abc' }, iv: 'aXY=' } }];
  const content = encryptMessage({ msg: 'légende', attachments }, key, 'k');
  assert.deepEqual(decryptPayload(content, key), { msg: 'légende', attachments });
  assert.deepEqual(decryptPayload(encryptMessage({ msg: 'rien' }, key, 'k'), key), { msg: 'rien', attachments: null });
});

describe('crypto e2e — fichiers', () => {
  /** Ce que fait le client web : clé AES-CTR 256 neuve, compteur de 16 octets, empreinte du clair. */
  async function webFile(plain: Uint8Array<ArrayBuffer>) {
    const key = await subtle.generateKey({ name: 'AES-CTR', length: 256 }, true, ['encrypt']);
    const iv = rand(16);
    const encrypted = new Uint8Array(await subtle.encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, key, plain));
    const fingerprint = Buffer.from(await subtle.digest('SHA-256', plain)).toString('hex');
    const jwk = await subtle.exportKey('jwk', key);
    const attachment = { title: 'photo.jpg', encryption: { key: jwk, iv: b64(iv) }, hashes: { sha256: fingerprint } };
    return { encrypted: Buffer.from(encrypted), attachment };
  }

  test('ce que le client web chiffre, on le relit', async () => {
    const plain = rand(60_000);
    const { encrypted, attachment } = await webFile(plain);
    const encryption = attachmentEncryption(attachment);
    assert.notEqual(encryption, null);
    assert.deepEqual(decryptFile(encrypted, encryption!), Buffer.from(plain));
  });

  test('un octet altéré ou une autre clé : refusé par l’empreinte', async () => {
    const { encrypted, attachment } = await webFile(rand(1000));
    const encryption = attachmentEncryption(attachment)!;
    const tampered = Buffer.from(encrypted);
    tampered[10] ^= 1;
    assert.throws(() => decryptFile(tampered, encryption), E2EError);
    const other = await webFile(rand(1000));
    assert.throws(() => decryptFile(encrypted, attachmentEncryption(other.attachment)!), E2EError);
  });

  test('ce que l’on chiffre, le client web le relit (clé JWK réimportable)', async () => {
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

  test('une pièce jointe ordinaire n’a pas de chiffrement', () => {
    assert.equal(attachmentEncryption({ title: 'a.pdf', title_link: '/file-upload/x/a.pdf' }), null);
    assert.equal(attachmentEncryption({ encryption: { iv: 'x' } }), null);
    assert.equal(attachmentEncryption(null), null);
  });
});
