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
import { createHash } from 'crypto';

export function databaseIdentity(baseUrl: string, userId?: string): string {
  return JSON.stringify([baseUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, ''), userId ?? null]);
}

export function databaseFileName(baseUrl: string, userId?: string): string {
  return `rocket-vibe-v2-${createHash('sha256').update(databaseIdentity(baseUrl, userId)).digest('hex')}.db`;
}

/** The old lossy name is used only for the guarded one-time upgrade. */
export function legacyDatabaseFileName(baseUrl: string, userId?: string): string {
  const withoutScheme = baseUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const slug = withoutScheme.replace(/[^a-z0-9]+/gi, '_');
  const suffix =
    userId === undefined ? '' : `-${userId.replace(/[^a-z0-9]+/gi, '_')}`;
  return `rocket-vibe-${slug}${suffix}.db`;
}

/** An already claimed file stays with its owner; colliding saved accounts
 * cannot claim an unidentified old cache. The old file is kept for recovery. */
export function canAdoptLegacy(owner: string | null, expected: string, candidates: readonly string[]): boolean {
  return owner === null ? candidates.every(candidate => candidate === expected) : owner === expected;
}
