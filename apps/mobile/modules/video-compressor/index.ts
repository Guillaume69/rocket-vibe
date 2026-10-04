import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Bridge to the native module, Kotlin (`android/src/main/java/com/rocketvibe/…`)
 * and Swift (`ios/VideoCompressorModule.swift`), autolinked by Expo from
 * `modules/`. This file is importable ONLY in the app: under Node (tests),
 * `requireNativeModule` would throw; the decidable logic lives in
 * `ui/attachmentQuality.ts`, pure.
 */

export type CompressedVideo = {
  /** `file://…` in the app cache, removable by `deleteIfTemporary`. */
  uri: string;
  /** Actual size of the written MP4, in bytes. */
  size: number;
};

type NativeVideoCompressor = {
  compress(uri: string, maxShortSide: number, videoBitrate: number): Promise<CompressedVideo>;
};

export const VideoCompressor = requireOptionalNativeModule<NativeVideoCompressor>('VideoCompressor');
