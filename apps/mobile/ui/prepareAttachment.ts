/**
 * Preparation of a media attachment: the EFFECTS (file rewriting); the
 * "offer downscaling or not" decision is pure and lives in
 * `attachmentQuality.ts`.
 *
 * A gallery photo weighs several megabytes, a video several tens: pushing
 * them as is risks a server refusal (`FileUpload_MaxFileSize`) and wastes
 * network for a chat preview. Images are downscaled to 1920 px JPEG
 * (expo-image-manipulator), videos to H.264 MP4 with short side ≤ 720
 * (Media3 native module, `modules/video-compressor`).
 *
 * In the composer, downscaling happens AT SEND time, per the choice shown on
 * the preview (Reduced/Original chips), no longer when the file is picked:
 * downscaling by default would charge a transcode to whoever removes the file
 * or wants the original. The share screen keeps its image compression on
 * mount (`compressImageIfUseful`).
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';

import { VideoCompressor } from '../modules/video-compressor/index.ts';
import type { PendingFile } from './attachmentPreview.tsx';
import { deleteIfTemporary } from './temporaryFiles.ts';
import { imageCompressible, videoCompressible } from './attachmentQuality.ts';

/** Maximum short side of a downscaled video, in pixels (720p). */
const VIDEO_MAX_SHORT_SIDE = 720;
/** Video bitrate of the re-encode, in the range messaging apps use. */
const VIDEO_BITRATE = 2_000_000;

/**
 * Gives the downscaled file the NAME of the original media. Needed because
 * the upload multipart (`createUploadTask`) sends the file name ON DISK; the
 * file's `name` field never goes through. Without this move, the room shows
 * the transcoder's technical name (`compressed-video-…`, seen on the bench).
 * A unique folder avoids the collision of two simultaneous sends with the
 * same name; once the row is settled only an empty folder remains, which the
 * OS purges. On failure, the original URI: an ugly name goes out, sending
 * beats it.
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
    // `size: null`: the exact weight of the rewritten JPEG is no longer known;
    // send validation will rely on the type only, which is enough.
    const name = `${file.name.replace(/\.\w+$/, '')}.jpg`;
    return {
      uri: await renameCompressed(compressed.uri, name),
      name,
      type: 'image/jpeg',
      size: null,
    };
  } catch {
    // Compression impossible: keep the original as is.
    return file;
  }
}

export async function compressVideoIfPossible(
  file: PendingFile,
): Promise<PendingFile> {
  if (VideoCompressor === null || !videoCompressible(file)) return file;
  try {
    const output = await VideoCompressor.compress(file.uri, VIDEO_MAX_SHORT_SIDE, VIDEO_BITRATE);
    // An already modest video can come out heavier from the re-encode: in that
    // case the original goes out, and the rewritten MP4 is deleted.
    if (file.size !== null && output.size >= file.size) {
      void deleteIfTemporary(output.uri);
      return file;
    }
    const name = `${file.name.replace(/\.\w+$/, '')}.mp4`;
    return {
      uri: await renameCompressed(output.uri, name),
      name,
      type: 'video/mp4',
      size: output.size,
    };
  } catch {
    // Transcode impossible (exotic codec, truncated file...): the original goes
    // out as is; as for images, a heavy send beats a failure.
    return file;
  }
}

/** The switch the composer calls at send time, when "Reduced" is chosen. */
export function compressAttachment(file: PendingFile): Promise<PendingFile> {
  if (file.type.startsWith('video/')) return compressVideoIfPossible(file);
  return compressImageIfUseful(file);
}
