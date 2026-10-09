/**
 * The icon a server shows on the rail instead of its host's initial, read
 * without signing in: Rocket.Chat's `favicon_192` asset when an
 * administrator set one (its stock logo is not the server's own), RocketVibe's
 * instance icon at the discovery's `icon_revision`. Mattermost and kChat keep
 * the initial. Same rule as the desktop's `rv_core::server_icon`.
 *
 * Rocket.Chat serves the asset at a fixed URL with no ETag, which the image
 * cache would freeze: each read gets a fresh `?rv=` (the server ignores it).
 *
 * Pure module apart from `fetch`: tested under Node (`lib/serverIcon.test.ts`).
 */

import type { ProviderKind } from './provider.ts';

/** The Rocket.Chat asset, and the exact side it demands (`error-invalid-file-width` otherwise). */
export const RC_ICON_ASSET = 'favicon_192';
export const RC_ICON_SIDE = 192;

/** `settings.public?_id=Assets_favicon_192`: the asset's path when set; `defaultUrl` alone is the stock logo. */
export function rcIconPath(answer: unknown): string | null {
  const settings = (answer as { settings?: unknown } | null)?.settings;
  if (!Array.isArray(settings)) return null;
  const entry = settings.find((s) => (s as { _id?: unknown })?._id === 'Assets_favicon_192') as
    | { value?: { url?: unknown } }
    | undefined;
  const url = entry?.value?.url;
  if (typeof url !== 'string' || url === '' || url.startsWith('/') || url.includes('..') || url.includes('://')) return null;
  return url;
}

/** The URI of a server's icon, or `null` to keep the initial (none, unreachable, another provider). */
export async function serverIconUri(baseUrl: string, kind: ProviderKind, nonce: string): Promise<string | null> {
  const base = baseUrl.replace(/\/+$/, '');
  try {
    if (kind === 'rocketvibe') {
      const discovery = (await (await fetch(`${base}/.well-known/rocketvibe`)).json()) as { icon_revision?: unknown };
      const revision = discovery.icon_revision;
      return typeof revision === 'string' && revision !== ''
        ? `${base}/api/v1/instance/icon?v=${encodeURIComponent(revision)}`
        : null;
    }
    if (kind !== 'rocketchat') return null;
    const response = await fetch(`${base}/api/v1/settings.public?_id=Assets_favicon_192`);
    const path = rcIconPath(await response.json());
    return path === null ? null : `${base}/${path}?rv=${encodeURIComponent(nonce)}`;
  } catch {
    return null;
  }
}
