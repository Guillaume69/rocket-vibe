/**
 * Transport d'upload côté app : `expo-file-system/legacy` `createUploadTask`
 * en MULTIPART, champ `file` — le contrat de `rooms.media`. La progression
 * vient de `totalBytesSent`.
 */

import * as FileSystem from 'expo-file-system/legacy';

import { ErreurRest } from '../lib/rest.ts';
import type { TransportUpload } from '../lib/upload.ts';

export const transportExpo: TransportUpload = async (url, entetes, fichier, surProgression) => {
  // Un fichier de cache purgé par l'OS (kill entre la sélection et le rejeu)
  // n'est PAS une panne réseau : erreur franche → statut « échec »,
  // abandonnable — pas une attente éternelle.
  const info = await FileSystem.getInfoAsync(fichier.uri);
  if (!info.exists) {
    throw new Error(`Fichier introuvable (${fichier.nom}) — cache purgé ?`);
  }

  const tache = FileSystem.createUploadTask(
    url,
    fichier.uri,
    {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      mimeType: fichier.type,
      headers: entetes,
      parameters: {},
    },
    (progression) => {
      if (progression.totalBytesExpectedToSend > 0) {
        surProgression?.(progression.totalBytesSent / progression.totalBytesExpectedToSend);
      }
    },
  );
  let resultat;
  try {
    resultat = await tache.uploadAsync();
  } catch {
    // `uploadAsync` ne rejette que quand AUCUNE réponse HTTP n'est arrivée :
    // c'est le réseau. Statut 0 = la ligne reste « en-attente », le rejeu du
    // prochain raccordement s'en charge — même sémantique que ClientRest.
    throw new ErreurRest('rooms.media : serveur injoignable.', 0);
  }
  if (resultat == null) {
    throw new Error('Téléversement annulé.');
  }
  return { statut: resultat.status, corps: resultat.body };
};
