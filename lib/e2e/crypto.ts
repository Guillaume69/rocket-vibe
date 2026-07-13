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
export type ClePriveeRSA = forge.pki.rsa.PrivateKey;

/** Erreur de déchiffrement — un mot de passe faux tombe ici, pas en crash. */
export class ErreurE2E extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurE2E';
  }
}

const TAILLE_TAG_GCM = 16;
/** Taille d'un IV AES-CBC/GCM… non : CBC = 16, GCM = 12. Ici l'IV CBC de la v1. */
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

/** Déchiffre un bloc AES-CBC 256 (remplissage PKCS#7 vérifié par `finish`). */
function dechiffrerCbc(cleOctets: string, ivOctets: string, ct: string): string | null {
  const dechiffreur = forge.cipher.createDecipher('AES-CBC', cleOctets);
  dechiffreur.start({ iv: ivOctets });
  dechiffreur.update(forge.util.createBuffer(ct));
  return dechiffreur.finish() ? dechiffreur.output.getBytes() : null;
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
      const cleMaitre = forge.pkcs5.pbkdf2(
        forge.util.encodeUtf8(motDePasse),
        env.salt,
        env.iterations,
        32,
        forge.md.sha256.create(),
      );
      const clair = dechiffrerGcm(
        cleMaitre,
        base64VersOctets(env.iv),
        base64VersOctets(env.ciphertext),
      );
      if (clair === null) throw new ErreurE2E('mot de passe E2E invalide');
      return forge.util.decodeUtf8(clair);
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
 * casse le remplissage PKCS#7 → `ErreurE2E`.
 */
function dechiffrerClePriveeV1(octets: string, motDePasse: string, uid: string): string {
  const cleMaitre = forge.pkcs5.pbkdf2(forge.util.encodeUtf8(motDePasse), uid, 1000, 32, forge.md.sha256.create());
  const clair = dechiffrerCbc(cleMaitre, octets.substring(0, TAILLE_IV_CBC), octets.substring(TAILLE_IV_CBC));
  if (clair === null) throw new ErreurE2E('mot de passe E2E invalide');
  try {
    // Un mauvais mot de passe peut passer le remplissage PKCS#7 par hasard : le
    // clair est alors du binaire non-UTF8 → `decodeUtf8` lève. On l'assimile à
    // un mot de passe faux plutôt qu'à un crash.
    return forge.util.decodeUtf8(clair);
  } catch {
    throw new ErreurE2E('mot de passe E2E invalide');
  }
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

/** Le keyID en tête d'un `E2EKey` (UUID v2 ou préfixe v1) — apparie au `content.kid`. */
export function keyIdDeE2EKey(e2eKey: string): string {
  return e2eKey.substring(0, longueurKeyId(e2eKey));
}

/**
 * `E2EKey` d'abonnement → clé AES de salon (octets bruts). Retire le keyID (36
 * car. en v2, 12 en v1 — calculé), RSA-OAEP/SHA-256 avec la clé privée → JWK
 * AES, dont on rend le `k` brut.
 */
export function dechiffrerCleSalon(e2eKey: string, clePrivee: ClePriveeRSA): string {
  const chiffre = base64VersOctets(e2eKey.substring(longueurKeyId(e2eKey)));
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
  let clair: string | null;
  if (typeof contenu.iv === 'string' && contenu.iv !== '') {
    // Structure moderne : iv et ciphertext séparés. IV de 12 octets → GCM
    // (tag collé en fin) ; de 16 → CBC (le schéma de ce compte ancien).
    const iv = base64VersOctets(contenu.iv);
    const ct = base64VersOctets(contenu.ciphertext);
    clair =
      iv.length === 12
        ? dechiffrerGcm(cleSalonOctets, iv, ct)
        : dechiffrerCbc(cleSalonOctets, iv, ct);
  } else {
    // Structure héritée rc.v1 : ciphertext = keyID(12) + base64(IV(16) || CBC).
    const blob = base64VersOctets(contenu.ciphertext.substring(12));
    clair = dechiffrerCbc(cleSalonOctets, blob.substring(0, TAILLE_IV_CBC), blob.substring(TAILLE_IV_CBC));
  }
  if (clair === null) throw new ErreurE2E('déchiffrement du message échoué');
  let texte: string;
  try {
    texte = forge.util.decodeUtf8(clair);
  } catch {
    throw new ErreurE2E('déchiffrement du message échoué');
  }
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
