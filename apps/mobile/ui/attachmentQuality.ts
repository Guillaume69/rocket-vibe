/**
 * Choix de qualité d'une pièce jointe média — la partie PURE, testée sous
 * Node : décider QUAND proposer la réduction. La réduction elle-même (effets :
 * expo-image-manipulator, module natif Media3) vit dans `preparerPieceJointe`.
 *
 * « Réduite » est le défaut : pousser 12 Mpx ou du 4K pour un aperçu de chat
 * gaspille le réseau — c'est ce que faisait déjà, en silence, la compression
 * d'images. « Originale » reste à un tap, pour les fois où la qualité est le
 * sujet du message.
 */

export type SendQuality = 'reduite' | 'originale';

/** Sous ce poids, réduire une image n'apporte rien — elle part telle quelle. */
export const IMAGE_COMPRESSION_THRESHOLD_BYTES = 500_000;

type PieceMedia = { type: string; size: number | null };

/**
 * Image assez lourde pour mériter le JPEG 1920 px. Le GIF est exclu (le JPEG
 * tuerait l'animation), et un poids inconnu passe tel quel — on ne sait pas si
 * la réduction paierait.
 */
export function imageCompressible(fichier: PieceMedia): boolean {
  return (
    fichier.type.startsWith('image/') &&
    fichier.type !== 'image/gif' &&
    (fichier.size ?? 0) > IMAGE_COMPRESSION_THRESHOLD_BYTES
  );
}

/**
 * Toute vidéo est réductible, quel que soit son poids affiché : même une 720p
 * de téléphone est encodée au bitrate de captation (5 Mbps et plus), que le
 * réencodage divise. Le garde-fou est APRÈS coup : si la sortie n'est pas plus
 * légère que l'entrée, `reduireVideoSiPossible` rend l'original.
 */
export function videoCompressible(fichier: PieceMedia): boolean {
  return fichier.type.startsWith('video/');
}

/** Les pastilles Réduite/Originale ne s'affichent que si le choix a un effet. */
export function compressionOffered(fichier: PieceMedia): boolean {
  return imageCompressible(fichier) || videoCompressible(fichier);
}
