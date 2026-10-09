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

describe('server icon reads', () => {
  test('one read per server and session, a failure concludes nothing, a change asks again', async () => {
    const { serverIconUri, forgetServerIcon } = await import('./serverIcon.ts');
    const real = globalThis.fetch;
    let calls = 0;
    let answer: () => Response = () => new Response(JSON.stringify({ icon_revision: '3' }));
    globalThis.fetch = (async () => {
      calls++;
      return answer();
    }) as typeof fetch;
    try {
      const base = 'https://rv.example';
      assert.equal(await serverIconUri(base, 'rocketvibe'), 'https://rv.example/api/v1/instance/icon?v=3');
      assert.equal(await serverIconUri(base + '/', 'rocketvibe'), 'https://rv.example/api/v1/instance/icon?v=3');
      assert.equal(calls, 1);
      assert.equal(await serverIconUri('https://mm.example', 'mattermost'), null);
      answer = () => new Response('busy', { status: 503 });
      assert.equal(await serverIconUri('https://other.example', 'rocketchat'), undefined);
      forgetServerIcon(base);
      answer = () => new Response(JSON.stringify({}));
      assert.equal(await serverIconUri(base, 'rocketvibe'), null);
    } finally {
      globalThis.fetch = real;
    }
  });
});
