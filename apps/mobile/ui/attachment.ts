/**
 * Native wiring of `lib/attachment.ts`: `expo-file-system/legacy` to download
 * into the cache, `expo-sharing` to open the share sheet on the local file.
 *
 * `expo-sharing` is a level-1 native binding in the sense of ROADMAP §4.2: it
 * exposes `Intent.ACTION_SEND` and installs its own `FileProvider`, imposing
 * neither component nor look. No config plugin to write; `expo install` added
 * its entry to `app.json`, but a `prebuild` + rebuild is needed for the module
 * to exist natively.
 *
 * The logic (name sanitising, folder per file id) stays in `lib/`, where it is
 * tested under Node: this file cannot be imported off device. Same pattern as
 * `ui/transportUpload.ts`.
 */

import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import * as Sharing from 'expo-sharing';

import { decryptFile, type FileEncryption } from '../lib/e2e/crypto.ts';
import { downloadedFraction, downloadAttachment, toGallery } from '../lib/attachment.ts';
import { Downloads } from '../modules/downloads/index.ts';
import {loadNativeFile} from '../lib/nativeFiles.ts';
import {exportNativePreview} from '../lib/nativePreviews.ts';
import type { Progress } from './transfers.ts';
import { mediaHeaders } from '../lib/mediaAuth.ts';

/** Thrown when nothing can open the file: the caller tells the screen. */
export class FileOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileOpenError';
  }
}

type AttachmentOptions = {
  url: string;
  title: string | null | undefined;
  type: string | null | undefined;
  /** Size announced by the message, in bytes. */
  size?: number | null;
  /** File from an encrypted room: we download ciphertext and keep the plaintext. */
  encryption?: FileEncryption | null;
  onProgress?: (p: Progress) => void;
};

/**
 * Downloads into the cache, or finds the file there: writes go through a
 * `.part` renamed at the end, so a file present under its real name is
 * COMPLETE. Sharing after saving downloads nothing again.
 */
async function toCache(options: AttachmentOptions): Promise<string> {
  if(options.url.startsWith('rv-file:'))return loadNativeFile(options.url,options.onProgress);
  const folder = FileSystem.cacheDirectory;
  if (folder === null) {
    throw new FileOpenError('No cache directory available.');
  }
  return downloadAttachment({
    ...options,
    folder,
    createFolder: async (path) => {
      await FileSystem.makeDirectoryAsync(path, { intermediates: true });
    },
    download: async (url, destination) => {
      if ((await FileSystem.getInfoAsync(destination)).exists) return;
      // A file already decrypted in OUR cache (the viewer saving an encrypted
      // image): nothing to download.
      if (url.startsWith(folder)) {
        await FileSystem.copyAsync({ from: url, to: destination });
        return;
      }
      const partial = `${destination}.part`;
      const task = FileSystem.createDownloadResumable(url, partial, { headers: mediaHeaders(url) }, (e) => {
        options.onProgress?.(
          downloadedFraction(e.totalBytesWritten, e.totalBytesExpectedToWrite, options.size),
        );
      });
      const res = await task.downloadAsync();
      // A 401/403/404 still gets written to disk: without this check, we would
      // share or save the error's JSON body.
      if (res === undefined || res.status !== 200) {
        await FileSystem.deleteAsync(partial, { idempotent: true });
        throw new FileOpenError(`Download refused (HTTP ${res?.status ?? 0}).`);
      }
      if (options.encryption) {
        const base64 = { encoding: FileSystem.EncodingType.Base64 };
        try {
          const encrypted = Buffer.from(await FileSystem.readAsStringAsync(partial, base64), 'base64');
          const plain = decryptFile(encrypted, options.encryption);
          await FileSystem.writeAsStringAsync(partial, plain.toString('base64'), base64);
        } catch {
          await FileSystem.deleteAsync(partial, { idempotent: true });
          throw new FileOpenError('Encrypted file unreadable.');
        }
      }
      await FileSystem.moveAsync({ from: partial, to: destination });
    },
  });
}

const inProgress = new Map<string, Promise<string>>();

/**
 * The plaintext file of an encrypted attachment, in the cache, for display.
 * The same attachment shown twice on screen is downloaded only once.
 */
export function decryptedFile(options: AttachmentOptions): Promise<string> {
  const existing = inProgress.get(options.url);
  if (existing !== undefined) return existing;
  const promise = toCache(options).finally(() => inProgress.delete(options.url));
  inProgress.set(options.url, promise);
  return promise;
}

/**
 * Downloads the protected attachment, then opens the share sheet on it.
 * The authenticated URL never leaves the process: only the local `file://`
 * is handed to the system.
 */
export async function openProtectedAttachment(options: AttachmentOptions): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new FileOpenError('File sharing is unavailable.');
  }
  const local = await toCache(options);
  await Sharing.shareAsync(local, options.type ? { mimeType: options.type } : {});
}

/** Hands an ALREADY local file to the system (an attachment not yet sent). */
export async function openLocalFile(uri: string, type: string | null): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new FileOpenError('File sharing is unavailable.');
  }
  await Sharing.shareAsync(uri, type ? { mimeType: type } : {});
}

export type SaveLocation = 'gallery' | 'downloads' | 'share';

/**
 * Downloads the protected attachment, then SAVES it on the device: photo,
 * video and sound into the gallery, any other file into Downloads, both
 * through MediaStore, without permission since Android 10.
 */
export async function saveProtectedAttachment(options: AttachmentOptions): Promise<SaveLocation> {
  if(options.url.startsWith('rv-preview:'))return exportNativePreview(options.url,async(bytes,valid)=>{
    const directory=FileSystem.cacheDirectory;if(!directory)throw new FileOpenError('Aucun dossier de cache disponible.');
    const local=`${directory}preview-${options.url.slice(options.url.lastIndexOf('/')+1)}-${Date.now().toString(36)}.png`;
    try{
      await FileSystem.writeAsStringAsync(local,Buffer.from(bytes).toString('base64'),{encoding:FileSystem.EncodingType.Base64});
      if(!await valid())throw new FileOpenError('Accès retiré.');
      try{await Asset.create(local);}catch{
        const permission=await requestPermissionsAsync(true);
        if(!permission.granted||!await valid())throw new FileOpenError('Accès retiré.');
        await Asset.create(local);
      }
      return 'gallery' as const;
    }finally{await FileSystem.deleteAsync(local,{idempotent:true});}
  });
  const local = await toCache(options);
  const name = local.slice(local.lastIndexOf('/') + 1);

  if (toGallery(name, options.type)) {
    try {
      await Asset.create(local);
    } catch {
      // Android 9 and earlier: writing to shared storage still requires the
      // permission. Ask for it, then retry once.
      const permission = await requestPermissionsAsync(true);
      if (!permission.granted) throw new FileOpenError('Permission denied.');
      await Asset.create(local);
    }
    return 'gallery';
  }

  // iOS has no Downloads folder: the share sheet offers "Save to Files".
  if (Downloads === null) {
    await Sharing.shareAsync(local, options.type ? { mimeType: options.type } : undefined);
    return 'share';
  }
  await Downloads.save(local, name, options.type ?? null);
  return 'downloads';
}
