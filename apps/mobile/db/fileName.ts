/**
 * Nom du fichier SQLite d'un serveur **et d'un compte**. Isolé dans son propre
 * module — sans dépendance à `expo-sqlite` — pour être testé sans le recopier.
 *
 * Il décide de l'isolation : deux serveurs distincts donnent deux bases, et
 * deux comptes du même serveur aussi — salons, aperçus et compteurs de non-lus
 * sont des données *du compte* ; les partager ferait voir à l'un les messages
 * directs de l'autre. Le même serveur écrit avec ou sans schéma, avec ou sans
 * barre finale, donne la même base.
 */
export function databaseFileName(baseUrl: string, userId?: string): string {
  const withoutScheme = baseUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const slug = withoutScheme.replace(/[^a-z0-9]+/gi, '_');
  const suffix =
    userId === undefined ? '' : `-${userId.replace(/[^a-z0-9]+/gi, '_')}`;
  return `rocket-vibe-${slug}${suffix}.db`;
}
