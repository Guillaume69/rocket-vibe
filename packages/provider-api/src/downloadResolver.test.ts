import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clearDownloadResolver, downloadResolverFor, setDownloadResolver } from './downloadResolver.ts';

test('a download resolver is registered, found and cleared per account', async () => {
  const origin = 'https://teams.microsoft.com';
  assert.equal(downloadResolverFor(origin), undefined);
  setDownloadResolver(origin, async (url) => `${url}?resolved`);
  const resolve = downloadResolverFor(origin);
  assert.ok(resolve);
  assert.equal(await resolve!('https://x/y'), 'https://x/y?resolved');
  clearDownloadResolver(origin);
  assert.equal(downloadResolverFor(origin), undefined);
});
