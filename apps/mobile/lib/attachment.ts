/**
 * Ouvrir une pièce jointe « fichier » (PDF, archive, tableur…) SANS laisser
 * sortir le jeton.
 *
 * L'URL d'un fichier protégé porte `rc_uid`/`rc_token` en query — le middleware
 * de Rocket.Chat s'authentifie ainsi, pas par en-tête (basculer sur
 * `X-Auth-Token` serait un 403 déguisé en correctif). La confier à
 * `Linking.openURL` la déposait dans Chrome, son historique et sa
 * synchronisation ; l'image et la vidéo, elles, respectaient déjà l'invariant
 * de `ui/imageViewer.tsx` en gardant l'URL en mémoire.
 *
 * On fait donc ce que fait la visionneuse, en deux temps : **télécharger dans
 * le cache** (la requête authentifiée reste dans le processus), puis **partager
 * le fichier LOCAL** via la feuille de partage Android — qui reçoit un
 * `content://` de notre FileProvider, sans un octet de secret.
 *
 * Module pur : les trois capacités natives (créer un dossier, télécharger,
 * partager) sont injectées, `ui/attachment.ts` les câble. Même patron que
 * `TransportUpload` (lib/upload.ts).
 */

import { isQuoteAttachment } from './quote.ts';
import { attachmentEncryption, type FileEncryption } from './e2e/crypto.ts';

/** Crée un dossier et ses parents. Doit être sans effet s'il existe déjà. */
export type CreateFolder = (path: string) => Promise<void>;

/** Télécharge `url` (authentifiée) vers `destination`, un `file://` local. */
export type DownloadFile = (url: string, destination: string) => Promise<void>;

/** Ouvre la feuille de partage du système sur un fichier LOCAL. */
export type ShareFile = (localFile: string, type: string | null) => Promise<void>;

/** Nom de dernier recours, quand le message n'en propose aucun d'exploitable. */
const FALLBACK_NAME = 'fichier';

/** Sous-dossier de dernier recours, quand l'URL ne porte pas d'identifiant. */
const FALLBACK_KEY = 'divers';

/**
 * Caractères qu'un nom de fichier ne doit pas porter : contrôles, et ceux que
 * les systèmes de fichiers (ou les applications réceptrices) traitent à part.
 *
 * On s'écarte ici du `[A-Za-z0-9._-]` prescrit par l'audit, qui aurait rendu
 * `résumé-2026.pdf` en `r_sum_-2026.pdf` sous les yeux de l'utilisateur. Ce
 * qu'il faut garantir est plus étroit : que le nom ne puisse pas s'échapper du
 * dossier de destination. Les séparateurs sont retirés en amont (on ne garde
 * que le dernier segment), les points de tête et de queue aussi — donc ni `.`,
 * ni `..`, ni chemin. Le reste des lettres peut vivre.
 */
const HOSTILE =/[\u0000-\u001f\u007f\\/:*?"<>|]/g;

/** Longueur max d'un nom de fichier — sous la limite ext4 (255 octets). */
const MAX_NAME = 120;

function cap(name: string): string {
  if (name.length <= MAX_NAME) return name;
  const dot = name.lastIndexOf('.');
  // Extension conservée seulement si elle en a l'air : c'est elle qui décide de
  // l'application qui s'ouvrira.
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  return name.slice(0, MAX_NAME - ext.length) + ext;
}

/** Segments non vides du CHEMIN d'une URL (query et fragment retirés). */
function segments(url: string): string[] {
  const path = url.split(/[?#]/)[0] ?? '';
  return path.split('/').filter((s) => s !== '' && s !== '.');
}

function decoder(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // Un `%` isolé dans le nom : on garde la forme brute plutôt que rien.
    return s;
  }
}

/**
 * Nom de destination sûr à partir d'un nom proposé par autrui (le `title` du
 * message, ou le dernier segment de l'URL). Ne peut jamais désigner autre chose
 * qu'un fichier du dossier de destination.
 */
export function safeFileName(proposed: string | null | undefined): string {
  const raw = typeof proposed === 'string' ? proposed : '';
  // `../../evil.sh` → `evil.sh` : seul le dernier segment est retenu, ce qui
  // neutralise la remontée de dossier avant même l'assainissement.
  const parts = raw.split(/[/\\]/).filter((s) => s !== '');
  const last = parts.length > 0 ? parts[parts.length - 1]! : '';
  const clean = last.replace(HOSTILE, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  return clean === '' ? FALLBACK_NAME : cap(clean);
}

/**
 * Identifiant du fichier côté serveur, extrait de l'URL
 * (`/file-upload/<_id>/<nom>`), pour servir de SOUS-DOSSIER de cache.
 *
 * Sans lui, deux pièces jointes nommées `facture.pdf` se recouvriraient dans le
 * cache — et un partage lancé sur l'une pourrait présenter l'autre. L'`_id`
 * Rocket.Chat est immuable, le dossier est donc stable d'une ouverture à
 * l'autre.
 */
export function fileKey(url: string): string {
  const parts = segments(url);
  const raw = parts.length >= 2 ? parts[parts.length - 2]! : '';
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '');
  return clean === '' ? FALLBACK_KEY : clean.slice(0, 64);
}

const EXTENSIONS_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'application/pdf': 'pdf',
};

const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/**
 * Complète un nom sans extension d'après le MIME. C'est l'extension qui décide
 * de l'application qui ouvrira le fichier, et de l'endroit où la galerie le
 * range : un `photo` nu y serait classé comme une image quelconque.
 */
export function withExtension(name: string, type: string | null | undefined): string {
  if (HAS_EXTENSION.test(name) || typeof type !== 'string') return name;
  const mime = type.toLowerCase().split(';')[0]!.trim();
  const known = EXTENSIONS_BY_TYPE[mime];
  if (known !== undefined) return `${name}.${known}`;
  const subType = mime.split('/')[1] ?? '';
  return /^[a-z0-9]{1,8}$/.test(subType) ? `${name}.${subType}` : name;
}

const EXTENSIONS_MEDIA = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp',
  'mp4', 'mov', 'webm', 'mkv', '3gp', 'm4v',
  'mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac',
]);

/**
 * Photo, vidéo ou son : la galerie (MediaStore) sait les ranger. Tout le
 * reste (PDF, archive…) va dans un dossier choisi par l'utilisateur.
 */
export function toGallery(name: string, type: string | null | undefined): boolean {
  if (typeof type === 'string' && /^(image|video|audio)\//i.test(type)) return true;
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return name.includes('.') && EXTENSIONS_MEDIA.has(ext);
}

/**
 * Télécharge la pièce jointe dans le cache et rend son chemin local.
 *
 * `url` porte le jeton et ne quitte JAMAIS cette fonction : elle n'est passée
 * qu'à `telecharger`, dont l'implémentation fait une requête HTTP interne.
 */
export async function downloadAttachment(options: {
  /** URL protégée, jeton compris. */
  url: string;
  /** `title` du message — proposé par autrui, donc assaini. */
  title: string | null | undefined;
  /** MIME annoncé : complète l'extension quand le nom n'en a pas. */
  type: string | null | undefined;
  /** Dossier de cache de l'app (`file:///…/cache/`). */
  folder: string;
  createFolder: CreateFolder;
  download: DownloadFile;
}): Promise<string> {
  const { url, title, type, folder, createFolder, download } = options;

  const root = folder.endsWith('/') ? folder : `${folder}/`;
  const subFolder = `${root}jointes/${fileKey(url)}/`;
  // Le `title` d'abord (c'est ce que l'utilisateur voit dans le fil), le dernier
  // segment de l'URL en repli — décodé, sans quoi `mon%20rapport.pdf`
  // s'écrirait avec son `%20`.
  const fromUrl = segments(url).at(-1);
  const name = withExtension(
    safeFileName(
      typeof title === 'string' && title.trim() !== ''
        ? title
        : fromUrl === undefined
          ? null
          : decoder(fromUrl),
    ),
    type,
  );
  const destination = `${subFolder}${name}`;

  await createFolder(subFolder);
  await download(url, destination);
  return destination;
}

/**
 * Télécharge la pièce jointe et ouvre la feuille de partage dessus. Rend le
 * chemin local ; `partager` ne reçoit que lui, jamais l'URL.
 */
export async function openAttachment(options: {
  url: string;
  title: string | null | undefined;
  /** MIME annoncé, passé tel quel à la feuille de partage. */
  type: string | null | undefined;
  folder: string;
  createFolder: CreateFolder;
  download: DownloadFile;
  share: ShareFile;
}): Promise<string> {
  const { share, ...rest } = options;
  const destination = await downloadAttachment(rest);
  await share(destination, typeof options.type === 'string' && options.type !== '' ? options.type : null);
  return destination;
}

export type ShareableAttachment = {
  /** Chemin (relatif au serveur) de l'ORIGINAL, sans jeton. */
  path: string;
  title: string | null;
  type: string | null;
  /** Poids annoncé par le message, en octets : la progression s'y rapporte quand le serveur tait le sien. */
  size: number | null;
  /** Fichier d'un salon chiffré : sa clé, pour le rendre en clair. */
  encryption: FileEncryption | null;
};

type RawAttachment = {
  title?: unknown;
  title_link?: unknown;
  image_url?: unknown;
  video_url?: unknown;
  audio_url?: unknown;
  image_type?: unknown;
  video_type?: unknown;
  audio_type?: unknown;
  size?: unknown;
  image_size?: unknown;
  video_size?: unknown;
  audio_size?: unknown;
};

function bytes(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * La première pièce jointe du message qu'on peut partager comme FICHIER :
 * `title_link` d'abord, qui désigne l'original là où `image_url` n'est que la
 * vignette. Les citations sont ignorées : on partage ce que le message porte.
 */
export function attachmentToShare(attachments: string | null): ShareableAttachment | null {
  let raw: unknown;
  try {
    raw = JSON.parse(attachments ?? '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  for (const attachment of raw as unknown[]) {
    if (typeof attachment !== 'object' || attachment === null || isQuoteAttachment(attachment)) continue;
    const j = attachment as RawAttachment;
    const path =
      asString(j.title_link) ?? asString(j.image_url) ?? asString(j.video_url) ?? asString(j.audio_url);
    if (path === null) continue;
    return {
      path,
      title: asString(j.title),
      type: asString(j.image_type) ?? asString(j.video_type) ?? asString(j.audio_type),
      size: bytes(j.size) ?? bytes(j.image_size) ?? bytes(j.video_size) ?? bytes(j.audio_size),
      encryption: attachmentEncryption(attachment),
    };
  }
  return null;
}

/**
 * Fraction téléchargée. Le serveur de fichiers ne répond pas toujours avec sa
 * taille (réponse en `chunked`) : on se rapporte alors au poids annoncé par le
 * message, plafonné à 1. `null` si on ne sait rien du tout.
 */
export function downloadedFraction(
  written: number,
  expected: number,
  size: number | null | undefined,
): number | null {
  const total = expected > 0 ? expected : (size ?? 0);
  return total > 0 ? Math.min(written / total, 1) : null;
}

/**
 * Le nom sous lequel téléverser un fichier local, quand celui de son URI n'est
 * pas le sien. Le multipart d'`expo-file-system` prend le nom du fichier sur
 * le disque, et le serveur le garde tel quel : une copie de cache (sélecteur,
 * réduction) partirait sous un nom aléatoire. `null` : l'URI porte déjà le bon.
 */
export function uploadName(uri: string, name: string): string | null {
  const wanted = safeFileName(name);
  const current = decoder(uri.split(/[?#]/)[0]!.split('/').pop() ?? '');
  return current === wanted ? null : wanted;
}
