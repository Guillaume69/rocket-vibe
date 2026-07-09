/**
 * Nom du fichier SQLite d'un serveur. Isolé dans son propre module — sans
 * dépendance à `expo-sqlite` — pour être testé sans le recopier.
 *
 * Il décide de l'isolation multi-serveurs : deux serveurs distincts doivent
 * donner deux bases distinctes, et le même serveur écrit avec ou sans schéma,
 * avec ou sans barre finale, doit donner la même.
 */
export function nomFichier(baseUrl: string): string {
  const sansSchema = baseUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `rocket-vibe-${sansSchema.replace(/[^a-z0-9]+/gi, '_')}.db`;
}
