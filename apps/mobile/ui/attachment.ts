/**
 * Câblage natif de `lib/attachment.ts` : `expo-file-system/legacy` pour
 * télécharger dans le cache, `expo-sharing` pour ouvrir la feuille de partage
 * sur le fichier local.
 *
 * `expo-sharing` est un binding natif de niveau 1 au sens de ROADMAP §4.2 — il
 * expose `Intent.ACTION_SEND` et pose son propre `FileProvider`, sans imposer
 * ni composant ni look. Aucun config plugin à écrire ; `expo install` a ajouté
 * son entrée dans `app.json`, mais il faut un `prebuild` + rebuild pour que le
 * module existe côté natif.
 *
 * La logique (assainissement du nom, dossier par identifiant de fichier) reste
 * dans `lib/`, où elle se teste sous Node : ce fichier-ci n'est pas importable
 * hors appareil. Même patron que `ui/transportUpload.ts`.
 */

import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import * as Sharing from 'expo-sharing';

import { decryptFile, type FileEncryption } from '../lib/e2e/crypto.ts';
import { downloadedFraction, downloadAttachment, toGallery } from '../lib/attachment.ts';
import { Downloads } from '../modules/downloads/index.ts';
import type { Progress } from './transfers.ts';

/** Levée quand rien ne peut ouvrir le fichier : l'appelant en informe l'écran. */
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
  /** Poids annoncé par le message, en octets. */
  size?: number | null;
  /** Fichier d'un salon chiffré : on télécharge du chiffré, on garde le clair. */
  encryption?: FileEncryption | null;
  onProgress?: (p: Progress) => void;
};

/**
 * Télécharge dans le cache, ou y retrouve le fichier : l'écriture passe par un
 * `.part` renommé à la fin, donc un fichier présent sous son vrai nom est
 * COMPLET. Partager après avoir enregistré ne retélécharge rien.
 */
async function toCache(options: AttachmentOptions): Promise<string> {
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
      // Un fichier déjà déchiffré dans NOTRE cache (la visionneuse qui
      // enregistre une image chiffrée) : rien à télécharger.
      if (url.startsWith(folder)) {
        await FileSystem.copyAsync({ from: url, to: destination });
        return;
      }
      const partial = `${destination}.part`;
      const task = FileSystem.createDownloadResumable(url, partial, {}, (e) => {
        options.onProgress?.(
          downloadedFraction(e.totalBytesWritten, e.totalBytesExpectedToWrite, options.size),
        );
      });
      const res = await task.downloadAsync();
      // Un 401/403/404 s'écrit quand même sur le disque : sans ce contrôle, on
      // partagerait ou enregistrerait le corps JSON de l'erreur.
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
 * Le fichier clair d'une pièce jointe chiffrée, dans le cache — pour l'afficher.
 * Une même pièce vue deux fois à l'écran ne se télécharge qu'une fois.
 */
export function decryptedFile(options: AttachmentOptions): Promise<string> {
  const existing = inProgress.get(options.url);
  if (existing !== undefined) return existing;
  const promise = toCache(options).finally(() => inProgress.delete(options.url));
  inProgress.set(options.url, promise);
  return promise;
}

/**
 * Télécharge la pièce jointe protégée puis ouvre la feuille de partage dessus.
 * L'URL authentifiée ne sort pas du processus : seul le `file://` local est
 * confié au système.
 */
export async function openProtectedAttachment(options: AttachmentOptions): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new FileOpenError('File sharing is unavailable.');
  }
  const local = await toCache(options);
  await Sharing.shareAsync(local, options.type ? { mimeType: options.type } : {});
}

/** Confie au système un fichier DÉJÀ local (une pièce pas encore envoyée). */
export async function openLocalFile(uri: string, type: string | null): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new FileOpenError('File sharing is unavailable.');
  }
  await Sharing.shareAsync(uri, type ? { mimeType: type } : {});
}

export type SaveLocation = 'gallery' | 'downloads' | 'share';

/**
 * Télécharge la pièce jointe protégée puis l'ENREGISTRE sur l'appareil : photo,
 * vidéo et son dans la galerie, tout autre fichier dans Téléchargements — les
 * deux par MediaStore, sans permission depuis Android 10.
 */
export async function saveProtectedAttachment(options: AttachmentOptions): Promise<SaveLocation> {
  const local = await toCache(options);
  const name = local.slice(local.lastIndexOf('/') + 1);

  if (toGallery(name, options.type)) {
    try {
      await Asset.create(local);
    } catch {
      // Android 9 et avant : l'écriture dans le stockage partagé exige encore
      // la permission. On la demande, puis on réessaie une fois.
      const permission = await requestPermissionsAsync(true);
      if (!permission.granted) throw new FileOpenError('Permission denied.');
      await Asset.create(local);
    }
    return 'gallery';
  }

  // iOS n'a pas de dossier Téléchargements : la feuille de partage propose
  // « Enregistrer dans Fichiers ».
  if (Downloads === null) {
    await Sharing.shareAsync(local, options.type ? { mimeType: options.type } : undefined);
    return 'share';
  }
  await Downloads.enregistrer(local, name, options.type ?? null);
  return 'downloads';
}
