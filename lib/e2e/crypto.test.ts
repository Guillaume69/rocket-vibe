import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  dechiffrerClePrivee,
  dechiffrerCleSalon,
  dechiffrerMessage,
  ErreurE2E,
  importerClePriveeRSA,
  keyIdDeE2EKey,
  type ContenuChiffre,
  type EnveloppeClePrivee,
} from './crypto.ts';

/**
 * Test croisé, hors-ligne, sans secret commité : WebCrypto (l'implémentation
 * du client web officiel) CHIFFRE dans le format exact de Rocket.Chat, notre
 * module node-forge DÉCHIFFRE. Si les deux mondes s'accordent, forge respecte
 * bien le format `rc.v2.aes-sha2`. Le spike de Phase 0 a prouvé l'autre moitié
 * (forge contre un vrai serveur) ; ensemble ils tiennent la chaîne.
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
  enveloppe: EnveloppeClePrivee;
  e2eKey: string;
  contenu: ContenuChiffre;
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
  const enveloppe: EnveloppeClePrivee = {
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
  const contenu: ContenuChiffre = {
    algorithm: 'rc.v2.aes-sha2',
    kid: keyId,
    iv: b64(ivMsg),
    ciphertext: b64(ctMsg),
  };

  return { enveloppe, e2eKey, contenu, keyId };
}

describe('crypto e2e — chaîne complète', () => {
  test('WebCrypto chiffre, forge déchiffre → message clair', async () => {
    const { enveloppe, e2eKey, contenu } = await fabriquer();

    const jwkPrivee = dechiffrerClePrivee(enveloppe, MOT_DE_PASSE);
    assert.match(jwkPrivee, /"kty"\s*:\s*"RSA"/);

    const clePrivee = importerClePriveeRSA(jwkPrivee);
    const cleSalon = dechiffrerCleSalon(e2eKey, clePrivee);
    assert.equal(cleSalon.length, 32); // AES-256 = 32 octets

    const clair = dechiffrerMessage(contenu, cleSalon);
    assert.equal(clair, MESSAGE);
  });

  test('le keyID du message correspond au keyID de la clé de salon', async () => {
    const { e2eKey, contenu, keyId } = await fabriquer();
    assert.equal(keyIdDeE2EKey(e2eKey), keyId);
    assert.equal(contenu.kid, keyId);
  });

  test('mauvais mot de passe → ErreurE2E, pas un crash', async () => {
    const { enveloppe } = await fabriquer();
    assert.throws(() => dechiffrerClePrivee(enveloppe, 'mauvais mot de passe'), ErreurE2E);
  });

  test('message falsifié (tag GCM invalide) → ErreurE2E', async () => {
    const { enveloppe, e2eKey, contenu } = await fabriquer();
    const clePrivee = importerClePriveeRSA(dechiffrerClePrivee(enveloppe, MOT_DE_PASSE));
    const cleSalon = dechiffrerCleSalon(e2eKey, clePrivee);
    // Corrompre un octet du ciphertext.
    const octets = Buffer.from(contenu.ciphertext, 'base64');
    octets[0] ^= 0xff;
    const falsifie: ContenuChiffre = { ...contenu, ciphertext: octets.toString('base64') };
    assert.throws(() => dechiffrerMessage(falsifie, cleSalon), ErreurE2E);
  });
});
