/**
 * Temporary file cleanup (7.6).
 *
 * Preparing an attachment always writes one: `ImagePicker` and
 * `DocumentPicker({copyToCacheDirectory:true})` copy the chosen media,
 * `compressImageIfUseful` rewrites a JPEG, the recorder produces an `.m4a`.
 * Nothing ever erased them: a search for `deleteAsync` over the whole repo
 * returned NO call. The only purge was Android's under disk pressure, which
 * breaks the sends still queued along the way.
 *
 * **The guard is the only thing that matters here.** An attachment URI can
 * point to a file the user did not hand over for copying: a MediaStore
 * `content://`, a file opened in place. Erasing it would destroy someone's
 * photo. So we delete ONLY under the app's cache directory, the only place
 * whose files belong to us.
 */

import * as FileSystem from 'expo-file-system/legacy';

/**
 * `null` on platforms where the cache is not exposed: the guard is then
 * closed, and nothing is ever deleted. That is the right failure.
 */
const CACHE = FileSystem.cacheDirectory;

/** True if the URI points to a file WE wrote in the app's cache. */
export function isTemporaryFile(uri: string): boolean {
  // Native code sometimes returns an empty string instead of a URI (the audio
  // recorder, notably): `''.startsWith(…)` is false, but we say so here rather
  // than rely on a side effect.
  if (uri === '' || CACHE === null) return false;
  return uri.startsWith(CACHE);
}

/**
 * Erases a temporary file, never failing the caller: the file may already
 * have been purged by Android, and cleanup is not worth losing a message.
 */
export async function deleteIfTemporary(uri: string): Promise<void> {
  if (!isTemporaryFile(uri)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Nothing to do, nothing to say: Android's next cleanup will get it.
  }
}
