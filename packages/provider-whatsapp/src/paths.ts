/**
 * Where a WhatsApp account's pictures live on the phone, as plain local
 * files: the engine downloads and decrypts attachments into its own folder
 * (`file://` paths it answers), and the app writes the profile photos the
 * engine sends inline. Pure module: the folder is set by `ui/sync.tsx`.
 */

let folder: string | null = null;

/** The app's cache folder (`file:///…/`), where profile photos are written. */
export function setWhatsAppCache(cache: string | null): void {
  folder = cache;
}

/** A photo's version: a short digest of its bytes (FNV-1a over the base64), `none` when removed. */
export function photoVersion(data: string): string {
  if (data === '') return 'none';
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}${data.length.toString(16)}`;
}

const safe = (jid: string) => jid.replace(/[^A-Za-z0-9]/g, '_');

/** The account's state, from `whatsapp://<state>`. */
const stateOf = (baseUrl: string) => /^whatsapp:\/\/([0-9a-f]{24})$/.exec(baseUrl)?.[1] ?? null;

/** The folder of an account's photos. */
export function photoFolder(baseUrl: string): string | null {
  const state = stateOf(baseUrl);
  return folder !== null && state !== null ? `${folder}whatsapp/${state}/photos/` : null;
}

/** The file of a JID's photo at a version; null when there is none (or no version). */
export function photoUri(baseUrl: string, jid: string | null | undefined, version: string | null | undefined): string | null {
  const dir = photoFolder(baseUrl);
  if (dir === null || !jid || !version || version === 'none') return null;
  return `${dir}${safe(jid)}-${version}.jpg`;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A message id as the file path segment `/api/v1/files/<id>` accepts (`[A-Za-z0-9_-]`): base64url of its bytes. */
export function fileKey(messageId: string): string {
  const bytes = new TextEncoder().encode(messageId);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.ceil(((Math.min(3, bytes.length - i)) * 8) / 6);
    for (let j = 0; j < chars; j++) out += ALPHABET[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}

/** The message id back from `fileKey`; null for anything else. */
export function messageOfKey(key: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return null;
  const bytes: number[] = [];
  let bits = 0, value = 0;
  for (const ch of key) {
    value = (value << 6) | ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  try {
    // UTF-8 back through percent-decoding: Hermes has no TextDecoder to rely on.
    return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''));
  } catch {
    return null;
  }
}

/** The path an attachment of a message is asked for by, through `lib/nativeFiles.ts`. */
export const filePath = (messageId: string): string => `/api/v1/files/${fileKey(messageId)}`;
