/**
 * Préparation d'une pièce jointe média — les EFFETS (réécriture de fichiers) ;
 * la décision « proposer ou non la réduction » est pure et vit dans
 * `qualitePieceJointe.ts`.
 *
 * Une photo de galerie pèse plusieurs mégaoctets, une vidéo plusieurs
 * dizaines : les pousser tels quels, c'est risquer le refus du serveur
 * (`FileUpload_MaxFileSize`) et gaspiller le réseau pour un aperçu de chat.
 * L'image se réduit en JPEG 1920 px (expo-image-manipulator), la vidéo en MP4
 * H.264 côté court ≤ 720 (module natif Media3, `modules/reducteur-video`).
 *
 * Dans le composeur, la réduction se fait À L'ENVOI, selon le choix affiché
 * sur l'aperçu (pastilles Réduite/Originale) — plus au moment du choix du
 * fichier : réduire d'office ferait payer un transcodage à qui retire la
 * pièce ou veut justement l'original. L'écran de partage, lui, garde sa
 * compression d'images au montage (`compresserImageSiUtile`).
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';

import { ReducteurVideo } from '../modules/reducteur-video/index.ts';
import type { FichierEnAttente } from './apercuPieceJointe.tsx';
import { supprimerSiTemporaire } from './fichiersTemporaires.ts';
import { imageReductible, videoReductible } from './qualitePieceJointe.ts';

/** Côté court maximal d'une vidéo réduite, en pixels (720p). */
const VIDEO_COTE_COURT_MAX = 720;
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
async function renommerReduit(uri: string, nom: string): Promise<string> {
  const cache = FileSystem.cacheDirectory;
  if (cache === null) return uri;
  try {
    const dossier = `${cache}reduites-${Date.now().toString(36)}/`;
    await FileSystem.makeDirectoryAsync(dossier, { intermediates: true });
    const destination = `${dossier}${encodeURIComponent(nom)}`;
    await FileSystem.moveAsync({ from: uri, to: destination });
    return destination;
  } catch {
    return uri;
  }
}

export async function compresserImageSiUtile(
  fichier: FichierEnAttente,
): Promise<FichierEnAttente> {
  if (!imageReductible(fichier)) return fichier;
  try {
    const reduite = await ImageManipulator.manipulateAsync(
      fichier.uri,
      [{ resize: { width: 1920 } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
    );
    // `taille: null` — on ne connaît plus le poids exact du JPEG réécrit ; la
    // validation d'envoi ne s'appuiera que sur le type, ce qui suffit.
    const nom = `${fichier.nom.replace(/\.\w+$/, '')}.jpg`;
    return {
      uri: await renommerReduit(reduite.uri, nom),
      nom,
      type: 'image/jpeg',
      taille: null,
    };
  } catch {
    // Compression impossible : on garde l'original tel quel.
    return fichier;
  }
}

export async function reduireVideoSiPossible(
  fichier: FichierEnAttente,
): Promise<FichierEnAttente> {
  if (!videoReductible(fichier)) return fichier;
  try {
    const sortie = await ReducteurVideo.reduire(fichier.uri, VIDEO_COTE_COURT_MAX, VIDEO_BITRATE);
    // Une vidéo déjà modeste peut ressortir plus lourde du réencodage : dans
    // ce cas l'original part, et le MP4 réécrit s'efface.
    if (fichier.taille !== null && sortie.taille >= fichier.taille) {
      void supprimerSiTemporaire(sortie.uri);
      return fichier;
    }
    const nom = `${fichier.nom.replace(/\.\w+$/, '')}.mp4`;
    return {
      uri: await renommerReduit(sortie.uri, nom),
      nom,
      type: 'video/mp4',
      taille: sortie.taille,
    };
  } catch {
    // Transcodage impossible (codec exotique, fichier tronqué…) : l'original
    // part tel quel — comme pour l'image, un envoi lourd vaut mieux qu'un échec.
    return fichier;
  }
}

/** L'aiguillage appelé par le composeur à l'envoi, quand « Réduite » est choisi. */
export function reduirePieceJointe(fichier: FichierEnAttente): Promise<FichierEnAttente> {
  if (fichier.type.startsWith('video/')) return reduireVideoSiPossible(fichier);
  return compresserImageSiUtile(fichier);
}
