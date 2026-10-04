/**
 * Quality choice for a media attachment, the PURE part, tested under Node:
 * deciding WHEN to offer compression. The compression itself (effects:
 * expo-image-manipulator, the native Media3 module) lives in `compressAttachment`.
 *
 * "Reduced" is the default: pushing 12 Mpx or 4K for a chat preview wastes
 * the network, which is what image compression was already silently doing.
 * "Original" stays one tap away, for when quality is the point of the message.
 */

export type SendQuality = 'reduced' | 'original';

/** Below this size, compressing an image gains nothing: it is sent as is. */
export const IMAGE_COMPRESSION_THRESHOLD_BYTES = 500_000;

type MediaAttachment = { type: string; size: number | null };

/**
 * Image heavy enough to deserve the 1920 px JPEG. GIF is excluded (JPEG would
 * kill the animation), and an unknown size passes as is: we cannot tell
 * whether compression would pay off.
 */
export function imageCompressible(file: MediaAttachment): boolean {
  return (
    file.type.startsWith('image/') &&
    file.type !== 'image/gif' &&
    (file.size ?? 0) > IMAGE_COMPRESSION_THRESHOLD_BYTES
  );
}

/**
 * Every video is compressible, whatever its displayed size: even a phone 720p
 * is encoded at the capture bitrate (5 Mbps and up), which re-encoding
 * divides. The safeguard comes AFTERWARDS: if the output is not lighter than
 * the input, `compressVideoIfPossible` returns the original.
 */
export function videoCompressible(file: MediaAttachment): boolean {
  return file.type.startsWith('video/');
}

/** The Reduced/Original chips only show when the choice has an effect. */
export function compressionOffered(file: MediaAttachment): boolean {
  return imageCompressible(file) || videoCompressible(file);
}
