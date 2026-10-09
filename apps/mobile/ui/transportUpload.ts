/**
 * App-side upload transport: `expo-file-system/legacy` `createUploadTask`
 * in MULTIPART. Progress comes from `totalBytesSent`.
 *
 * Two variants, one body: the multipart FIELD NAME differs per endpoint:
 * `file` for `rooms.media` (attachment), `image` for `users.setAvatar`
 * (profile photo). The factory takes it as a parameter.
 */

import * as FileSystem from 'expo-file-system/legacy';

import { uploadName } from '../lib/attachment.ts';
import { RestError } from '../lib/rest.ts';
import type { TransportUpload } from '../lib/upload.ts';
import { reportUploadEnd } from './uploadProbe.ts';

/**
 * Copies the file under its real name, into a folder of its own: the
 * multipart goes out under the file's on-disk name. Returns `null` when the
 * URI already carries it or the copy fails; the file then goes out under its
 * cache name.
 */
async function namedCopy(
  uri: string,
  name: string,
): Promise<{ folder: string; file: string } | null> {
  const wanted = uploadName(uri, name);
  const cache = FileSystem.cacheDirectory;
  if (wanted === null || cache === null) return null;
  const folder = `${cache}envoi-nomme/${Date.now()}-${Math.random().toString(36).slice(2)}/`;
  try {
    await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
    const file = folder + encodeURIComponent(wanted);
    await FileSystem.copyAsync({ from: uri, to: file });
    return { folder, file };
  } catch {
    await FileSystem.deleteAsync(folder, { idempotent: true }).catch(() => {});
    return null;
  }
}

function expoTransportWith(field: string): TransportUpload {
  return async (url, headers, file, onProgress, onCancelable, fields) => {
    // A cache file purged by the OS (kill between selection and replay) is NOT
    // a network failure: a plain error → "failed" status, discardable, not an
    // endless wait.
    const info = await FileSystem.getInfoAsync(file.uri);
    if (!info.exists) {
      throw new Error(`File not found (${file.name}), cache purged?`);
    }

    const copy = await namedCopy(file.uri, file.name);

    const task = FileSystem.createUploadTask(
      url,
      copy?.file ?? file.uri,
      {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: field,
        mimeType: file.type,
        headers,
        parameters: fields ?? {},
      },
      (progress) => {
        if (progress.totalBytesExpectedToSend > 0) {
          onProgress?.(progress.totalBytesSent / progress.totalBytesExpectedToSend);
        }
      },
    );
    // Surfaced BEFORE the first byte: "Discard" must be able to bite from the
    // start, otherwise the bytes keep going up after the gesture and the file
    // ends up appearing in the room.
    onCancelable?.(() => task.cancelAsync());

    let result;
    try {
      result = await task.uploadAsync();
    } catch {
      // `uploadAsync` rejects only when NO HTTP response arrived: that is the
      // network. Status 0 = the row stays 'pending', the replay on the next
      // connection setup takes care of it; same semantics as RestClient.
      throw new RestError('Upload: server unreachable.', 0);
    } finally {
      // Success or failure alike: it is the bytes going through that drop the
      // socket, not the server's verdict.
      reportUploadEnd();
      if (copy !== null) {
        void FileSystem.deleteAsync(copy.folder, { idempotent: true }).catch(() => {});
      }
    }
    if (result == null) {
      throw new Error('Upload cancelled.');
    }
    return { status: result.status, body: result.body };
  };
}

/** Room attachment (`rooms.media`), field `file`. */
export const transportExpo = expoTransportWith('file');

/** Profile picture (`users.setAvatar`), `image` field. */
export const transportAvatarExpo = expoTransportWith('image');

/** Custom emoji (`emoji-custom.create`), `emoji` field. */
export const transportEmojiExpo = expoTransportWith('emoji');
