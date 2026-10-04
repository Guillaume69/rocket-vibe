/**
 * Câblage natif du chiffrement d'un fichier à envoyer dans un salon chiffré :
 * lecture du clair, chiffrement (`lib/e2e/crypto.ts`), écriture du chiffré dans
 * un fichier temporaire du cache, que la file téléverse puis efface.
 */

import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';

import { chiffrerFichier, empreinteSha256 } from '../lib/e2e/crypto.ts';
import type { FichierChiffre } from '../lib/uploadQueue.ts';

const BASE64 = { encoding: FileSystem.EncodingType.Base64 };

export async function chiffrerFichierLocal(uri: string): Promise<FichierChiffre> {
  const cache = FileSystem.cacheDirectory;
  if (cache === null) throw new Error('Aucun dossier de cache disponible.');
  const clair = Buffer.from(await FileSystem.readAsStringAsync(uri, BASE64), 'base64');
  const { chiffre, cle, iv, sha256 } = chiffrerFichier(clair);
  const dossier = `${cache}envoi-chiffre/`;
  await FileSystem.makeDirectoryAsync(dossier, { intermediates: true });
  const sortie = `${dossier}${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
  await FileSystem.writeAsStringAsync(sortie, chiffre.toString('base64'), BASE64);
  return { uri: sortie, cle, iv, sha256, taille: clair.length };
}

export function empreinteNom(nom: string): string {
  return empreinteSha256(Buffer.from(nom, 'utf8'));
}
