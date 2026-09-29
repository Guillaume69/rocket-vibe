/**
 * Assertions de TYPES sur la surface `react-native-quick-crypto` réellement
 * employée par `lib/e2e/crypto.ts`.
 *
 * Les tests de `crypto.test.ts` s'exécutent sous Node, donc contre
 * `node:crypto` — jamais contre quick-crypto, l'implémentation que l'alias
 * Metro (`metro.config.js`) embarque sur l'appareil. Une montée de version qui
 * retirerait ou changerait l'un des appels utilisés passerait la suite entière
 * et donnerait « Déverrouillage impossible » en production, sans aucun signal.
 *
 * Ce fichier rejoue chaque appel de `crypto.ts` contre le TYPE du module
 * aliasé : c'est `npx tsc --noEmit` — critère de sortie de chaque chantier —
 * qui le vérifie. Il n'a AUCUNE existence à l'exécution : imports de types
 * seulement, valeurs déclarées en ambiant, jamais importé par l'app ni par un
 * test. La casse d'un de ces appels au bump de quick-crypto devient une erreur
 * de compilation au lieu d'un crash sur l'appareil.
 *
 * Limite assumée : un type peut mentir (une signature stable sur un natif qui
 * change de comportement). Le COMPORTEMENT n'est prouvé que par les vecteurs
 * de `crypto.test.ts` sous OpenSSL/Node — même bibliothèque que le natif
 * quick-crypto — et par le déverrouillage réel sur l'appareil.
 */

import type { Buffer as BufferEmbarque } from '@craftzdog/react-native-buffer';

/** Le module que Metro sert quand `crypto.ts` importe `crypto`. */
type ModuleQuickCrypto = typeof import('react-native-quick-crypto');
/** Le module que Metro sert quand `crypto.ts` importe `buffer`. */
type ModuleBufferEmbarque = typeof import('@craftzdog/react-native-buffer');

declare const qc: ModuleQuickCrypto;
declare const moduleBuffer: ModuleBufferEmbarque;
declare const octets: BufferEmbarque;

/**
 * Le JWK RSA privé tel que Rocket.Chat le livre réellement (WebCrypto
 * `exportKey('jwk')`, vérifié sur 8.5 — mémoire `e2ee-protocole-rc85`). PAS le
 * `JsonWebKey` des types Node que `crypto.ts` affiche : quick-crypto restreint
 * `kty` à une union (`'RSA' | …`) là où Node dit `string`. C'est la VALEUR au
 * runtime qui doit être acceptée, donc c'est elle qu'on modèle — et si
 * quick-crypto retirait `'RSA'` de l'union ou le champ `format: 'jwk'`, cette
 * ligne casserait.
 */
declare const jwk: {
  kty: 'RSA';
  alg: string;
  n: string;
  e: string;
  d: string;
  p: string;
  q: string;
  dp: string;
  dq: string;
  qi: string;
  ext: boolean;
  key_ops: 'decrypt'[];
};

/**
 * Jamais appelée — seul son TYPAGE compte. Chaque bloc est la copie conforme
 * d'un appel de `crypto.ts`, dans l'ordre du fichier.
 */
export function surfaceEmployeeParCryptoTs(): void {
  // `Buffer.from` / `Buffer.concat` (base64VersOctets, dechiffrerGcm…).
  const b64 = moduleBuffer.Buffer.from('AA==', 'base64');
  const utf8 = moduleBuffer.Buffer.from('texte', 'utf8');
  const concat: BufferEmbarque = moduleBuffer.Buffer.concat([b64, utf8]);
  void concat.subarray(0, 16);
  void concat.toString('utf8');

  // dechiffrerGcm : GCM à taille de clé variable, tag séparé via setAuthTag, update/final → Buffer.
  const chiffre: string = `aes-${octets.length * 8}-gcm`;
  const gcm = qc.createDecipheriv(chiffre, octets, octets);
  gcm.setAuthTag(octets);
  const clairGcm: BufferEmbarque = moduleBuffer.Buffer.concat([gcm.update(octets), gcm.final()]);
  void clairGcm;

  // dechiffrerCbc : CBC à taille de clé variable, remplissage vérifié par final.
  const cbc = qc.createDecipheriv(chiffre, octets, octets);
  const clairCbc: BufferEmbarque = moduleBuffer.Buffer.concat([cbc.update(octets), cbc.final()]);
  void clairCbc;

  // dechiffrerClePrivee : PBKDF2-SHA256 → 32 octets de clé maître.
  const cleMaitre: BufferEmbarque = qc.pbkdf2Sync(utf8, utf8, 1000, 32, 'sha256');
  void cleMaitre;

  // importerClePriveeRSA : import JWK natif.
  const clePrivee = qc.createPrivateKey({ key: jwk, format: 'jwk' });

  // dechiffrerCleSalon : RSA-OAEP/SHA-256 avec la constante de remplissage.
  const remplissage: number = qc.constants.RSA_PKCS1_OAEP_PADDING;
  const jwkSalon: BufferEmbarque = qc.privateDecrypt(
    { key: clePrivee, padding: remplissage, oaepHash: 'sha256' },
    octets,
  );
  void jwkSalon.toString('utf8');
}
