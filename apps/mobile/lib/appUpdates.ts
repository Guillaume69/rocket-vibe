/** GitHub APK discovery. No chat credentials or platform imports. */
export const UPDATE_REPO = 'Guillaume69/rocket-vibe';
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases`;
const MAX_PAGES = 5;
const MAX_APK_BYTES = 512 * 1024 * 1024;

export type UpdateAsset = { url: string; size: number; digest: string };
export type MobileUpdate = {
  version: string;
  page: string;
  asset: UpdateAsset | null;
  unavailable: 'asset' | 'digest' | 'device' | null;
};
export type CachedReleasePage = { etag: string; entries: unknown[] };
export type ReleasePageCache = {
  read(page: number): Promise<CachedReleasePage | null>;
  write(page: number, value: CachedReleasePage): Promise<void>;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function validReleasePage(entries: unknown[]): boolean {
  return entries.every(value => {
    const r = object(value);
    return r !== null && typeof r.tag_name === 'string' && typeof r.draft === 'boolean' &&
      typeof r.prerelease === 'boolean' && Array.isArray(r.assets) &&
      (r.published_at === null && r.draft || typeof r.published_at === 'string' && Number.isFinite(Date.parse(r.published_at)));
  });
}
export function updateVersion(value: string): number[] | null {
  if (!/^\d+\.\d+\.\d+$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
export function newerUpdate(candidate: string, installed: string): boolean {
  const a = updateVersion(candidate), b = updateVersion(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
export function updateCheckDue(last: number, now: number, retryAt = 0): boolean {
  return now >= retryAt && (last <= 0 || now < last || now - last >= UPDATE_INTERVAL_MS);
}

/** Select the newest mobile version first. Never fall back to an older APK. */
export function selectMobileUpdate(entries: unknown[], installed: string, abis: string[]): MobileUpdate | null {
  if (!updateVersion(installed)) throw new Error('Unknown installed version');
  let newest: Record<string, unknown> | null = null;
  let version = installed;
  for (const entry of entries) {
    const item = object(entry);
    if (!item || item.draft !== false || item.prerelease !== false || typeof item.published_at !== 'string' ||
      !Number.isFinite(Date.parse(item.published_at)) || typeof item.tag_name !== 'string') continue;
    const match = /^mobile-v(\d+\.\d+\.\d+)$/.exec(item.tag_name);
    if (match && newerUpdate(match[1]!, version)) { newest = item; version = match[1]!; }
  }
  if (!newest) return null;
  const tag = `mobile-v${version}`;
  const page = `https://github.com/${UPDATE_REPO}/releases/tag/${tag}`;
  const result: MobileUpdate = { version, page, asset: null, unavailable: 'asset' };
  const name = `rocket-vibe-mobile-${version}.apk`;
  const matches = Array.isArray(newest.assets) ? newest.assets.map(object).filter(a => a?.name === name) : [];
  const asset = matches.length === 1 ? matches[0] : null;
  const url = `https://github.com/${UPDATE_REPO}/releases/download/${tag}/${name}`;
  if (!asset || asset.state !== 'uploaded' || asset.browser_download_url !== url ||
    typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_APK_BYTES) return result;
  result.unavailable = 'digest';
  if (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) return result;
  if (!abis.includes('arm64-v8a')) { result.unavailable = 'device'; return result; }
  result.asset = { url, size: asset.size, digest: asset.digest.slice(7).toLowerCase() };
  result.unavailable = null;
  return result;
}

/** Recover only a newer offer with the same validation as a fresh API result. */
export function restoreMobileUpdate(value: unknown, installed: string, abis: string[]): MobileUpdate | null {
  const saved = object(value);
  if (!saved || typeof saved.version !== 'string' || !newerUpdate(saved.version, installed)) return null;
  const asset = object(saved.asset);
  const result = selectMobileUpdate([{ tag_name: `mobile-v${saved.version}`, draft: false, prerelease: false,
    published_at: '2000-01-01T00:00:00Z', assets: asset ? [{ name: `rocket-vibe-mobile-${saved.version}.apk`,
      state: 'uploaded', browser_download_url: asset.url, size: asset.size, digest: `sha256:${String(asset.digest)}` }] : [] }], installed, abis);
  if (result && !asset && ['asset', 'digest', 'device'].includes(String(saved.unavailable))) {
    result.unavailable = saved.unavailable as 'asset' | 'digest' | 'device';
  }
  return result;
}
export class UpdateCheckError extends Error {
  readonly retryAt: number;
  constructor(message: string, retryAt: number) { super(message); this.retryAt = retryAt; }
}

/** Public API only. All pages must succeed before a check can say Up to date. */
export async function fetchMobileReleases(
  fetcher: typeof fetch,
  cache: ReleasePageCache,
  now = Date.now(),
): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const stored = await cache.read(page).catch(() => null);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'RocketVibe-Android-Updater',
    };
    if (stored?.etag) headers['If-None-Match'] = stored.etag;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let entries: unknown[];
    try {
      const response = await fetcher(`${RELEASES_URL}?per_page=100&page=${page}`, { headers, signal: controller.signal });
      if (response.status === 304) {
        if (!stored?.etag || !Array.isArray(stored.entries) || !validReleasePage(stored.entries)) throw new Error('Missing cached release page');
        entries = stored.entries;
      } else {
        if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
          const seconds = Number(response.headers.get('retry-after'));
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
          throw new UpdateCheckError('GitHub rate limit', Math.max(now + 60000,
            Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : 0,
            Number.isFinite(reset) ? reset : 0));
        }
        if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
        const body = await response.text();
        if (body.length > 4 * 1024 * 1024) throw new Error('Release page too large');
        const value: unknown = JSON.parse(body);
        if (!Array.isArray(value) || value.length > 100 || !validReleasePage(value)) throw new Error('Invalid release list');
        entries = value;
        // Avoid persisting release notes or unrelated GitHub profile data.
        const compact = entries.map(value => {
          const r = object(value);
          return r ? { tag_name: r.tag_name, draft: r.draft, prerelease: r.prerelease,
            published_at: r.published_at, assets: Array.isArray(r.assets) ? r.assets.map(value => {
              const a = object(value);
              return a ? { name: a.name, state: a.state, browser_download_url: a.browser_download_url,
                size: a.size, digest: a.digest } : null;
            }) : [] } : null;
        });
        await cache.write(page, { etag: response.headers.get('etag') ?? '', entries: compact }).catch(() => {});
      }
    } catch (error) {
      if (error instanceof UpdateCheckError) throw error;
      throw new UpdateCheckError(error instanceof Error ? error.message : 'Update check failed', now + 5 * 60000);
    } finally { clearTimeout(timeout); }
    all.push(...entries);
    if (entries.length < 100) return all;
  }
  throw new UpdateCheckError('Release pagination incomplete', now + UPDATE_INTERVAL_MS);
}
