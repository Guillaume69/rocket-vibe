import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { rcIconPath } from './serverIcon.ts';

describe('server icon', () => {
  test('only an asset an administrator set is the server own icon', () => {
    const set = { settings: [{ _id: 'Assets_favicon_192', value: { url: 'assets/favicon_192.png', defaultUrl: 'images/logo/android-chrome-192x192.png' } }] };
    assert.equal(rcIconPath(set), 'assets/favicon_192.png');
    const stock = { settings: [{ _id: 'Assets_favicon_192', value: { defaultUrl: 'images/logo/android-chrome-192x192.png' } }] };
    assert.equal(rcIconPath(stock), null);
    assert.equal(rcIconPath(null), null);
  });
  test('a path leaving the server is refused', () => {
    for (const url of ['https://elsewhere.example/x.png', '/etc/x.png', '../x.png']) {
      assert.equal(rcIconPath({ settings: [{ _id: 'Assets_favicon_192', value: { url } }] }), null, url);
    }
  });
});
