/** Native adapter, shared by protected images and file exports. */
import { randomBytes } from 'crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { AuthorizedMediaCache } from '../lib/authorizedMediaCache.ts';
import { clearMediaSession, onMediaLeaseClosed } from '../lib/mediaAuth.ts';
import type { Session } from '../lib/auth.ts';

const root = `${FileSystem.cacheDirectory ?? ''}authorized-media-v2/`;
export const authorizedMedia = new AuthorizedMediaCache(root, randomBytes(16).toString('hex'), {
  prepare: async () => {
    if (FileSystem.cacheDirectory === null) throw new Error('No media cache directory.');
    await FileSystem.deleteAsync(`${FileSystem.cacheDirectory}authorized-media/`, { idempotent: true });
    // The old exporter mixed bearer-authenticated and Rocket.Chat copies here.
    await FileSystem.deleteAsync(`${FileSystem.cacheDirectory}jointes/`, { idempotent: true });
    await FileSystem.deleteAsync(root, { idempotent: true });
  },
  mkdir: folder => FileSystem.makeDirectoryAsync(folder, { intermediates: true }),
  download: async (url, path, headers, progress) => {
    const task = FileSystem.createDownloadResumable(url, path, { headers }, event => {
      progress?.(event.totalBytesWritten, event.totalBytesExpectedToWrite);
    });
    return (await task.downloadAsync())?.status ?? 0;
  },
  move: (from, to) => FileSystem.moveAsync({ from, to }),
  remove: path => FileSystem.deleteAsync(path, { idempotent: true }),
});
onMediaLeaseClosed(lease => { void authorizedMedia.close(lease).catch(() => {}); });
void authorizedMedia.prepare().catch(() => {});

/** Credentials disappear synchronously, before Keystore/network cleanup can yield. */
export function forgetAuthorizedMedia(session: Session): void {
  clearMediaSession(session.baseUrl, session.userId, session.authToken);
}
