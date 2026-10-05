/**
 * Shared MIME mappings: THE app's family → emoji table.
 *
 * The audit found two (composer preview, share thumbnails), already diverging
 * on audio: any family added to one was missing from the other. The `audio/`
 * branch is harmless for the composer preview, which routes audio to
 * `AudioPlayer` before asking for an emoji.
 */

/** Emoji by MIME family, for non-image renderings. */
export function fileEmoji(type: string): string {
  if (type.startsWith('video/')) return '🎬';
  if (type.startsWith('audio/')) return '🎵';
  if (type === 'application/pdf') return '📄';
  if (type.startsWith('text/')) return '📃';
  if (type.includes('zip') || type.includes('compressed')) return '🗜️';
  return '📎';
}

/** An image MIME type: rendered as a thumbnail rather than an emoji tile. */
export function isImage(type: string): boolean {
  return type.startsWith('image/');
}

/**
 * The short format of a file ("PNG", "PDF", "M4A"): the name's extension when
 * it has one, otherwise the MIME subtype stripped of its prefixes.
 */
export function shortFormat(name: string, type: string): string | null {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  if (/^[a-z0-9]{1,5}$/i.test(extension)) return extension.toUpperCase();
  const sub = type.split('/')[1]?.split(';')[0]?.split('+')[0] ?? '';
  const last = sub.split('.').pop()?.replace(/^x-/, '') ?? '';
  return last === '' || last === 'octet-stream' ? null : last.toUpperCase();
}
