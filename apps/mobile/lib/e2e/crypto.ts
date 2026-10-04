/**
 * Primitives E2EE Rocket.Chat (schéma `rc.v2.aes-sha2`) : déchiffrement, et
 * chiffrement des messages envoyés.
 *
 * Fonctions PURES, sans React ni réseau — testables sous Node. Tout le savoir
 * cryptographique du client tient ici ; l'orchestration (session, clés en
 * mémoire, REST) vit dans `lib/e2e/engine.ts`.
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
  createHash,
  createDecipheriv,
  createPrivateKey,
  pbkdf2Sync,
  privateDecrypt,
  randomBytes,
  type KeyObject,
} from 'crypto';
import { Buffer } from 'buffer';

/** Enveloppe de la clé privée telle que renvoyée par `e2e.fetchMyKeys`. */
export type PrivateKeyEnvelope = {
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
export type EncryptedContent = {
  algorithm: string;
  ciphertext: string;
  kid?: string;
  iv?: string;
};

/** Clé privée RSA importée, opaque, à garder en mémoire le temps d'une session. */
export type RsaPrivateKey = KeyObject;

/** Erreur de déchiffrement — un mot de passe faux tombe ici, pas en crash. */
export class E2EError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurE2E';
  }
}

const GCM_TAG_SIZE = 16;
/** IV AES-CBC = 16 octets (l'IV GCM, lui, fait 12). Ici l'IV CBC de la v1. */
const CBC_IV_SIZE = 16;
/**
 * Un `E2EKey` = keyID + base64(clé de salon chiffrée RSA-OAEP). La sortie
 * RSA-2048 fait 256 octets = 344 caractères base64. Le keyID est donc le
 * PRÉFIXE restant : 36 (UUID, schéma v2) ou 12 (schéma v1). On le CALCULE au
 * lieu de le coder en dur — un compte peut mêler les deux selon l'ancienneté.
 */
const RSA_B64_LENGTH = 344;
function longueurKeyId(e2eKey: string): number {
  return Math.max(0, e2eKey.length - RSA_B64_LENGTH);
}

function base64ToBytes(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

/** base64url (JWK) → octets. */
function base64urlToBytes(s: string): Buffer {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4 !== 0) b += '=';
  return Buffer.from(b, 'base64');
}

/**
 * Le chiffre AES qui correspond à la taille de la clé : une clé de salon créée
 * par l'ancien client web est un JWK `A128CBC` de 16 octets, pas 32.
 */
function bitsAes(key: Buffer): 128 | 192 | 256 | null {
  const bits = key.length * 8;
  return bits === 128 || bits === 192 || bits === 256 ? bits : null;
}

/**
 * Déchiffre un bloc AES-GCM. `ctAvecTag` porte le tag de 16 octets en fin
 * (convention WebCrypto). Rend `null` si l'authentification échoue — la seule
 * façon fiable de détecter un mauvais mot de passe / une clé fausse.
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

/** Déchiffre un bloc AES-CBC (remplissage PKCS#7 vérifié par `final`). */
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
 * `private_key` (tel que renvoyé par `e2e.fetchMyKeys`) → JWK JSON de la clé
 * privée RSA. Détecte le schéma :
 *   - **v2** : enveloppe JSON `{iv, ciphertext, salt, iterations}`, PBKDF2 →
 *     AES-GCM, salt dans l'enveloppe.
 *   - **v1** (héritage) : `{"$binary":"<b64>"}` (ou base64 nu), dont les octets
 *     sont `IV(16) || AES-CBC`. PBKDF2(mot de passe, salt = **userId**, **1000**
 *     itérations, SHA-256) → AES-CBC. Le `uid` sert de sel — d'où le paramètre.
 * Lève `ErreurE2E` si le mot de passe ne déchiffre pas.
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
    // v2 : enveloppe complète.
    if (obj !== null && typeof obj.iterations === 'number' && typeof obj.salt === 'string') {
      const env = obj as unknown as PrivateKeyEnvelope;
      const masterKey = pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(env.salt, 'utf8'), env.iterations, 32, 'sha256');
      const plain = decryptGcm(masterKey, base64ToBytes(env.iv), base64ToBytes(env.ciphertext));
      if (plain === null) throw new E2EError('mot de passe E2E invalide');
      return plain.toString('utf8');
    }
    // v1 emballé en binaire EJSON.
    if (obj !== null && typeof obj.$binary === 'string') {
      return decryptPrivateKeyV1(base64ToBytes(obj.$binary), password, uid);
    }
  }
  // v1 en base64 nu.
  return decryptPrivateKeyV1(base64ToBytes(raw), password, uid);
}

/**
 * Clé privée v1 : octets = `IV(16) || AES-CBC(JWK)`, clé maître dérivée du
 * userId (sel) et de 1000 itérations PBKDF2-SHA256. Un mauvais mot de passe
 * casse le remplissage PKCS#7 → `ErreurE2E`. Dans le cas rare où le remplissage
 * passe par hasard, le clair n'est pas un JWK valide → `JSON.parse` lève, qu'on
 * assimile à un mot de passe faux.
 */
function decryptPrivateKeyV1(bytes: Buffer, password: string, uid: string): string {
  const masterKey = pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(uid, 'utf8'), 1000, 32, 'sha256');
  const plain = decryptCbc(masterKey, bytes.subarray(0, CBC_IV_SIZE), bytes.subarray(CBC_IV_SIZE));
  if (plain === null) throw new E2EError('mot de passe E2E invalide');
  const text = plain.toString('utf8');
  try {
    JSON.parse(text);
  } catch {
    throw new E2EError('mot de passe E2E invalide');
  }
  return text;
}

/** JWK JSON → objet clé privée RSA. `createPrivateKey` importe le JWK nativement. */
export function importRsaPrivateKey(jwkJson: string): RsaPrivateKey {
  const jwk = JSON.parse(jwkJson) as JsonWebKey;
  return createPrivateKey({ key: jwk, format: 'jwk' });
}

/** Le keyID en tête d'un `E2EKey` (UUID v2 ou préfixe v1) — apparie au `content.kid`. */
export function keyIdOfE2EKey(e2eKey: string): string {
  return e2eKey.substring(0, longueurKeyId(e2eKey));
}

/**
 * `E2EKey` d'abonnement → clé AES de salon (octets bruts). Retire le keyID (36
 * car. en v2, 12 en v1 — calculé), RSA-OAEP/SHA-256 avec la clé privée → JWK
 * AES, dont on rend le `k` brut.
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
    throw new E2EError('déchiffrement de la clé de salon échoué');
  }
  const jwk = JSON.parse(jwkJson) as { k?: string };
  if (typeof jwk.k !== 'string') throw new E2EError('clé de salon sans champ k');
  return base64urlToBytes(jwk.k);
}

/**
 * Ce que porte un message chiffré une fois ouvert : son texte, et pour un
 * fichier ses pièces jointes, qui détiennent la clé du fichier.
 */
export type PlainPayload = { msg: string; attachments: unknown[] | null };

/** Objet `content` + clé de salon (octets) → texte clair du message. */
export function decryptMessage(content: EncryptedContent, roomKeyBytes: Buffer): string {
  return decryptPayload(content, roomKeyBytes).msg;
}

/**
 * Objet `content` + clé de salon (octets) → charge claire. Le clair est un JSON
 * `{"msg": "...", "attachments": [...]}` (parfois `text`). Lève `ErreurE2E` si
 * l'auth échoue.
 */
export function decryptPayload(content: EncryptedContent, roomKeyBytes: Buffer): PlainPayload {
  let plain: Buffer | null;
  if (typeof content.iv === 'string' && content.iv !== '') {
    // Structure moderne : iv et ciphertext séparés. IV de 12 octets → GCM
    // (tag collé en fin) ; de 16 → CBC (le schéma de ce compte ancien).
    const iv = base64ToBytes(content.iv);
    const ct = base64ToBytes(content.ciphertext);
    plain = iv.length === 12 ? decryptGcm(roomKeyBytes, iv, ct) : decryptCbc(roomKeyBytes, iv, ct);
  } else {
    // Structure héritée rc.v1 : ciphertext = keyID(12) + base64(IV(16) || CBC).
    const blob = base64ToBytes(content.ciphertext.substring(12));
    plain = decryptCbc(roomKeyBytes, blob.subarray(0, CBC_IV_SIZE), blob.subarray(CBC_IV_SIZE));
  }
  if (plain === null) throw new E2EError('déchiffrement du message échoué');
  const text = plain.toString('utf8');
  // Le clair est en général un JSON `{"msg": "..."}` ; certains messages
  // hérités portent le texte brut — on retombe dessus.
  try {
    const obj = JSON.parse(text) as { msg?: unknown; text?: unknown; attachments?: unknown };
    const attachments = Array.isArray(obj.attachments) ? obj.attachments : null;
    if (typeof obj.msg === 'string') return { msg: obj.msg, attachments };
    if (typeof obj.text === 'string') return { msg: obj.text, attachments };
    if (attachments !== null) return { msg: '', attachments };
  } catch {
    // pas du JSON : texte brut.
  }
  return { msg: text, attachments: null };
}

/**
 * Charge claire (`{msg}`, plus `attachments`/`files`/`file` pour un fichier) →
 * objet `content` `rc.v2.aes-sha2`, tel que le client web le produit. Le mode
 * suit la clé de salon, comme WebCrypto côté web où la clé est importée selon
 * l'`alg` de son JWK : `A128CBC` (16 octets) → CBC, IV de 16 ; `A256GCM` (32)
 * → GCM, IV de 12, tag collé en fin de `ciphertext`.
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
    throw new E2EError('clé de salon de taille inattendue');
  }
  return { algorithm: 'rc.v2.aes-sha2', kid, iv: iv.toString('base64'), ciphertext: ct.toString('base64') };
}

/**
 * Le chiffrement d'un fichier, tel que sa pièce jointe le décrit (dans le
 * clair du message) : une clé AES-CTR à lui (JWK), un compteur initial de 16
 * octets, et l'empreinte SHA-256 du fichier clair.
 */
export type FileEncryption = { key: { k: string }; iv: string; sha256: string | null };

/** La description de chiffrement d'une pièce jointe, ou `null` si elle n'est pas chiffrée. */
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
 * Octets téléchargés → fichier clair. AES-CTR : pas de remplissage ni de tag,
 * donc une clé fausse rend du bruit sans erreur — c'est l'empreinte SHA-256
 * qui tranche, quand l'expéditeur l'a fournie. Lève `ErreurE2E` sinon.
 */
export function decryptFile(bytes: Buffer, encryption: FileEncryption): Buffer {
  const key = base64urlToBytes(encryption.key.k);
  const bits = bitsAes(key);
  const iv = base64ToBytes(encryption.iv);
  if (bits === null || iv.length !== 16) throw new E2EError('chiffrement de fichier illisible');
  const decryptor = createDecipheriv(`aes-${bits}-ctr`, key, iv);
  const plain = Buffer.concat([decryptor.update(bytes), decryptor.final()]);
  if (encryption.sha256 !== null && sha256Digest(plain) !== encryption.sha256.toLowerCase()) {
    throw new E2EError('fichier altéré ou clé fausse');
  }
  return plain;
}

/** SHA-256 en hexadécimal, la forme des `hashes.sha256` de Rocket.Chat. */
export function sha256Digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** La clé d'un fichier envoyé, sous la forme JWK que le client web réimporte (AES-CTR, extractible). */
export type FileJwk = { kty: 'oct'; alg: 'A256CTR'; k: string; ext: true; key_ops: ['encrypt', 'decrypt'] };

/**
 * Fichier clair → octets à téléverser, et de quoi le relire : une clé AES-CTR
 * 256 neuve, un compteur initial de 16 octets, l'empreinte SHA-256 du clair —
 * ce que le client web met dans la pièce jointe.
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
