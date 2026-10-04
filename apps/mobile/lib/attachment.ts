/**
 * Opening a "file" attachment (PDF, archive, spreadsheet…) WITHOUT letting the
 * token out.
 *
 * A protected file's URL carries `rc_uid`/`rc_token` in the query: that is how
 * Rocket.Chat's middleware authenticates, not by header (switching to
 * `X-Auth-Token` would be a 403 disguised as a fix). Handing it to
 * `Linking.openURL` dropped it into Chrome, its history and its sync; images
 * and videos already honoured the `ui/imageViewer.tsx` invariant by keeping
 * the URL in memory.
 *
 * So this does what the viewer does, in two steps: **download into the cache**
 * (the authenticated request stays in the process), then **share the LOCAL
 * file** through the Android share sheet, which receives a `content://` from
 * our FileProvider, without a single byte of secret.
 *
 * Pure module: the three native capabilities (create a folder, download,
 * share) are injected, `ui/attachment.ts` wires them. Same pattern as
 * `TransportUpload` (lib/upload.ts).
 */

import { isQuoteAttachment } from './quote.ts';
import { attachmentEncryption, type FileEncryption } from './e2e/crypto.ts';

/** Creates a folder and its parents. Must be a no-op if it already exists. */
export type CreateFolder = (path: string) => Promise<void>;

/** Downloads `url` (authenticated) to `destination`, a local `file://`. */
export type DownloadFile = (url: string, destination: string) => Promise<void>;

/** Opens the system share sheet on a LOCAL file. */
export type ShareFile = (localFile: string, type: string | null) => Promise<void>;

/** Last-resort name, when the message offers no usable one. */
const FALLBACK_NAME = 'fichier';

/** Last-resort subfolder, when the URL carries no identifier. */
const FALLBACK_KEY = 'divers';

/**
 * Characters a file name must not carry: controls, and those that file systems
 * (or receiving apps) treat specially.
 *
 * This departs from the `[A-Za-z0-9._-]` prescribed by the audit, which would
 * have turned `résumé-2026.pdf` into `r_sum_-2026.pdf` before the user's eyes.
 * What must be guaranteed is narrower: that the name cannot escape the
 * destination folder. Separators are removed upstream (only the last segment
 * is kept), leading and trailing dots too, so no `.`, no `..`, no path. The
 * other letters may live.
 */
const HOSTILE =/[\u0000-\u001f\u007f\\/:*?"<>|]/g;

/** Max file name length, under the ext4 limit (255 bytes). */
const MAX_NAME = 120;

function cap(name: string): string {
  if (name.length <= MAX_NAME) return name;
  const dot = name.lastIndexOf('.');
  // Extension kept only if it looks like one: it decides which app will open.
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  return name.slice(0, MAX_NAME - ext.length) + ext;
}

/** Non-empty segments of a URL's PATH (query and fragment removed). */
function segments(url: string): string[] {
  const path = url.split(/[?#]/)[0] ?? '';
  return path.split('/').filter((s) => s !== '' && s !== '.');
}

function decoder(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // A lone `%` in the name: keep the raw form rather than nothing.
    return s;
  }
}

/**
 * Safe destination name from a name proposed by someone else (the message
 * `title`, or the URL's last segment). Can never designate anything but a file
 * of the destination folder.
 */
export function safeFileName(proposed: string | null | undefined): string {
  const raw = typeof proposed === 'string' ? proposed : '';
  // `../../evil.sh` → `evil.sh`: only the last segment is kept, which defuses
  // directory traversal before sanitising even starts.
  const parts = raw.split(/[/\\]/).filter((s) => s !== '');
  const last = parts.length > 0 ? parts[parts.length - 1]! : '';
  const clean = last.replace(HOSTILE, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  return clean === '' ? FALLBACK_NAME : cap(clean);
}

/**
 * The server-side file id, extracted from the URL (`/file-upload/<_id>/<name>`),
 * used as the cache SUBFOLDER.
 *
 * Without it, two attachments named `invoice.pdf` would overwrite each other in
 * the cache, and a share started on one could present the other. The
 * Rocket.Chat `_id` is immutable, so the folder is stable from one opening to
 * the next.
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
 * Completes a name without an extension from the MIME. The extension decides
 * which app opens the file, and where the gallery files it: a bare `photo`
 * would be filed there as some generic image.
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
 * Photo, video or audio: the gallery (MediaStore) knows where to file them.
 * Everything else (PDF, archive…) goes to a folder the user picks.
 */
export function toGallery(name: string, type: string | null | undefined): boolean {
  if (typeof type === 'string' && /^(image|video|audio)\//i.test(type)) return true;
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return name.includes('.') && EXTENSIONS_MEDIA.has(ext);
}

/**
 * Downloads the attachment into the cache and returns its local path.
 *
 * `url` carries the token and NEVER leaves this function: it is only passed to
 * `download`, whose implementation makes an in-process HTTP request.
 */
export async function downloadAttachment(options: {
  /** Protected URL, token included. */
  url: string;
  /** The message `title`: proposed by someone else, so sanitised. */
  title: string | null | undefined;
  /** Announced MIME: completes the extension when the name has none. */
  type: string | null | undefined;
  /** The app's cache folder (`file:///…/cache/`). */
  folder: string;
  createFolder: CreateFolder;
  download: DownloadFile;
}): Promise<string> {
  const { url, title, type, folder, createFolder, download } = options;

  const root = folder.endsWith('/') ? folder : `${folder}/`;
  const subFolder = `${root}jointes/${fileKey(url)}/`;
  // The `title` first (it is what the user sees in the conversation), the URL's
  // last segment as fallback, decoded, otherwise `my%20report.pdf` would be
  // written with its `%20`.
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
 * Downloads the attachment and opens the share sheet on it. Returns the local
 * path; `share` only receives that, never the URL.
 */
export async function openAttachment(options: {
  url: string;
  title: string | null | undefined;
  /** Announced MIME, passed as is to the share sheet. */
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
  /** Path (relative to the server) of the ORIGINAL, without a token. */
  path: string;
  title: string | null;
  type: string | null;
  /** Size announced by the message, in bytes: progress is measured against it when the server withholds its own. */
  size: number | null;
  /** File of an encrypted room: its key, to decrypt it. */
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
 * The message's first attachment that can be shared as a FILE: `title_link`
 * first, which designates the original where `image_url` is only the
 * thumbnail. Quotes are skipped: what is shared is what the message carries.
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
 * Downloaded fraction. The file server does not always answer with its size
 * (`chunked` response): the size announced by the message is used instead,
 * capped at 1. `null` if nothing at all is known.
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
 * The name to upload a local file under, when its URI's name is not its own.
 * `expo-file-system`'s multipart takes the file name on disk, and the server
 * keeps it as is: a cache copy (picker, downscale) would leave under a random
 * name. `null`: the URI already carries the right one.
 */
export function uploadName(uri: string, name: string): string | null {
  const wanted = safeFileName(name);
  const current = decoder(uri.split(/[?#]/)[0]!.split('/').pop() ?? '');
  return current === wanted ? null : wanted;
}
