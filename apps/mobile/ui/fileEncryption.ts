/**
 * Câblage natif du chiffrement d'un fichier à envoyer dans un salon chiffré :
 * lecture du clair, chiffrement (`lib/e2e/crypto.ts`), écriture du chiffré dans
 * un fichier temporaire du cache, que la file téléverse puis efface.
 */

import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';

import { encryptFile, sha256Digest } from '../lib/e2e/crypto.ts';
import type { EncryptedFile } from '../lib/uploadQueue.ts';

const BASE64 = { encoding: FileSystem.EncodingType.Base64 };

export async function encryptLocalFile(uri: string): Promise<EncryptedFile> {
  const cache = FileSystem.cacheDirectory;
  if (cache === null) throw new Error('Aucun dossier de cache disponible.');
  const clair = Buffer.from(await FileSystem.readAsStringAsync(uri, BASE64), 'base64');
  const { encrypted: chiffre, key: cle, iv, sha256 } = encryptFile(clair);
  const dossier = `${cache}envoi-chiffre/`;
  await FileSystem.makeDirectoryAsync(dossier, { intermediates: true });
  const sortie = `${dossier}${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
  await FileSystem.writeAsStringAsync(sortie, chiffre.toString('base64'), BASE64);
  return { uri: sortie, key: cle, iv, sha256, size: clair.length };
}

export function hashedName(nom: string): string {
  return sha256Digest(Buffer.from(nom, 'utf8'));
}
