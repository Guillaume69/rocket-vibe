/**
 * Primitives de déchiffrement E2EE Rocket.Chat (schéma `rc.v2.aes-sha2`).
 *
 * Fonctions PURES, sans React ni réseau — testables sous Node. Tout le savoir
 * cryptographique du client tient ici ; l'orchestration (session, clés en
 * mémoire, REST) vit dans `lib/e2e/moteur.ts`.
 *
 * `node-forge` porte la crypto : `expo-crypto` ne fait ni RSA, ni AES-CBC/GCM,
 * ni PBKDF2. Choisi contre `react-native-quick-crypto` (natif, New-Arch) pour
 * éviter un module natif et le risque de build — au prix d'un PBKDF2 pur JS
 * (~400 ms à 100 000 itérations, une seule fois au déverrouillage).
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
 * COLLÉ en fin de `ciphertext`. forge le veut séparé — d'où le découpage.
 */

import forge from 'node-forge';

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

/** Objet `content` d'un message chiffré `rc.v2.aes-sha2`. */
export type ContenuChiffre = {
  algorithm: string;
  /** UUID de la clé de salon — doit correspondre au keyID de `E2EKey`. */
  kid: string;
  iv: string;
  ciphertext: string;
};

/** Clé privée RSA importée, opaque, à garder en mémoire le temps d'une session. */
export type ClePriveeRSA = forge.pki.rsa.PrivateKey;

/** Erreur de déchiffrement — un mot de passe faux tombe ici, pas en crash. */
export class ErreurE2E extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurE2E';
  }
}

const TAILLE_TAG_GCM = 16;
/** Le keyID d'une clé de salon est un UUID : 36 caractères en tête de `E2EKey`. */
export const LONGUEUR_KEYID = 36;

function base64VersOctets(b64: string): string {
  return forge.util.decode64(b64);
}

/** base64url (JWK) → chaîne d'octets forge. */
function base64urlVersOctets(s: string): string {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4 !== 0) b += '=';
  return forge.util.decode64(b);
}

function base64urlVersGrandEntier(s: string): forge.jsbn.BigInteger {
  return new forge.jsbn.BigInteger(forge.util.bytesToHex(base64urlVersOctets(s)), 16);
}

/**
 * Déchiffre un bloc AES-GCM 256. `ctAvecTag` porte le tag de 16 octets en fin
 * (convention WebCrypto). Rend `null` si l'authentification échoue — la seule
 * façon fiable de détecter un mauvais mot de passe / une clé fausse.
 */
function dechiffrerGcm(cleOctets: string, ivOctets: string, ctAvecTag: string): string | null {
  if (ctAvecTag.length < TAILLE_TAG_GCM) return null;
  const corps = ctAvecTag.substring(0, ctAvecTag.length - TAILLE_TAG_GCM);
  const tag = ctAvecTag.substring(ctAvecTag.length - TAILLE_TAG_GCM);
  const dechiffreur = forge.cipher.createDecipher('AES-GCM', cleOctets);
  dechiffreur.start({ iv: ivOctets, tag: forge.util.createBuffer(tag) });
  dechiffreur.update(forge.util.createBuffer(corps));
  return dechiffreur.finish() ? dechiffreur.output.getBytes() : null;
}

/**
 * Enveloppe → JWK JSON (chaîne) de la clé privée RSA. Lève `ErreurE2E` si le
 * mot de passe ne déchiffre pas (échec d'authentification GCM).
 */
export function dechiffrerClePrivee(enveloppe: EnveloppeClePrivee, motDePasse: string): string {
  const cleMaitre = forge.pkcs5.pbkdf2(
    forge.util.encodeUtf8(motDePasse),
    enveloppe.salt,
    enveloppe.iterations,
    32,
    forge.md.sha256.create(),
  );
  const clair = dechiffrerGcm(
    cleMaitre,
    base64VersOctets(enveloppe.iv),
    base64VersOctets(enveloppe.ciphertext),
  );
  if (clair === null) throw new ErreurE2E('mot de passe E2E invalide');
  return forge.util.decodeUtf8(clair);
}

/** JWK JSON → objet clé privée RSA forge (reconstruit depuis n,e,d,p,q,dp,dq,qi). */
export function importerClePriveeRSA(jwkJson: string): ClePriveeRSA {
  const jwk = JSON.parse(jwkJson) as Record<string, string>;
  return forge.pki.setRsaPrivateKey(
    base64urlVersGrandEntier(jwk.n),
    base64urlVersGrandEntier(jwk.e),
    base64urlVersGrandEntier(jwk.d),
    base64urlVersGrandEntier(jwk.p),
    base64urlVersGrandEntier(jwk.q),
    base64urlVersGrandEntier(jwk.dp),
    base64urlVersGrandEntier(jwk.dq),
    base64urlVersGrandEntier(jwk.qi),
  );
}

/** Le keyID (UUID) en tête d'un `E2EKey` — sert à apparier la clé au `content.kid`. */
export function keyIdDeE2EKey(e2eKey: string): string {
  return e2eKey.substring(0, LONGUEUR_KEYID);
}

/**
 * `E2EKey` d'abonnement → clé AES de salon (octets bruts). Retire le keyID (36
 * car.), RSA-OAEP/SHA-256 avec la clé privée → JWK AES, dont on rend le `k` brut.
 */
export function dechiffrerCleSalon(e2eKey: string, clePrivee: ClePriveeRSA): string {
  const chiffre = base64VersOctets(e2eKey.substring(LONGUEUR_KEYID));
  let jwkJson: string;
  try {
    jwkJson = clePrivee.decrypt(chiffre, 'RSA-OAEP', { md: forge.md.sha256.create() });
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
export function dechiffrerMessage(contenu: ContenuChiffre, cleSalonOctets: string): string {
  const clair = dechiffrerGcm(
    cleSalonOctets,
    base64VersOctets(contenu.iv),
    base64VersOctets(contenu.ciphertext),
  );
  if (clair === null) throw new ErreurE2E('déchiffrement du message échoué');
  const obj = JSON.parse(forge.util.decodeUtf8(clair)) as { msg?: unknown; text?: unknown };
  if (typeof obj.msg === 'string') return obj.msg;
  if (typeof obj.text === 'string') return obj.text;
  return '';
}
