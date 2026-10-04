/**
 * Préparation d'une pièce jointe média — les EFFETS (réécriture de fichiers) ;
 * la décision « proposer ou non la réduction » est pure et vit dans
 * `attachmentQuality.ts`.
 *
 * Une photo de galerie pèse plusieurs mégaoctets, une vidéo plusieurs
 * dizaines : les pousser tels quels, c'est risquer le refus du serveur
 * (`FileUpload_MaxFileSize`) et gaspiller le réseau pour un aperçu de chat.
 * L'image se réduit en JPEG 1920 px (expo-image-manipulator), la vidéo en MP4
 * H.264 côté court ≤ 720 (module natif Media3, `modules/video-compressor`).
 *
 * Dans le composeur, la réduction se fait À L'ENVOI, selon le choix affiché
 * sur l'aperçu (pastilles Réduite/Originale) — plus au moment du choix du
 * fichier : réduire d'office ferait payer un transcodage à qui retire la
 * pièce ou veut justement l'original. L'écran de partage, lui, garde sa
 * compression d'images au montage (`compresserImageSiUtile`).
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';

import { VideoCompressor } from '../modules/video-compressor/index.ts';
import type { PendingFile } from './attachmentPreview.tsx';
import { deleteIfTemporary } from './temporaryFiles.ts';
import { imageCompressible, videoCompressible } from './attachmentQuality.ts';

/** Côté court maximal d'une vidéo réduite, en pixels (720p). */
const VIDEO_MAX_SHORT_SIDE = 720;
/** Bitrate vidéo du réencodage — l'ordre de grandeur des messageries. */
const VIDEO_BITRATE = 2_000_000;

/**
 * Donne au fichier réduit le NOM du média d'origine. Nécessaire parce que le
 * multipart d'upload (`createUploadTask`) envoie le nom du fichier SUR DISQUE
 * — le champ `nom` de la pièce n'y passe jamais. Sans ce déplacement, le salon
 * affiche le nom technique du transcodeur (`video-reduite-…`, vu au banc).
 * Un dossier unique pare la collision de deux envois simultanés du même nom ;
 * une fois la ligne soldée il n'en reste qu'un dossier vide, que l'OS purge.
 * En échec, l'URI d'origine : un nom moche part — l'envoi vaut mieux que lui.
 */
async function renameCompressed(uri: string, name: string): Promise<string> {
  const cache = FileSystem.cacheDirectory;
  if (cache === null) return uri;
  try {
    const folder = `${cache}reduites-${Date.now().toString(36)}/`;
    await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
    const destination = `${folder}${encodeURIComponent(name)}`;
    await FileSystem.moveAsync({ from: uri, to: destination });
    return destination;
  } catch {
    return uri;
  }
}

export async function compressImageIfUseful(
  file: PendingFile,
): Promise<PendingFile> {
  if (!imageCompressible(file)) return file;
  try {
    const compressed = await ImageManipulator.manipulateAsync(
      file.uri,
      [{ resize: { width: 1920 } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
    );
    // `taille: null` — on ne connaît plus le poids exact du JPEG réécrit ; la
    // validation d'envoi ne s'appuiera que sur le type, ce qui suffit.
    const name = `${file.name.replace(/\.\w+$/, '')}.jpg`;
    return {
      uri: await renameCompressed(compressed.uri, name),
      name,
      type: 'image/jpeg',
      size: null,
    };
  } catch {
    // Compression impossible : on garde l'original tel quel.
    return file;
  }
}

export async function compressVideoIfPossible(
  file: PendingFile,
): Promise<PendingFile> {
  if (VideoCompressor === null || !videoCompressible(file)) return file;
  try {
    const outbox = await VideoCompressor.reduire(file.uri, VIDEO_MAX_SHORT_SIDE, VIDEO_BITRATE);
    // Une vidéo déjà modeste peut ressortir plus lourde du réencodage : dans
    // ce cas l'original part, et le MP4 réécrit s'efface.
    if (file.size !== null && outbox.taille >= file.size) {
      void deleteIfTemporary(outbox.uri);
      return file;
    }
    const name = `${file.name.replace(/\.\w+$/, '')}.mp4`;
    return {
      uri: await renameCompressed(outbox.uri, name),
      name,
      type: 'video/mp4',
      size: outbox.taille,
    };
  } catch {
    // Transcodage impossible (codec exotique, fichier tronqué…) : l'original
    // part tel quel — comme pour l'image, un envoi lourd vaut mieux qu'un échec.
    return file;
  }
}

/** L'aiguillage appelé par le composeur à l'envoi, quand « Réduite » est choisi. */
export function compressAttachment(file: PendingFile): Promise<PendingFile> {
  if (file.type.startsWith('video/')) return compressVideoIfPossible(file);
  return compressImageIfUseful(file);
}
