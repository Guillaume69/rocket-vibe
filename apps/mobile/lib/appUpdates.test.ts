import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchMobileReleases, newerUpdate, restoreMobileUpdate, selectMobileUpdate, updateCheckDue, UPDATE_INTERVAL_MS,
  UpdateCheckError, type CachedReleasePage, type ReleasePageCache } from './appUpdates.ts';

const digest = 'a'.repeat(64);
function release(version: string, changes: Record<string, unknown> = {}) {
  return { tag_name: `mobile-v${version}`, draft: false, prerelease: false, published_at: '2026-10-10T12:00:00Z',
    assets: [{ name: `rocket-vibe-mobile-${version}.apk`, state: 'uploaded', size: 100,
      browser_download_url: `https://github.com/Guillaume69/rocket-vibe/releases/download/mobile-v${version}/rocket-vibe-mobile-${version}.apk`, digest: `sha256:${digest}` }], ...changes };
}
function cache() {
  const pages = new Map<number, CachedReleasePage>();
  const store: ReleasePageCache = { read: async p => pages.get(p) ?? null, write: async (p, v) => { pages.set(p, v); } };
  return { pages, store };
}
test('numeric versions, app tags and unpublished versions cannot cause false updates', () => {
  assert.ok(newerUpdate('0.10.0', '0.9.9'));
  assert.ok(!newerUpdate('0.9.1', '0.10.0'));
  const entries = [release('0.10.0'), release('0.9.9'), release('99.0.0', { draft: true }),
    release('98.0.0', { prerelease: true }), release('97.0.0', { published_at: null }),
    release('1.0.0-rc1'), release('50.0.0', { tag_name: 'desktop-v50.0.0' }), null];
  assert.equal(selectMobileUpdate(entries, '0.9.0', ['arm64-v8a'])?.version, '0.10.0');
  assert.equal(selectMobileUpdate(entries, '0.10.0', ['arm64-v8a']), null);
});
test('newest incomplete release never silently offers an older APK', () => {
  const result = selectMobileUpdate([release('0.10.0', { assets: [] }), release('0.9.9')], '0.9.0', ['arm64-v8a']);
  assert.equal(result?.version, '0.10.0');
  assert.equal(result?.unavailable, 'asset');
});
test('exact trusted asset URL, digest, size, uploaded state and unique name required', () => {
  const item = release('0.10.0'), original = item.assets[0]!;
  for (const change of [{ browser_download_url: 'https://evil.test/update.apk' }, { size: 0 },
    { size: 1.5 }, { state: 'new' }, { name: 'wrong.apk' }, { digest: null }, { digest: 'sha256:bad' }]) {
    assert.equal(selectMobileUpdate([{ ...item, assets: [{ ...original, ...change }] }], '0.9.0', ['arm64-v8a'])?.asset, null);
  }
  assert.equal(selectMobileUpdate([{ ...item, assets: [original, original] }], '0.9.0', ['arm64-v8a'])?.asset, null);
  assert.equal(selectMobileUpdate([item], '0.9.0', ['x86_64'])?.unavailable, 'device');
  assert.equal(selectMobileUpdate([item], '0.9.0', ['arm64-v8a'])?.asset?.digest, digest);
});
test('check interval, clock rollback and backoff', () => {
  assert.ok(updateCheckDue(0, 100));
  assert.ok(!updateCheckDue(100, 101));
  assert.ok(updateCheckDue(100, 100 + UPDATE_INTERVAL_MS));
  assert.ok(updateCheckDue(100, 99));
  assert.ok(!updateCheckDue(0, 100, 200));
});
test('checks across pages and reuses only matching ETag cached responses', async () => {
  const { store, pages } = cache();
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requested.push(String(input));
    assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
    return new Response(JSON.stringify(requested.length === 1 ? Array(100).fill(release('1.0.0', { tag_name: 'web-v1.0.0' })) : [release('0.10.0')]),
      { headers: { etag: `page-${requested.length}` } });
  };
  const found = await fetchMobileReleases(fetcher, store);
  assert.equal(found.length, 101);
  assert.equal(requested.length, 2);
  assert.equal(pages.get(2)?.etag, 'page-2');
  const cached = await fetchMobileReleases(async (_url, init) => {
    assert.ok((init?.headers as Record<string, string>)['If-None-Match']);
    return new Response(null, { status: 304 });
  }, store);
  assert.equal(selectMobileUpdate(cached, '0.9.0', ['arm64-v8a'])?.version, '0.10.0');
});
test('missing cache, malformed API, partial pagination and API failures never mean up to date', async () => {
  const cases: (typeof fetch)[] = [async () => new Response(null, { status: 304 }),
    async () => new Response('{}'), async () => new Response('[{}]'), async () => new Response('[null]'), async () => new Response('bad'),
    async () => new Response(null, { status: 500 }), async () => { throw new Error('offline'); },
    async () => new Response(JSON.stringify(Array(100).fill(release('0.10.0'))))];
  for (const f of cases) await assert.rejects(fetchMobileReleases(f, cache().store, 100), UpdateCheckError);
});
test('rate limits retain a retry time and abort signal is supplied', async () => {
  await assert.rejects(fetchMobileReleases(async (_url, init) => {
    assert.ok(init?.signal);
    return new Response(null, { status: 429, headers: { 'retry-after': '120', 'x-ratelimit-reset': '1000' } });
  }, cache().store, 100), error => error instanceof UpdateCheckError && error.retryAt === 1000000);
});

test('restart restores a safe newer offer, rejects downgrades and does not trust persisted URLs', () => {
  const offer = selectMobileUpdate([release('0.10.0')], '0.9.0', ['arm64-v8a']);
  assert.deepEqual(restoreMobileUpdate(offer, '0.9.0', ['arm64-v8a']), offer);
  assert.equal(restoreMobileUpdate(offer, '0.10.0', ['arm64-v8a']), null);
  assert.equal(restoreMobileUpdate(null, '0.9.0', ['arm64-v8a']), null);
  assert.equal(restoreMobileUpdate({ ...offer, asset: { ...offer?.asset, url: 'https://evil.test/update.apk' } }, '0.9.0', ['arm64-v8a'])?.asset, null);
  assert.equal(restoreMobileUpdate(offer, '0.9.0', ['x86_64'])?.unavailable, 'device');
});