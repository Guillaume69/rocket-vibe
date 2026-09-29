import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { describe, test } from 'node:test';

import { ErreurE2E, type ContenuChiffre, type EnveloppeClePrivee } from './crypto.ts';
import { MoteurE2E, type ClientE2E, type StockageCleE2E } from './moteur.ts';

const { subtle } = webcrypto;
const enc = new TextEncoder();
const b64 = (u8: Uint8Array): string => Buffer.from(u8).toString('base64');
// ArrayBuffer-backed (pas ArrayBufferLike) pour satisfaire `BufferSource`.
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
const MOT_DE_PASSE = 'correct horse battery staple';
const MESSAGE = 'message secret e2e alice 42';

/** Jeu chiffré au format RC via WebCrypto (comme le ferait le client officiel). */
async function fabriquer(): Promise<{
  fetchMyKeys: { public_key: string; private_key: string };
  e2eKey: string;
  contenu: ContenuChiffre;
}> {
  const paire = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  );
  const jwkPrivee = JSON.stringify(await subtle.exportKey('jwk', paire.privateKey));
  const jwkPublique = JSON.stringify(await subtle.exportKey('jwk', paire.publicKey));

  const salt = `v2:osR3JzQEiM2H77m46:${webcrypto.randomUUID()}`;
  const base = await subtle.importKey('raw', bytes(MOT_DE_PASSE), 'PBKDF2', false, ['deriveKey']);
  const cleMaitre = await subtle.deriveKey(
    { name: 'PBKDF2', salt: bytes(salt), iterations: 1000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const ivP = rand(12);
  const ctP = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: ivP }, cleMaitre, bytes(jwkPrivee)));
  const enveloppe: EnveloppeClePrivee = { iv: b64(ivP), ciphertext: b64(ctP), salt, iterations: 1000 };

  const cleSalon = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const jwkSalon = JSON.stringify(await subtle.exportKey('jwk', cleSalon));
  const rk = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, paire.publicKey, bytes(jwkSalon)));
  const keyId = webcrypto.randomUUID();
  const e2eKey = keyId + b64(rk);

  const ivM = rand(12);
  const ctM = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: ivM }, cleSalon, bytes(JSON.stringify({ msg: MESSAGE }))),
  );
  const contenu: ContenuChiffre = { algorithm: 'rc.v2.aes-sha2', kid: keyId, iv: b64(ivM), ciphertext: b64(ctM) };

  void jwkPublique;
  return { fetchMyKeys: { public_key: jwkPublique, private_key: JSON.stringify(enveloppe) }, e2eKey, contenu };
}

/**
 * Une clé de salon DE PLUS, sous la même paire RSA — de quoi simuler la
 * rotation que provoque le retrait d'un membre du salon.
 */
async function fabriquerCleSalon(
  jwkPublique: string,
  message: string,
): Promise<{ e2eKey: string; contenu: ContenuChiffre }> {
  const publique = await subtle.importKey(
    'jwk',
    JSON.parse(jwkPublique) as JsonWebKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    ['encrypt'],
  );
  const cleSalon = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const jwkSalon = JSON.stringify(await subtle.exportKey('jwk', cleSalon));
  const rk = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, publique, bytes(jwkSalon)));
  const keyId = webcrypto.randomUUID();

  const iv = rand(12);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, cleSalon, bytes(JSON.stringify({ msg: message }))),
  );
  return {
    e2eKey: keyId + b64(rk),
    contenu: { algorithm: 'rc.v2.aes-sha2', kid: keyId, iv: b64(iv), ciphertext: b64(ct) },
  };
}

function faux(fetchMyKeys: unknown): { client: ClientE2E; stockage: StockageCleE2E; lu: () => string | null } {
  const client: ClientE2E = { get: async () => fetchMyKeys as never };
  let stocke: string | null = null;
  const stockage: StockageCleE2E = {
    lire: async () => stocke,
    enregistrer: async (v) => { stocke = v; },
    effacer: async () => { stocke = null; },
  };
  return { client, stockage, lu: () => stocke };
}

describe('MoteurE2E', () => {
  test('déverrouille, cache la clé de salon, déchiffre un message', async () => {
    const { fetchMyKeys, e2eKey, contenu } = await fabriquer();
    const { client, stockage, lu } = faux(fetchMyKeys);
    const m = new MoteurE2E({ client, stockage, uid: 'osR3JzQEiM2H77m46' });

    assert.equal(m.estDeverrouille, false);
    assert.equal(m.dechiffrerContenu(RID, contenu), null); // verrouillé → null

    await m.deverrouiller(MOT_DE_PASSE);
    assert.equal(m.estDeverrouille, true);
    assert.notEqual(lu(), null); // clé privée persistée

    m.enregistrerCleSalon(RID, e2eKey);
    assert.equal(m.dechiffrerContenu(RID, contenu), MESSAGE);
  });

  test('déchiffre même si enregistrerCleSalon a lieu avant le déverrouillage', async () => {
    const { fetchMyKeys, e2eKey, contenu } = await fabriquer();
    const { client, stockage } = faux(fetchMyKeys);
    const m = new MoteurE2E({ client, stockage, uid: 'osR3JzQEiM2H77m46' });
    m.enregistrerCleSalon(RID, e2eKey); // E2EKey connu avant d'avoir la clé privée
    await m.deverrouiller(MOT_DE_PASSE);
    assert.equal(m.dechiffrerContenu(RID, contenu), MESSAGE);
  });

  test('une ROTATION de clé de salon est prise en compte, pas ignorée', async () => {
    // Retirer un membre du salon fait tourner sa clé : le serveur pousse un
    // NOUVEL E2EKey sur le même rid. Le cache `clesSalon` porte alors la clé
    // AES périmée, et `dechiffrerContenu` le consulte EN PREMIER — sans
    // invalidation, tous les messages suivants restaient au placeholder 🔒
    // jusqu'au redémarrage de l'app, sans aucun indice de cause.
    const { fetchMyKeys, e2eKey, contenu } = await fabriquer();
    const { client, stockage } = faux(fetchMyKeys);
    const m = new MoteurE2E({ client, stockage, uid: 'osR3JzQEiM2H77m46' });
    await m.deverrouiller(MOT_DE_PASSE);
    m.enregistrerCleSalon(RID, e2eKey);
    assert.equal(m.dechiffrerContenu(RID, contenu), MESSAGE);

    const APRES = 'message posté après la rotation';
    const rot = await fabriquerCleSalon(fetchMyKeys.public_key, APRES);
    m.enregistrerCleSalon(RID, rot.e2eKey);
    assert.equal(m.dechiffrerContenu(RID, rot.contenu), APRES);
    assert.equal(m.keyIdSalon(RID), rot.e2eKey.slice(0, 36));
  });

  test('réenregistrer la MÊME clé ne casse rien (idempotent)', async () => {
    const { fetchMyKeys, e2eKey, contenu } = await fabriquer();
    const { client, stockage } = faux(fetchMyKeys);
    const m = new MoteurE2E({ client, stockage, uid: 'osR3JzQEiM2H77m46' });
    await m.deverrouiller(MOT_DE_PASSE);
    m.enregistrerCleSalon(RID, e2eKey);
    m.enregistrerCleSalon(RID, e2eKey);
    m.enregistrerCleSalon(RID, e2eKey);
    assert.equal(m.dechiffrerContenu(RID, contenu), MESSAGE);
  });

  test('reprendre() réimporte la clé du Keystore sans mot de passe', async () => {
    const { fetchMyKeys, e2eKey, contenu } = await fabriquer();
    const { client, stockage } = faux(fetchMyKeys);
    await new MoteurE2E({ client, stockage, uid: 'osR3JzQEiM2H77m46' }).deverrouiller(MOT_DE_PASSE); // remplit le Keystore

    const m2 = new MoteurE2E({ client, stockage, uid: 'osR3JzQEiM2H77m46' });
    assert.equal(await m2.reprendre(), true);
    assert.equal(m2.estDeverrouille, true);
    m2.enregistrerCleSalon(RID, e2eKey);
    assert.equal(m2.dechiffrerContenu(RID, contenu), MESSAGE);
  });

  test('verrouiller() oublie tout et vide le Keystore', async () => {
    const { fetchMyKeys, e2eKey, contenu } = await fabriquer();
    const { client, stockage, lu } = faux(fetchMyKeys);
    const m = new MoteurE2E({ client, stockage, uid: 'osR3JzQEiM2H77m46' });
    await m.deverrouiller(MOT_DE_PASSE);
    m.enregistrerCleSalon(RID, e2eKey);

    await m.verrouiller();
    assert.equal(m.estDeverrouille, false);
    assert.equal(lu(), null);
    assert.equal(m.dechiffrerContenu(RID, contenu), null);
  });

  test('mauvais mot de passe → ErreurE2E, reste verrouillé', async () => {
    const { fetchMyKeys } = await fabriquer();
    const { client, stockage, lu } = faux(fetchMyKeys);
    const m = new MoteurE2E({ client, stockage, uid: 'osR3JzQEiM2H77m46' });
    await assert.rejects(() => m.deverrouiller('mauvais'), ErreurE2E);
    assert.equal(m.estDeverrouille, false);
    assert.equal(lu(), null);
  });

  test('souscrire est notifié au déverrouillage et au verrouillage', async () => {
    const { fetchMyKeys } = await fabriquer();
    const { client, stockage } = faux(fetchMyKeys);
    const m = new MoteurE2E({ client, stockage, uid: 'osR3JzQEiM2H77m46' });
    let n = 0;
    m.souscrire(() => { n += 1; });
    await m.deverrouiller(MOT_DE_PASSE);
    await m.verrouiller();
    assert.equal(n, 2);
  });
});

describe('MoteurE2E — chiffrer', () => {
  test('verrouillé ou sans clé de salon → null, jamais de clair', async () => {
    const { fetchMyKeys, e2eKey } = await fabriquer();
    const { client, stockage } = faux(fetchMyKeys);
    const m = new MoteurE2E({ client, stockage, uid: 'osR3JzQEiM2H77m46' });
    m.enregistrerCleSalon(RID, e2eKey);
    assert.equal(m.chiffrer(RID, { msg: 'x' }), null);
    await m.deverrouiller(MOT_DE_PASSE);
    assert.equal(m.chiffrer('autre-salon', { msg: 'x' }), null);
  });

  test('chiffre sous la clé et le keyID du salon — relu par dechiffrerContenu', async () => {
    const { fetchMyKeys, e2eKey } = await fabriquer();
    const { client, stockage } = faux(fetchMyKeys);
    const m = new MoteurE2E({ client, stockage, uid: 'osR3JzQEiM2H77m46' });
    await m.deverrouiller(MOT_DE_PASSE);
    m.enregistrerCleSalon(RID, e2eKey);

    const contenu = m.chiffrer(RID, { msg: 'envoyé chiffré' });
    assert.notEqual(contenu, null);
    assert.equal(contenu?.kid, e2eKey.slice(0, 36));
    assert.equal(m.dechiffrerContenu(RID, contenu as ContenuChiffre), 'envoyé chiffré');
  });

  test('après une rotation, chiffre sous la NOUVELLE clé', async () => {
    const { fetchMyKeys, e2eKey } = await fabriquer();
    const { client, stockage } = faux(fetchMyKeys);
    const m = new MoteurE2E({ client, stockage, uid: 'osR3JzQEiM2H77m46' });
    await m.deverrouiller(MOT_DE_PASSE);
    m.enregistrerCleSalon(RID, e2eKey);
    m.chiffrer(RID, { msg: 'avant' });

    const rot = await fabriquerCleSalon(fetchMyKeys.public_key, 'ignoré');
    m.enregistrerCleSalon(RID, rot.e2eKey);
    const contenu = m.chiffrer(RID, { msg: 'après' });
    assert.equal(contenu?.kid, rot.e2eKey.slice(0, 36));
    assert.equal(m.dechiffrerContenu(RID, contenu as ContenuChiffre), 'après');
  });
});
