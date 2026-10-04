/**
 * SQLite file name for a server **and an account**. Isolated in its own
 * module, with no dependency on `expo-sqlite`, so it can be tested without
 * copying it.
 *
 * It decides isolation: two distinct servers give two databases, and so do
 * two accounts on the same server; rooms, previews and unread counts are
 * *account* data, sharing them would show one the other's direct messages.
 * The same server written with or without scheme, with or without trailing
 * slash, gives the same database.
 */
export function databaseFileName(baseUrl: string, userId?: string): string {
  const withoutScheme = baseUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const slug = withoutScheme.replace(/[^a-z0-9]+/gi, '_');
  const suffix =
    userId === undefined ? '' : `-${userId.replace(/[^a-z0-9]+/gi, '_')}`;
  return `rocket-vibe-${slug}${suffix}.db`;
}
