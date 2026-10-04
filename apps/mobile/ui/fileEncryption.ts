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
  if (cache === null) throw new Error('No cache directory available.');
  const plain = Buffer.from(await FileSystem.readAsStringAsync(uri, BASE64), 'base64');
  const { encrypted, key, iv, sha256 } = encryptFile(plain);
  const folder = `${cache}envoi-chiffre/`;
  await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
  const outbox = `${folder}${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
  await FileSystem.writeAsStringAsync(outbox, encrypted.toString('base64'), BASE64);
  return { uri: outbox, key, iv, sha256, size: plain.length };
}

export function hashedName(name: string): string {
  return sha256Digest(Buffer.from(name, 'utf8'));
}
