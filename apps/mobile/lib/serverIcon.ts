/**
 * The icon a server shows on the rail instead of its host's initial, read
 * without signing in: Rocket.Chat's `favicon_192` asset when an
 * administrator set one (its stock logo is not the server's own), RocketVibe's
 * instance icon at the discovery's `icon_revision`. Mattermost and kChat keep
 * the initial. Same rule as the desktop's `rv_core::server_icon`.
 *
 * Read once per server and app session (each rail visit would otherwise cost
 * an anonymous `settings.public`, rate limited per address), again after an
 * administrator changed it here (`forgetServerIcon`). Rocket.Chat serves the
 * asset at a fixed URL with no ETag, which the image cache would freeze: the
 * URI carries the time of that read (`?rv=`, which the server ignores).
 *
 * Pure module apart from `fetch`: tested under Node (`lib/serverIcon.test.ts`).
 */

import type { ProviderKind } from './provider.ts';

/** The Rocket.Chat asset, and the exact side it demands (`error-invalid-file-width` otherwise). */
export const RC_ICON_ASSET = 'favicon_192';
export const RC_ICON_SIDE = 192;
/** A server that does not answer within this does not hold up the others. */
const TIMEOUT_MS = 10_000;

/** `settings.public?_id=Assets_favicon_192`: the asset's path when set; `defaultUrl` alone is the stock logo. */
export function rcIconPath(answer: unknown): string | null {
  const settings = (answer as { settings?: unknown } | null)?.settings;
  if (!Array.isArray(settings)) return null;
  const entry = settings.find((s) => (s as { _id?: unknown })?._id === 'Assets_favicon_192') as
    | { value?: { url?: unknown } }
    | undefined;
  const url = entry?.value?.url;
  if (
    typeof url !== 'string' ||
    url === '' ||
    url.startsWith('/') ||
    url.includes('..') ||
    url.includes('%') ||
    url.includes('://')
  ) {
    return null;
  }
  return url;
}

/** By base URL: the icon's URI, or `null` for none, as last read this session. */
const known = new Map<string, string | null>();

/** After an administrator changed it here: the next read asks the server again. */
export function forgetServerIcon(baseUrl: string): void {
  known.delete(baseUrl.replace(/\/+$/, ''));
}

async function json(url: string): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The URI of a server's icon, `null` to show the initial (none, another
 * provider), or `undefined` when the read concluded nothing (unreachable,
 * refused): the caller keeps what it shows.
 */
export async function serverIconUri(baseUrl: string, kind: ProviderKind): Promise<string | null | undefined> {
  const base = baseUrl.replace(/\/+$/, '');
  if (kind !== 'rocketvibe' && kind !== 'rocketchat') return null;
  if (known.has(base)) return known.get(base);
  let uri: string | null;
  try {
    if (kind === 'rocketvibe') {
      const revision = ((await json(`${base}/.well-known/rocketvibe`)) as { icon_revision?: unknown }).icon_revision;
      uri = typeof revision === 'string' && revision !== '' ? `${base}/api/v1/instance/icon?v=${encodeURIComponent(revision)}` : null;
    } else {
      const answer = await json(`${base}/api/v1/settings.public?_id=Assets_favicon_192`);
      if (!Array.isArray((answer as { settings?: unknown } | null)?.settings)) return undefined;
      const path = rcIconPath(answer);
      uri = path === null ? null : `${base}/${path}?rv=${Date.now()}`;
    }
  } catch {
    return undefined;
  }
  known.set(base, uri);
  return uri;
}
