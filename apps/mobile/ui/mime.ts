/**
 * Correspondances MIME partagées — LA table famille → emoji de l'app.
 *
 * L'audit en avait relevé deux (aperçu du composer, vignettes du partage),
 * déjà divergentes sur le cas audio : toute famille ajoutée à l'une manquait à
 * l'autre. La branche `audio/` est inoffensive pour l'aperçu du composer, qui
 * détourne l'audio vers `LecteurAudio` avant de demander un emoji.
 */

/** Émoji d'après la famille MIME, pour les rendus non-image. */
export function fileEmoji(type: string): string {
  if (type.startsWith('video/')) return '🎬';
  if (type.startsWith('audio/')) return '🎵';
  if (type === 'application/pdf') return '📄';
  if (type.startsWith('text/')) return '📃';
  if (type.includes('zip') || type.includes('compressed')) return '🗜️';
  return '📎';
}

/** Un type MIME d'image — rendu en vignette plutôt qu'en tuile à emoji. */
export function isImage(type: string): boolean {
  return type.startsWith('image/');
}

/**
 * Le format court d'une pièce (« PNG », « PDF », « M4A ») : l'extension du nom
 * quand il en a une, sinon le sous-type MIME débarrassé de ses préfixes.
 */
export function shortFormat(name: string, type: string): string | null {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  if (/^[a-z0-9]{1,5}$/i.test(extension)) return extension.toUpperCase();
  const sub = type.split('/')[1]?.split(';')[0]?.split('+')[0] ?? '';
  const last = sub.split('.').pop()?.replace(/^x-/, '') ?? '';
  return last === '' || last === 'octet-stream' ? null : last.toUpperCase();
}
