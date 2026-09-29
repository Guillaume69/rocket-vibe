/**
 * Primitives E2EE Rocket.Chat (schéma `rc.v2.aes-sha2`) : déchiffrement, et
 * chiffrement des messages envoyés.
 *
 * Fonctions PURES, sans React ni réseau — testables sous Node. Tout le savoir
 * cryptographique du client tient ici ; l'orchestration (session, clés en
 * mémoire, REST) vit dans `lib/e2e/moteur.ts`.
 *
 * La crypto passe par l'API `node:crypto` : sous Node (tests) c'est l'implé
 * native OpenSSL ; dans l'app RN, Metro alias `crypto` et `buffer` vers
 * `react-native-quick-crypto` (module natif Nitro, New-Arch) — même API, même
 * OpenSSL, PBKDF2 natif au lieu des ~400 ms en pur JS. Aliasing dans
 * `metro.config.js`.
 *
 * Les formats EXACTS sont vérifiés contre un vrai serveur 8.5 (mémoire
 * `e2ee-protocole-rc85`). En résumé :
 *   - clé privée : enveloppe JSON `{iv, ciphertext, salt, iterations}`, salt =
 *     chaîne ASCII littérale, PBKDF2-SHA256 → AES-GCM → JWK RSA ;
 *   - clé de salon : `E2EKey` = keyID (UUID 36 car.) + base64(RSA-OAEP) → JWK AES ;
 *   - message : objet `content` `{algorithm, kid, iv, ciphertext}` → AES-GCM →
 *     JSON `{"msg": "<clair>"}`.
 *
 * Convention GCM de WebCrypto (côté serveur/officiel) : le tag de 16 octets est
 * COLLÉ en fin de `ciphertext`. `createDecipheriv` le veut séparé via
 * `setAuthTag` — d'où le découpage.
 */

import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  pbkdf2Sync,
  privateDecrypt,
  randomBytes,
  type KeyObject,
} from 'crypto';
import { Buffer } from 'buffer';

/** Enveloppe de la clé privée telle que renvoyée par `e2e.fetchMyKeys`. */
export type EnveloppeClePrivee = {
  /** base64, 12 octets (nonce GCM). */
  iv: string;
  /** base64, chiffré + tag GCM (16 derniers octets). */
  ciphertext: string;
  /** Chaîne ASCII littérale `v2:<uid>:<uuid>`, utilisée TELLE QUELLE (pas de base64). */
  salt: string;
  iterations: number;
};

/**
 * Objet `content` d'un message chiffré. Trois formes observées :
 *   - `rc.v2` GCM (serveur récent) : `{kid, iv(12 o), ciphertext(+tag)}` ;
 *   - `rc.v2` CBC (compte ancien) : `{kid, iv(16 o), ciphertext}` ;
 *   - `rc.v1` (hérité) : `{ciphertext}` seul, où `ciphertext = keyID(12) +
 *     base64(IV(16) || AES-CBC)` — pas de champ `iv`/`kid` séparé.
 * D'où `iv`/`kid` OPTIONNELS.
 */
export type ContenuChiffre = {
  algorithm: string;
  ciphertext: string;
  kid?: string;
  iv?: string;
};

/** Clé privée RSA importée, opaque, à garder en mémoire le temps d'une session. */
export type ClePriveeRSA = KeyObject;

/** Erreur de déchiffrement — un mot de passe faux tombe ici, pas en crash. */
export class ErreurE2E extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurE2E';
  }
}

const TAILLE_TAG_GCM = 16;
/** IV AES-CBC = 16 octets (l'IV GCM, lui, fait 12). Ici l'IV CBC de la v1. */
const TAILLE_IV_CBC = 16;
/**
 * Un `E2EKey` = keyID + base64(clé de salon chiffrée RSA-OAEP). La sortie
 * RSA-2048 fait 256 octets = 344 caractères base64. Le keyID est donc le
 * PRÉFIXE restant : 36 (UUID, schéma v2) ou 12 (schéma v1). On le CALCULE au
 * lieu de le coder en dur — un compte peut mêler les deux selon l'ancienneté.
 */
const LONGUEUR_RSA_B64 = 344;
function longueurKeyId(e2eKey: string): number {
  return Math.max(0, e2eKey.length - LONGUEUR_RSA_B64);
}

function base64VersOctets(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

/** base64url (JWK) → octets. */
function base64urlVersOctets(s: string): Buffer {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4 !== 0) b += '=';
  return Buffer.from(b, 'base64');
}

/**
 * Le chiffre AES qui correspond à la taille de la clé : une clé de salon créée
 * par l'ancien client web est un JWK `A128CBC` de 16 octets, pas 32.
 */
function bitsAes(cle: Buffer): 128 | 192 | 256 | null {
  const bits = cle.length * 8;
  return bits === 128 || bits === 192 || bits === 256 ? bits : null;
}

/**
 * Déchiffre un bloc AES-GCM. `ctAvecTag` porte le tag de 16 octets en fin
 * (convention WebCrypto). Rend `null` si l'authentification échoue — la seule
 * façon fiable de détecter un mauvais mot de passe / une clé fausse.
 */
function dechiffrerGcm(cle: Buffer, iv: Buffer, ctAvecTag: Buffer): Buffer | null {
  const bits = bitsAes(cle);
  if (bits === null || ctAvecTag.length < TAILLE_TAG_GCM) return null;
  const corps = ctAvecTag.subarray(0, ctAvecTag.length - TAILLE_TAG_GCM);
  const tag = ctAvecTag.subarray(ctAvecTag.length - TAILLE_TAG_GCM);
  try {
    const dechiffreur = createDecipheriv(`aes-${bits}-gcm`, cle, iv);
    dechiffreur.setAuthTag(tag);
    return Buffer.concat([dechiffreur.update(corps), dechiffreur.final()]);
  } catch {
    return null;
  }
}

/** Déchiffre un bloc AES-CBC (remplissage PKCS#7 vérifié par `final`). */
function dechiffrerCbc(cle: Buffer, iv: Buffer, ct: Buffer): Buffer | null {
  const bits = bitsAes(cle);
  if (bits === null) return null;
  try {
    const dechiffreur = createDecipheriv(`aes-${bits}-cbc`, cle, iv);
    return Buffer.concat([dechiffreur.update(ct), dechiffreur.final()]);
  } catch {
    return null;
  }
}

/**
 * `private_key` (tel que renvoyé par `e2e.fetchMyKeys`) → JWK JSON de la clé
 * privée RSA. Détecte le schéma :
 *   - **v2** : enveloppe JSON `{iv, ciphertext, salt, iterations}`, PBKDF2 →
 *     AES-GCM, salt dans l'enveloppe.
 *   - **v1** (héritage) : `{"$binary":"<b64>"}` (ou base64 nu), dont les octets
 *     sont `IV(16) || AES-CBC`. PBKDF2(mot de passe, salt = **userId**, **1000**
 *     itérations, SHA-256) → AES-CBC. Le `uid` sert de sel — d'où le paramètre.
 * Lève `ErreurE2E` si le mot de passe ne déchiffre pas.
 */
export function dechiffrerClePrivee(privateKey: string, motDePasse: string, uid: string): string {
  const brut = privateKey.trim();
  if (brut.startsWith('{')) {
    let obj: Record<string, unknown> | null = null;
    try {
      obj = JSON.parse(brut) as Record<string, unknown>;
    } catch {
      obj = null;
    }
    // v2 : enveloppe complète.
    if (obj !== null && typeof obj.iterations === 'number' && typeof obj.salt === 'string') {
      const env = obj as unknown as EnveloppeClePrivee;
      const cleMaitre = pbkdf2Sync(Buffer.from(motDePasse, 'utf8'), Buffer.from(env.salt, 'utf8'), env.iterations, 32, 'sha256');
      const clair = dechiffrerGcm(cleMaitre, base64VersOctets(env.iv), base64VersOctets(env.ciphertext));
      if (clair === null) throw new ErreurE2E('mot de passe E2E invalide');
      return clair.toString('utf8');
    }
    // v1 emballé en binaire EJSON.
    if (obj !== null && typeof obj.$binary === 'string') {
      return dechiffrerClePriveeV1(base64VersOctets(obj.$binary), motDePasse, uid);
    }
  }
  // v1 en base64 nu.
  return dechiffrerClePriveeV1(base64VersOctets(brut), motDePasse, uid);
}

/**
 * Clé privée v1 : octets = `IV(16) || AES-CBC(JWK)`, clé maître dérivée du
 * userId (sel) et de 1000 itérations PBKDF2-SHA256. Un mauvais mot de passe
 * casse le remplissage PKCS#7 → `ErreurE2E`. Dans le cas rare où le remplissage
 * passe par hasard, le clair n'est pas un JWK valide → `JSON.parse` lève, qu'on
 * assimile à un mot de passe faux.
 */
function dechiffrerClePriveeV1(octets: Buffer, motDePasse: string, uid: string): string {
  const cleMaitre = pbkdf2Sync(Buffer.from(motDePasse, 'utf8'), Buffer.from(uid, 'utf8'), 1000, 32, 'sha256');
  const clair = dechiffrerCbc(cleMaitre, octets.subarray(0, TAILLE_IV_CBC), octets.subarray(TAILLE_IV_CBC));
  if (clair === null) throw new ErreurE2E('mot de passe E2E invalide');
  const texte = clair.toString('utf8');
  try {
    JSON.parse(texte);
  } catch {
    throw new ErreurE2E('mot de passe E2E invalide');
  }
  return texte;
}

/** JWK JSON → objet clé privée RSA. `createPrivateKey` importe le JWK nativement. */
export function importerClePriveeRSA(jwkJson: string): ClePriveeRSA {
  const jwk = JSON.parse(jwkJson) as JsonWebKey;
  return createPrivateKey({ key: jwk, format: 'jwk' });
}

/** Le keyID en tête d'un `E2EKey` (UUID v2 ou préfixe v1) — apparie au `content.kid`. */
export function keyIdDeE2EKey(e2eKey: string): string {
  return e2eKey.substring(0, longueurKeyId(e2eKey));
}

/**
 * `E2EKey` d'abonnement → clé AES de salon (octets bruts). Retire le keyID (36
 * car. en v2, 12 en v1 — calculé), RSA-OAEP/SHA-256 avec la clé privée → JWK
 * AES, dont on rend le `k` brut.
 */
export function dechiffrerCleSalon(e2eKey: string, clePrivee: ClePriveeRSA): Buffer {
  const chiffre = base64VersOctets(e2eKey.substring(longueurKeyId(e2eKey)));
  let jwkJson: string;
  try {
    jwkJson = privateDecrypt(
      { key: clePrivee, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      chiffre,
    ).toString('utf8');
  } catch {
    throw new ErreurE2E('déchiffrement de la clé de salon échoué');
  }
  const jwk = JSON.parse(jwkJson) as { k?: string };
  if (typeof jwk.k !== 'string') throw new ErreurE2E('clé de salon sans champ k');
  return base64urlVersOctets(jwk.k);
}

/**
 * Objet `content` + clé de salon (octets) → texte clair du message. Le clair est
 * un JSON `{"msg": "..."}` (parfois `text`). Lève `ErreurE2E` si l'auth échoue.
 */
export function dechiffrerMessage(contenu: ContenuChiffre, cleSalonOctets: Buffer): string {
  let clair: Buffer | null;
  if (typeof contenu.iv === 'string' && contenu.iv !== '') {
    // Structure moderne : iv et ciphertext séparés. IV de 12 octets → GCM
    // (tag collé en fin) ; de 16 → CBC (le schéma de ce compte ancien).
    const iv = base64VersOctets(contenu.iv);
    const ct = base64VersOctets(contenu.ciphertext);
    clair = iv.length === 12 ? dechiffrerGcm(cleSalonOctets, iv, ct) : dechiffrerCbc(cleSalonOctets, iv, ct);
  } else {
    // Structure héritée rc.v1 : ciphertext = keyID(12) + base64(IV(16) || CBC).
    const blob = base64VersOctets(contenu.ciphertext.substring(12));
    clair = dechiffrerCbc(cleSalonOctets, blob.subarray(0, TAILLE_IV_CBC), blob.subarray(TAILLE_IV_CBC));
  }
  if (clair === null) throw new ErreurE2E('déchiffrement du message échoué');
  const texte = clair.toString('utf8');
  // Le clair est en général un JSON `{"msg": "..."}` ; certains messages
  // hérités portent le texte brut — on retombe dessus.
  try {
    const obj = JSON.parse(texte) as { msg?: unknown; text?: unknown };
    if (typeof obj.msg === 'string') return obj.msg;
    if (typeof obj.text === 'string') return obj.text;
  } catch {
    // pas du JSON : texte brut.
  }
  return texte;
}

/**
 * Charge claire (`{msg}`, plus `attachments`/`files`/`file` pour un fichier) →
 * objet `content` `rc.v2.aes-sha2`, tel que le client web le produit. Le mode
 * suit la clé de salon, comme WebCrypto côté web où la clé est importée selon
 * l'`alg` de son JWK : `A128CBC` (16 octets) → CBC, IV de 16 ; `A256GCM` (32)
 * → GCM, IV de 12, tag collé en fin de `ciphertext`.
 */
export function chiffrerMessage(charge: object, cleSalonOctets: Buffer, kid: string): ContenuChiffre {
  const clair = Buffer.from(JSON.stringify(charge), 'utf8');
  let iv: Buffer;
  let ct: Buffer;
  if (cleSalonOctets.length === 16) {
    iv = randomBytes(TAILLE_IV_CBC);
    const chiffreur = createCipheriv('aes-128-cbc', cleSalonOctets, iv);
    ct = Buffer.concat([chiffreur.update(clair), chiffreur.final()]);
  } else if (cleSalonOctets.length === 32) {
    iv = randomBytes(12);
    const chiffreur = createCipheriv('aes-256-gcm', cleSalonOctets, iv);
    ct = Buffer.concat([chiffreur.update(clair), chiffreur.final(), chiffreur.getAuthTag()]);
  } else {
    throw new ErreurE2E('clé de salon de taille inattendue');
  }
  return { algorithm: 'rc.v2.aes-sha2', kid, iv: iv.toString('base64'), ciphertext: ct.toString('base64') };
}
