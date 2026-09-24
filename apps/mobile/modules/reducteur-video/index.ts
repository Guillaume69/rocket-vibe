import { requireNativeModule } from 'expo-modules-core';

/**
 * Pont du module natif Kotlin (`android/src/main/java/com/rocketvibe/…`),
 * autolinké par Expo depuis `modules/`. Android seulement, comme le reste du
 * projet à ce stade. Ce fichier n'est importable QUE dans l'app : sous Node
 * (tests), `requireNativeModule` jetterait — la logique décidable vit dans
 * `ui/qualitePieceJointe.ts`, pur.
 */

export type VideoReduite = {
  /** `file://…` dans le cache de l'app — supprimable par `supprimerSiTemporaire`. */
  uri: string;
  /** Poids réel du MP4 écrit, en octets. */
  taille: number;
};

type ReducteurVideoNatif = {
  reduire(uri: string, coteCourtMax: number, bitrateVideo: number): Promise<VideoReduite>;
};

export const ReducteurVideo = requireNativeModule<ReducteurVideoNatif>('ReducteurVideo');
