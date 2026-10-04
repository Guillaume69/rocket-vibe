/**
 * Transport d'upload côté app : `expo-file-system/legacy` `createUploadTask`
 * en MULTIPART. La progression vient de `totalBytesSent`.
 *
 * Deux variantes, un seul corps : le NOM DE CHAMP multipart diffère selon
 * l'endpoint — `file` pour `rooms.media` (pièce jointe), `image` pour
 * `users.setAvatar` (photo de profil). La factory le paramètre.
 */

import * as FileSystem from 'expo-file-system/legacy';

import { uploadName } from '../lib/attachment.ts';
import { RestError } from '../lib/rest.ts';
import type { TransportUpload } from '../lib/upload.ts';
import { reportUploadEnd } from './uploadProbe.ts';

/**
 * Copie le fichier sous son vrai nom, dans un dossier à lui : le multipart part
 * sous le nom du fichier sur le disque. Rend `null` quand l'URI le porte déjà
 * ou que la copie échoue — le fichier part alors sous son nom de cache.
 */
async function namedCopy(
  uri: string,
  name: string,
): Promise<{ folder: string; file: string } | null> {
  const wanted = uploadName(uri, name);
  const cache = FileSystem.cacheDirectory;
  if (wanted === null || cache === null) return null;
  const folder = `${cache}envoi-nomme/${Date.now()}-${Math.random().toString(36).slice(2)}/`;
  try {
    await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
    const file = folder + encodeURIComponent(wanted);
    await FileSystem.copyAsync({ from: uri, to: file });
    return { folder, file };
  } catch {
    await FileSystem.deleteAsync(folder, { idempotent: true }).catch(() => {});
    return null;
  }
}

function expoTransportWith(field: string): TransportUpload {
  return async (url, headers, file, onProgress, onCancelable, fields) => {
    // Un fichier de cache purgé par l'OS (kill entre la sélection et le rejeu)
    // n'est PAS une panne réseau : erreur franche → statut « échec »,
    // abandonnable — pas une attente éternelle.
    const info = await FileSystem.getInfoAsync(file.uri);
    if (!info.exists) {
      throw new Error(`File not found (${file.name}), cache purged?`);
    }

    const copy = await namedCopy(file.uri, file.name);

    const task = FileSystem.createUploadTask(
      url,
      copy?.file ?? file.uri,
      {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: field,
        mimeType: file.type,
        headers,
        parameters: fields ?? {},
      },
      (progress) => {
        if (progress.totalBytesExpectedToSend > 0) {
          onProgress?.(progress.totalBytesSent / progress.totalBytesExpectedToSend);
        }
      },
    );
    // Remonté AVANT le premier octet : « Abandonner » doit pouvoir mordre dès
    // le début, sinon les octets continuent de monter après le geste et le
    // fichier finit par apparaître dans le salon.
    onCancelable?.(() => task.cancelAsync());

    let result;
    try {
      result = await task.uploadAsync();
    } catch {
      // `uploadAsync` ne rejette que quand AUCUNE réponse HTTP n'est arrivée :
      // c'est le réseau. Statut 0 = la ligne reste « en-attente », le rejeu du
      // prochain raccordement s'en charge — même sémantique que ClientRest.
      throw new RestError('Upload: server unreachable.', 0);
    } finally {
      // Réussi comme échoué : c'est le passage des octets qui fait tomber la
      // socket, pas le verdict du serveur.
      reportUploadEnd();
      if (copy !== null) {
        void FileSystem.deleteAsync(copy.folder, { idempotent: true }).catch(() => {});
      }
    }
    if (result == null) {
      throw new Error('Upload cancelled.');
    }
    return { status: result.status, body: result.body };
  };
}

/** Pièce jointe de salon (`rooms.media`), champ `file`. */
export const transportExpo = expoTransportWith('file');

/** Photo de profil (`users.setAvatar`), champ `image`. */
export const transportAvatarExpo = expoTransportWith('image');
