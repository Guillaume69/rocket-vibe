/**
 * Transport d'upload côté app : `expo-file-system/legacy` `createUploadTask`
 * en MULTIPART. La progression vient de `totalBytesSent`.
 *
 * Deux variantes, un seul corps : le NOM DE CHAMP multipart diffère selon
 * l'endpoint — `file` pour `rooms.media` (pièce jointe), `image` pour
 * `users.setAvatar` (photo de profil). La factory le paramètre.
 */

import * as FileSystem from 'expo-file-system/legacy';

import { ErreurRest } from '../lib/rest.ts';
import type { TransportUpload } from '../lib/upload.ts';

function transportExpoAvec(champ: string): TransportUpload {
  return async (url, entetes, fichier, surProgression) => {
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
        fieldName: champ,
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
      throw new ErreurRest('Upload : serveur injoignable.', 0);
    }
    if (resultat == null) {
      throw new Error('Téléversement annulé.');
    }
    return { statut: resultat.status, corps: resultat.body };
  };
}

/** Pièce jointe de salon (`rooms.media`), champ `file`. */
export const transportExpo = transportExpoAvec('file');

/** Photo de profil (`users.setAvatar`), champ `image`. */
export const transportAvatarExpo = transportExpoAvec('image');
