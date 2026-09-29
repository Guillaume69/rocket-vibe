/**
 * Transport d'upload côté app : `expo-file-system/legacy` `createUploadTask`
 * en MULTIPART. La progression vient de `totalBytesSent`.
 *
 * Deux variantes, un seul corps : le NOM DE CHAMP multipart diffère selon
 * l'endpoint — `file` pour `rooms.media` (pièce jointe), `image` pour
 * `users.setAvatar` (photo de profil). La factory le paramètre.
 */

import * as FileSystem from 'expo-file-system/legacy';

import { nomATeleverser } from '../lib/fichierJoint.ts';
import { ErreurRest } from '../lib/rest.ts';
import type { TransportUpload } from '../lib/upload.ts';
import { signalerFinUpload } from './sondeUpload.ts';

/**
 * Copie le fichier sous son vrai nom, dans un dossier à lui : le multipart part
 * sous le nom du fichier sur le disque. Rend `null` quand l'URI le porte déjà
 * ou que la copie échoue — le fichier part alors sous son nom de cache.
 */
async function copieNommee(
  uri: string,
  nom: string,
): Promise<{ dossier: string; fichier: string } | null> {
  const voulu = nomATeleverser(uri, nom);
  const cache = FileSystem.cacheDirectory;
  if (voulu === null || cache === null) return null;
  const dossier = `${cache}envoi-nomme/${Date.now()}-${Math.random().toString(36).slice(2)}/`;
  try {
    await FileSystem.makeDirectoryAsync(dossier, { intermediates: true });
    const fichier = dossier + encodeURIComponent(voulu);
    await FileSystem.copyAsync({ from: uri, to: fichier });
    return { dossier, fichier };
  } catch {
    await FileSystem.deleteAsync(dossier, { idempotent: true }).catch(() => {});
    return null;
  }
}

function transportExpoAvec(champ: string): TransportUpload {
  return async (url, entetes, fichier, surProgression, surAnnulable, champs) => {
    // Un fichier de cache purgé par l'OS (kill entre la sélection et le rejeu)
    // n'est PAS une panne réseau : erreur franche → statut « échec »,
    // abandonnable — pas une attente éternelle.
    const info = await FileSystem.getInfoAsync(fichier.uri);
    if (!info.exists) {
      throw new Error(`Fichier introuvable (${fichier.nom}) — cache purgé ?`);
    }

    const copie = await copieNommee(fichier.uri, fichier.nom);

    const tache = FileSystem.createUploadTask(
      url,
      copie?.fichier ?? fichier.uri,
      {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: champ,
        mimeType: fichier.type,
        headers: entetes,
        parameters: champs ?? {},
      },
      (progression) => {
        if (progression.totalBytesExpectedToSend > 0) {
          surProgression?.(progression.totalBytesSent / progression.totalBytesExpectedToSend);
        }
      },
    );
    // Remonté AVANT le premier octet : « Abandonner » doit pouvoir mordre dès
    // le début, sinon les octets continuent de monter après le geste et le
    // fichier finit par apparaître dans le salon.
    surAnnulable?.(() => tache.cancelAsync());

    let resultat;
    try {
      resultat = await tache.uploadAsync();
    } catch {
      // `uploadAsync` ne rejette que quand AUCUNE réponse HTTP n'est arrivée :
      // c'est le réseau. Statut 0 = la ligne reste « en-attente », le rejeu du
      // prochain raccordement s'en charge — même sémantique que ClientRest.
      throw new ErreurRest('Upload : serveur injoignable.', 0);
    } finally {
      // Réussi comme échoué : c'est le passage des octets qui fait tomber la
      // socket, pas le verdict du serveur.
      signalerFinUpload();
      if (copie !== null) {
        void FileSystem.deleteAsync(copie.dossier, { idempotent: true }).catch(() => {});
      }
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
