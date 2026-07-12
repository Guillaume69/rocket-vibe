/**
 * Préparation d'une pièce jointe AVANT l'aperçu et l'envoi — partagé entre le
 * composeur du salon (choix d'un fichier) et l'écran de partage (ACTION_SEND).
 *
 * Une photo de galerie pèse souvent plusieurs mégaoctets : la pousser telle
 * quelle, c'est risquer le refus du serveur (`FileUpload_MaxFileSize`) et
 * gaspiller le réseau pour un aperçu de chat. On la ramène à une largeur
 * raisonnable en JPEG. Les GIF gardent leur animation ; les images déjà
 * légères, ou de taille inconnue, passent inchangées.
 */

import * as ImageManipulator from 'expo-image-manipulator';

import type { FichierEnAttente } from './apercuPieceJointe.tsx';

export async function compresserImageSiUtile(
  fichier: FichierEnAttente,
): Promise<FichierEnAttente> {
  if (
    !fichier.type.startsWith('image/') ||
    fichier.type === 'image/gif' ||
    (fichier.taille ?? 0) <= 500_000
  ) {
    return fichier;
  }
  try {
    const reduite = await ImageManipulator.manipulateAsync(
      fichier.uri,
      [{ resize: { width: 1920 } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
    );
    // `taille: null` — on ne connaît plus le poids exact du JPEG réécrit ; la
    // validation d'envoi ne s'appuiera que sur le type, ce qui suffit.
    return {
      uri: reduite.uri,
      nom: `${fichier.nom.replace(/\.\w+$/, '')}.jpg`,
      type: 'image/jpeg',
      taille: null,
    };
  } catch {
    // Compression impossible : on garde l'original tel quel.
    return fichier;
  }
}
