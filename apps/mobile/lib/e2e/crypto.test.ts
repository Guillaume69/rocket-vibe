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

const MOT_DE_PASSE = 'oppose update message economy float mail palace drive horse';
const SALT = 'v2:osR3JzQEiM2H77m46:d280e4f2-c685-4813-80f7-13438befaddd';
const ITERATIONS = 1000; // bas pour la vitesse du test ; le code lit la valeur de l'enveloppe
const MESSAGE = 'message secret e2e alice 42';

/** Fabrique un jeu de données chiffré complet dans le format RC, via WebCrypto. */
async function fabriquer(): Promise<{
  wrapper: PrivateKeyEnvelope;
  e2eKey: string;
  content: EncryptedContent;
  keyId: string;
}> {
  // 1. paire RSA-OAEP/SHA-256, clé privée exportée en JWK.
  const paire = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  const jwkPrivee = JSON.stringify(await subtle.exportKey('jwk', paire.privateKey));

  // 2. clé maître PBKDF2 → AES-GCM, chiffre le JWK privé.
  const base = await subtle.importKey('raw', bytes(MOT_DE_PASSE), 'PBKDF2', false, ['deriveKey']);
  const cleMaitre = await subtle.deriveKey(
    { name: 'PBKDF2', salt: bytes(SALT), iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const ivPrivee = rand(12);
  const ctPrivee = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: ivPrivee }, cleMaitre, bytes(jwkPrivee)),
  );
  const enveloppe: PrivateKeyEnvelope = {
    iv: b64(ivPrivee),
    ciphertext: b64(ctPrivee),
    salt: SALT,
    iterations: ITERATIONS,
  };

  // 3. clé de salon AES-GCM, chiffrée RSA-OAEP pour la clé publique, préfixée du keyID.
  const cleSalon = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const jwkSalon = JSON.stringify(await subtle.exportKey('jwk', cleSalon));
  const rk = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, paire.publicKey, bytes(jwkSalon)));
  const keyId = webcrypto.randomUUID(); // 36 caractères
  const e2eKey = keyId + b64(rk);

  // 4. message chiffré avec la clé de salon.
  const ivMsg = rand(12);
  const ctMsg = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: ivMsg }, cleSalon, bytes(JSON.stringify({ msg: MESSAGE }))),
  );
  const contenu: EncryptedContent = {
    algorithm: 'rc.v2.aes-sha2',
    kid: keyId,
    iv: b64(ivMsg),
    ciphertext: b64(ctMsg),
  };

  return { wrapper: enveloppe, e2eKey, content: contenu, keyId };
}

/**
 * Jeu au format HÉRITÉ v1 (compte ancien, mesuré sur chat.barrut.me) :
 *   - clé privée `{"$binary": base64(IV(16) || AES-CBC)}`, sel = userId, 1000 iters ;
 *   - clé de salon avec keyID de 12 caractères (`E2EKey` de 356) ;
 *   - message, lui, en v2 (`content` GCM) — un salon v1 dont les nouveaux
 *     messages sont chiffrés par le client récent.
 */
async function fabriquerV1(): Promise<{
  privateKey: string;
  uid: string;
  e2eKey: string;
  content: EncryptedContent;
}> {
  const uid = 'osR3JzQEiM2H77m46';
  const paire = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  const jwkPrivee = JSON.stringify(await subtle.exportKey('jwk', paire.privateKey));

  // clé maître v1 : PBKDF2(mot de passe, sel = uid, 1000, SHA-256) → AES-CBC.
  const base = await subtle.importKey('raw', bytes(MOT_DE_PASSE), 'PBKDF2', false, ['deriveKey']);
  const master = await subtle.deriveKey(
    { name: 'PBKDF2', salt: bytes(uid), iterations: 1000, hash: 'SHA-256' },
    base,
    { name: 'AES-CBC', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const iv = rand(16);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, master, bytes(jwkPrivee)));
  const inner = new Uint8Array(iv.length + ct.length);
  inner.set(iv);
  inner.set(ct, iv.length);
  const privateKey = JSON.stringify({ $binary: b64(inner) }); // emballage EJSON comme en prod

  // clé de salon v1 : AES-128, keyID de 12 caractères + base64(RSA(sessionJWK)) → E2EKey de 356.
  const cleSalon = await subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt', 'decrypt']);
  const jwkSalon = JSON.stringify(await subtle.exportKey('jwk', cleSalon));
  const rk = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, paire.publicKey, bytes(jwkSalon)));
  const keyId = 'af587341640c'; // 12 caractères, comme le relevé prod
  const e2eKey = keyId + b64(rk);

  // message v2 (content GCM) avec la clé de salon.
  const ivM = rand(12);
  const ctM = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: ivM }, cleSalon, bytes(JSON.stringify({ msg: MESSAGE }))),
  );
  const contenu: EncryptedContent = { algorithm: 'rc.v2.aes-sha2', kid: keyId, iv: b64(ivM), ciphertext: b64(ctM) };

  return { privateKey, uid, e2eKey, content: contenu };
}

describe('crypto e2e — format hérité v1', () => {
  test('clé privée $binary/CBC + clé de salon keyID 12 + message v2 → clair', async () => {
    const { privateKey, uid, e2eKey, content: contenu } = await fabriquerV1();

    const jwk = decryptPrivateKey(privateKey, MOT_DE_PASSE, uid);
    assert.match(jwk, /"kty"\s*:\s*"RSA"/);

    const priv = importRsaPrivateKey(jwk);
    assert.equal(e2eKey.length, 356); // même longueur que le relevé prod
    assert.equal(keyIdOfE2EKey(e2eKey), 'af587341640c'); // keyID de 12 calculé, pas 36

    const cle = decryptRoomKey(e2eKey, priv);
    assert.equal(cle.length, 16); // A128, comme le relevé prod
    assert.equal(decryptMessage(contenu, cle), MESSAGE);
  });

  test('mauvais mot de passe sur une clé v1 → ErreurE2E', async () => {
    const { privateKey, uid } = await fabriquerV1();
    assert.throws(() => decryptPrivateKey(privateKey, 'mauvais', uid), E2EError);
  });
});

/**
 * Octets bruts d'une clé AES (Buffer) + clé WebCrypto AES-CBC. Une clé de salon
 * créée par l'ancien client web fait 16 octets (JWK `A128CBC`, relevé sur
 * chat.barrut.me) ; un salon récent, 32.
 */
async function cleAes(taille: 16 | 32) {
  const raw = rand(taille);
  const wc = await subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['encrypt']);
  return { octets: Buffer.from(raw), wc };
}

for (const taille of [16, 32] as const) describe(`crypto e2e — messages CBC, clé de salon de ${taille} octets`, () => {
  test('rc.v1 : ciphertext = keyID(12) + base64(IV(16) || CBC) → clair', async () => {
    const { octets, wc } = await cleAes(taille);
    const iv = rand(16);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, wc, bytes(JSON.stringify({ msg: MESSAGE }))));
    const blob = new Uint8Array(16 + ct.length);
    blob.set(iv);
    blob.set(ct, 16);
    const contenu: EncryptedContent = { algorithm: 'rc.v1.aes-sha2', ciphertext: 'af587341640c' + b64(blob) };
    assert.equal(decryptMessage(contenu, octets), MESSAGE);
  });

  test('rc.v2 CBC : iv de 16 octets séparé → clair', async () => {
    const { octets, wc } = await cleAes(taille);
    const iv = rand(16);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, wc, bytes(JSON.stringify({ msg: MESSAGE }))));
    const contenu: EncryptedContent = { algorithm: 'rc.v2.aes-sha2', kid: 'eyJhbGciOiJB', iv: b64(iv), ciphertext: b64(ct) };
    assert.equal(decryptMessage(contenu, octets), MESSAGE);
  });

  test('message hérité au texte brut (pas de JSON) → texte tel quel', async () => {
    const { octets, wc } = await cleAes(taille);
    const iv = rand(16);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, wc, bytes('coucou sans json')));
    const contenu: EncryptedContent = { algorithm: 'rc.v1.aes-sha2', ciphertext: 'af587341640c' + b64(new Uint8Array([...iv, ...ct])) };
    assert.equal(decryptMessage(contenu, octets), 'coucou sans json');
  });

  test('rc.v2 GCM : iv de 12 octets → clair', async () => {
    const raw = rand(taille);
    const wc = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = rand(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, wc, bytes(JSON.stringify({ msg: MESSAGE }))));
    const contenu: EncryptedContent = { algorithm: 'rc.v2.aes-sha2', kid: 'eyJhbGciOiJB', iv: b64(iv), ciphertext: b64(ct) };
    assert.equal(decryptMessage(contenu, Buffer.from(raw)), MESSAGE);
  });
});

test('clé de salon de taille inattendue → ErreurE2E, pas un crash', () => {
  const contenu: EncryptedContent = { algorithm: 'rc.v2.aes-sha2', kid: 'k', iv: b64(rand(16)), ciphertext: b64(rand(32)) };
  assert.throws(() => decryptMessage(contenu, Buffer.from(rand(20))), E2EError);
});

describe('crypto e2e — chaîne complète', () => {
  test('WebCrypto chiffre, forge déchiffre → message clair', async () => {
    const { wrapper: enveloppe, e2eKey, content: contenu } = await fabriquer();

    const jwkPrivee = decryptPrivateKey(JSON.stringify(enveloppe), MOT_DE_PASSE, 'uid-ignore');
    assert.match(jwkPrivee, /"kty"\s*:\s*"RSA"/);

    const clePrivee = importRsaPrivateKey(jwkPrivee);
    const cleSalon = decryptRoomKey(e2eKey, clePrivee);
    assert.equal(cleSalon.length, 32); // AES-256 = 32 octets

    const clair = decryptMessage(contenu, cleSalon);
    assert.equal(clair, MESSAGE);
  });

  test('le keyID du message correspond au keyID de la clé de salon', async () => {
    const { e2eKey, content: contenu, keyId } = await fabriquer();
    assert.equal(keyIdOfE2EKey(e2eKey), keyId);
    assert.equal(contenu.kid, keyId);
  });

  test('mauvais mot de passe → ErreurE2E, pas un crash', async () => {
    const { wrapper: enveloppe } = await fabriquer();
    assert.throws(() => decryptPrivateKey(JSON.stringify(enveloppe), 'mauvais', 'uid'), E2EError);
  });

  test('message falsifié (tag GCM invalide) → ErreurE2E', async () => {
    const { wrapper: enveloppe, e2eKey, content: contenu } = await fabriquer();
    const clePrivee = importRsaPrivateKey(decryptPrivateKey(JSON.stringify(enveloppe), MOT_DE_PASSE, 'uid'));
    const cleSalon = decryptRoomKey(e2eKey, clePrivee);
    // Corrompre un octet du ciphertext.
    const octets = Buffer.from(contenu.ciphertext, 'base64');
    octets[0] ^= 0xff;
    const falsifie: EncryptedContent = { ...contenu, ciphertext: octets.toString('base64') };
    assert.throws(() => decryptMessage(falsifie, cleSalon), E2EError);
  });
});

describe('crypto e2e — chiffrement des messages envoyés', () => {
  const cas = [
    { size: 16, algo: { name: 'AES-CBC' }, tailleIv: 16 },
    { size: 32, algo: { name: 'AES-GCM' }, tailleIv: 12 },
  ] as const;

  for (const { size: taille, algo, tailleIv } of cas) {
    test(`clé de ${taille} octets : WebCrypto (le client web) relit ce que l'on chiffre`, async () => {
      const raw = rand(taille);
      const charge = { msg: 'réponse chiffrée 🔒' };
      const contenu = encryptMessage(charge, Buffer.from(raw), 'eyJhbGciOiJB');

      assert.equal(contenu.algorithm, 'rc.v2.aes-sha2');
      assert.equal(contenu.kid, 'eyJhbGciOiJB');
      const iv = new Uint8Array(Buffer.from(contenu.iv ?? '', 'base64'));
      assert.equal(iv.length, tailleIv);

      const cle = await subtle.importKey('raw', raw, algo, false, ['decrypt']);
      const clair = await subtle.decrypt({ ...algo, iv }, cle, new Uint8Array(Buffer.from(contenu.ciphertext, 'base64')));
      assert.deepEqual(JSON.parse(new TextDecoder().decode(clair)), charge);
      assert.equal(decryptMessage(contenu, Buffer.from(raw)), charge.msg);
    });
  }

  test('deux envois du même texte ne se ressemblent pas (IV neuf)', () => {
    const cle = Buffer.from(rand(32));
    const a = encryptMessage({ msg: 'pareil' }, cle, 'k');
    const b = encryptMessage({ msg: 'pareil' }, cle, 'k');
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  test('clé de taille inattendue → ErreurE2E', () => {
    assert.throws(() => encryptMessage({ msg: 'x' }, Buffer.from(rand(20)), 'k'), E2EError);
  });
});

test('la charge d’un fichier : texte et pièces jointes, clé du fichier comprise', () => {
  const cle = Buffer.from(rand(32));
  const attachments = [{ title: 'photo.jpg', encryption: { key: { k: 'abc' }, iv: 'aXY=' } }];
  const contenu = encryptMessage({ msg: 'légende', attachments }, cle, 'k');
  assert.deepEqual(decryptPayload(contenu, cle), { msg: 'légende', attachments });
  assert.deepEqual(decryptPayload(encryptMessage({ msg: 'rien' }, cle, 'k'), cle), { msg: 'rien', attachments: null });
});

describe('crypto e2e — fichiers', () => {
  /** Ce que fait le client web : clé AES-CTR 256 neuve, compteur de 16 octets, empreinte du clair. */
  async function fichierDuWeb(clair: Uint8Array<ArrayBuffer>) {
    const cle = await subtle.generateKey({ name: 'AES-CTR', length: 256 }, true, ['encrypt']);
    const iv = rand(16);
    const chiffre = new Uint8Array(await subtle.encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, cle, clair));
    const empreinte = Buffer.from(await subtle.digest('SHA-256', clair)).toString('hex');
    const jwk = await subtle.exportKey('jwk', cle);
    const jointe = { title: 'photo.jpg', encryption: { key: jwk, iv: b64(iv) }, hashes: { sha256: empreinte } };
    return { encrypted: Buffer.from(chiffre), jointe };
  }

  test('ce que le client web chiffre, on le relit', async () => {
    const clair = rand(60_000);
    const { encrypted: chiffre, jointe } = await fichierDuWeb(clair);
    const chiffrement = attachmentEncryption(jointe);
    assert.notEqual(chiffrement, null);
    assert.deepEqual(decryptFile(chiffre, chiffrement!), Buffer.from(clair));
  });

  test('un octet altéré ou une autre clé : refusé par l’empreinte', async () => {
    const { encrypted: chiffre, jointe } = await fichierDuWeb(rand(1000));
    const chiffrement = attachmentEncryption(jointe)!;
    const altere = Buffer.from(chiffre);
    altere[10] ^= 1;
    assert.throws(() => decryptFile(altere, chiffrement), E2EError);
    const autre = await fichierDuWeb(rand(1000));
    assert.throws(() => decryptFile(chiffre, attachmentEncryption(autre.jointe)!), E2EError);
  });

  test('ce que l’on chiffre, le client web le relit (clé JWK réimportable)', async () => {
    const clair = rand(50_000);
    const { encrypted: chiffre, key: cle, iv, sha256 } = encryptFile(Buffer.from(clair));
    const cleWeb = await subtle.importKey('jwk', cle, { name: 'AES-CTR' }, true, ['encrypt', 'decrypt']);
    const relu = await subtle.decrypt(
      { name: 'AES-CTR', counter: new Uint8Array(Buffer.from(iv, 'base64')), length: 64 },
      cleWeb,
      new Uint8Array(chiffre),
    );
    assert.deepEqual(Buffer.from(relu), Buffer.from(clair));
    assert.equal(sha256, Buffer.from(await subtle.digest('SHA-256', clair)).toString('hex'));
    const jointe = { encryption: { key: cle, iv }, hashes: { sha256 } };
    assert.deepEqual(decryptFile(chiffre, attachmentEncryption(jointe)!), Buffer.from(clair));
  });

  test('une pièce jointe ordinaire n’a pas de chiffrement', () => {
    assert.equal(attachmentEncryption({ title: 'a.pdf', title_link: '/file-upload/x/a.pdf' }), null);
    assert.equal(attachmentEncryption({ encryption: { iv: 'x' } }), null);
    assert.equal(attachmentEncryption(null), null);
  });
});
