import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Pont du module natif, Kotlin (`android/src/main/java/com/rocketvibe/…`) et
 * Swift (`ios/ReducteurVideoModule.swift`), autolinké par Expo depuis
 * `modules/`. Ce fichier n'est importable QUE dans l'app : sous Node
 * (tests), `requireNativeModule` jetterait — la logique décidable vit dans
 * `ui/attachmentQuality.ts`, pur.
 */

export type CompressedVideo = {
  /** `file://…` dans le cache de l'app — supprimable par `supprimerSiTemporaire`. */
  uri: string;
  /** Poids réel du MP4 écrit, en octets. */
  taille: number;
};

type ReducteurVideoNatif = {
  reduire(uri: string, coteCourtMax: number, bitrateVideo: number): Promise<CompressedVideo>;
};

export const VideoCompressor = requireOptionalNativeModule<ReducteurVideoNatif>('ReducteurVideo');
