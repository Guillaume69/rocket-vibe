/**
 * Parsing of the JSON records kept in SecureStore, with no `expo` dependency
 * so that the leniency towards older shapes is proven by tests.
 */

import type { Session } from './auth.ts';
import type { PendingLogout } from './deferredLogout.ts';
import { normalizeProviderKind } from './provider.ts';
import { withoutTrailingSlash } from './storageKeys.ts';

export function parseSession(raw: string, baseUrl: string): Session | null {
  try {
    const session = JSON.parse(raw) as Session & { genre?: unknown };
    // Corrupt storage or one from an older version must not crash startup:
    // treat it as no session.
    if (typeof session?.authToken !== 'string' || typeof session?.userId !== 'string') return null;
    // The key derives from a truncated digest: we don't trust it alone to
    // assert that this session belongs to the requested server.
    if (withoutTrailingSlash(session.baseUrl) !== withoutTrailingSlash(baseUrl)) return null;
    // Migration on read: sessions older than the `kind` (formerly `genre`) and
    // `siteUrl` fields fall back on their defaults (`rocketchat`, null →
    // `baseUrl` at use), without rewriting.
    return {
      ...session,
      kind: normalizeProviderKind(session.kind ?? session.genre),
      siteUrl: typeof session.siteUrl === 'string' ? session.siteUrl : null,
    };
  } catch {
    return null;
  }
}

export function parsePendingLogouts(raw: string): PendingLogout[] {
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    // Defensive parse, like `readSession`: an entry from an older version or a
    // truncated one must not fail the whole startup.
    return list
      .filter(
        (d): d is PendingLogout & { jetonPush?: unknown } =>
          typeof (d as PendingLogout)?.baseUrl === 'string' &&
          typeof (d as PendingLogout)?.authToken === 'string' &&
          typeof (d as PendingLogout)?.userId === 'string',
      )
      .map(({ jetonPush, ...d }) => ({
        ...d,
        pushToken: typeof d.pushToken === 'string' ? d.pushToken : typeof jetonPush === 'string' ? jetonPush : null,
      }));
  } catch {
    return [];
  }
}
