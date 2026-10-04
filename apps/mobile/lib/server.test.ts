/**
 * Tests of `lib/server.ts`, the only module the login screen goes through
 * before showing anything, so the only one whose failure reads as "the app
 * does not start".
 *
 * `fetch` is injected (same seam as `ClientRest`) and timers are mocked: the
 * 15 s timeout is exercised without waiting 15 s.
 */
import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { RestError } from './rest.ts';
import { ServerError, normalizeUrl, probeServer } from './server.ts';

const SETTINGS = {
  settings: [
    { _id: 'Site_Url', value: 'https://chat.exemple.fr/' },
    { _id: 'Accounts_ShowFormLogin', value: true },
    { _id: 'Accounts_TwoFactorAuthentication_Enabled', value: true },
    { _id: 'Accounts_TwoFactorAuthentication_By_TOTP_Enabled', value: true },
    { _id: 'Accounts_TwoFactorAuthentication_By_Email_Enabled', value: false },
    { _id: 'LDAP_Enable', value: false },
    { _id: 'Accounts_OAuth_Github', value: true },
    { _id: 'Accounts_OAuth_Gitlab', value: false },
    { _id: 'E2E_Enable', value: true },
    { _id: 'FileUpload_ProtectFiles', value: true },
    { _id: 'Accounts_AvatarBlockUnauthenticatedAccess', value: true },
    { _id: 'Sans_valeur', value: null },
  ],
  success: true,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Answers according to the requested URL, and records the URLs actually built
 * and the abort signal each request received (key: pathname).
 */
function transport(responses: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const urls: string[] = [];
  const signals = new Map<string, AbortSignal | null>();
  return {
    urls,
    signals,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      urls.push(u);
      signals.set(new URL(u).pathname, init?.signal ?? null);
      return responses(u, init);
    }) as unknown as typeof globalThis.fetch,
  };
}

/** A request that NEVER answers on its own, except to reject on abort. */
function hangingResponse(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const e = new Error('The operation was aborted.');
      e.name = 'AbortError';
      reject(e);
    });
  });
}

describe('normalizeUrl', () => {
  test('without a scheme, https is assumed', () => {
    assert.equal(normalizeUrl('chat.exemple.fr'), 'https://chat.exemple.fr');
  });

  test('the SUB-PATH is kept: a Rocket.Chat behind a proxy lives under /chat', () => {
    // `new URL(...).origin` would drop it, and every request would target the
    // proxy root: 404 everywhere, with no hint.
    assert.equal(normalizeUrl('https://exemple.fr/chat/'), 'https://exemple.fr/chat');
    assert.equal(normalizeUrl('https://exemple.fr/chat///'), 'https://exemple.fr/chat');
  });

  test('explicit http and port are respected', () => {
    assert.equal(normalizeUrl('http://192.168.1.106:3000'), 'http://192.168.1.106:3000');
  });

  test('surrounding spaces are ignored', () => {
    assert.equal(normalizeUrl('  chat.exemple.fr  '), 'https://chat.exemple.fr');
  });

  test('query and fragment are not part of a server address', () => {
    // A URL pasted from the browser often carries `?msg=...`: keeping it would
    // hit `settings.public` with stray parameters.
    assert.equal(normalizeUrl('https://exemple.fr/chat?x=1#y'), 'https://exemple.fr/chat');
  });

  test('the host is lowercased, a port without a scheme survives', () => {
    assert.equal(normalizeUrl('HTTPS://Chat.Exemple.fr'), 'https://chat.exemple.fr');
    assert.equal(normalizeUrl('chat.exemple.fr:8443'), 'https://chat.exemple.fr:8443');
  });

  test('empty and invalid throw ServerError, not a raw TypeError', () => {
    // NB: relies on a `URL` that THROWS on invalid input, true under Node and
    // in the app (Expo's Winter runtime, standard-compliant), false for RN's old
    // regex polyfill, the trap recorded for `lib/origin.ts`.
    assert.throws(() => normalizeUrl(''), ServerError);
    assert.throws(() => normalizeUrl('   '), ServerError);
    assert.throws(() => normalizeUrl('https://'), ServerError);
    assert.throws(() => normalizeUrl('chat exemple.fr'), ServerError);
  });
});

describe('probeServer', () => {
  test('/api/info is requested at the ROOT, settings.public under /api/v1/', async () => {
    // The regression `outsideApiV1` could introduce: `/api/v1/api/info`, which
    // answers 404, so "server unreachable" on a healthy server.
    const t = transport((u) =>
      u.endsWith('/api/info') ? json({ version: '8.5', success: true }) : json(SETTINGS),
    );
    const profile = await probeServer('https://chat.exemple.fr', undefined, t);

    assert.equal(profile.version, '8.5');
    assert.ok(
      t.urls.includes('https://chat.exemple.fr/api/info'),
      `URL attendue absente : ${t.urls.join(' ')}`,
    );
    assert.ok(t.urls.some((u) => u.startsWith('https://chat.exemple.fr/api/v1/settings.public?')));
  });

  test('the proxy sub-path is carried by BOTH calls', async () => {
    const t = transport((u) =>
      u.endsWith('/api/info') ? json({ version: '8.5' }) : json(SETTINGS),
    );
    // RAW input: the probe must target the normalized URL, and `baseUrl` must
    // return it; the caller builds its client on it, not on its own
    // re-normalization of the input.
    const p = await probeServer('exemple.fr/chat/', undefined, t);
    assert.equal(p.baseUrl, 'https://exemple.fr/chat');
    assert.ok(t.urls.every((u) => u.startsWith('https://exemple.fr/chat/')), t.urls.join(' '));
  });

  test('the profile is taken from the public settings', async () => {
    const t = transport((u) =>
      u.endsWith('/api/info') ? json({ version: '8.5' }) : json(SETTINGS),
    );
    const p = await probeServer('https://chat.exemple.fr', undefined, t);

    assert.equal(p.baseUrl, 'https://chat.exemple.fr');
    assert.equal(p.siteUrl, 'https://chat.exemple.fr/');
    assert.equal(p.loginForm, true);
    assert.deepEqual(p.twoFactor, { active: true, totp: true, email: false });
    assert.equal(p.ldap, false);
    assert.deepEqual(p.oauth, ['Github'], 'only providers set to true');
    assert.equal(p.e2eeEnabled, true);
    assert.equal(p.filesProtected, true);
    assert.equal(p.avatarsProtected, true);
  });

  test('an absent setting is false, never undefined', async () => {
    const t = transport((u) =>
      u.endsWith('/api/info') ? json({ version: '8.5' }) : json({ settings: [], success: true }),
    );
    const p = await probeServer('https://x', undefined, t);
    assert.equal(p.e2eeEnabled, false);
    assert.equal(p.siteUrl, null);
    assert.deepEqual(p.oauth, []);
  });

  test('an /api/info response without a version: "does not look like Rocket.Chat"', async () => {
    const t = transport((u) =>
      u.endsWith('/api/info') ? json({ hello: 'world' }) : json(SETTINGS),
    );
    await assert.rejects(probeServer('https://x', undefined, t), (e: unknown) => {
      assert.ok(e instanceof ServerError);
      assert.match(e.message, /does not look like/);
      return true;
    });
  });

  test('HTML with a 200 on /api/info becomes a readable error', async () => {
    // A captive portal readily answers a login page with a 200.
    const t = transport((u) =>
      u.endsWith('/api/info')
        ? new Response('<html>Connectez-vous au Wi-Fi</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
        : json(SETTINGS),
    );
    await assert.rejects(probeServer('https://x', undefined, t), (e: unknown) => {
      assert.ok(e instanceof ServerError);
      assert.match(e.message, /non-JSON/);
      assert.ok(e.origin instanceof RestError, 'the cause is kept');
      return true;
    });
  });

  test('settings.public 404 surfaces a ServerError, not a crash', async () => {
    const t = transport((u) =>
      u.endsWith('/api/info') ? json({ version: '8.5' }) : json({ success: false }, 404),
    );
    await assert.rejects(probeServer('https://x', undefined, t), ServerError);
  });

  test('settings.public 200 WITHOUT a `settings` array -> ServerError', async () => {
    // A proxy answering JSON to everything must not produce a profile where
    // every setting is silently "false".
    const t = transport((u) =>
      u.endsWith('/api/info') ? json({ version: '8.5' }) : json({ success: true }),
    );
    await assert.rejects(
      probeServer('https://x', undefined, t),
      (e: unknown) => e instanceof ServerError && /array/.test(e.message),
    );
  });

  test('dead network -> "unreachable" ServerError, and the SIBLING request is aborted', async () => {
    // The `controller.abort()` in the catch of `probeServer`: without it, the
    // hanging request lingers until its 15 s timeout, a connection open for
    // nothing, and a server probed again right away gets two.
    const t = transport((u, init) =>
      u.endsWith('/api/info')
        ? hangingResponse(init)
        : Promise.reject(new TypeError('Network request failed')),
    );
    await assert.rejects(probeServer('https://x', undefined, t), (e: unknown) => {
      assert.ok(e instanceof ServerError);
      assert.match(e.message, /unreachable/);
      return true;
    });
    assert.equal(t.signals.get('/api/info')?.aborted, true, 'the sibling must be aborted');
  });

  test('an IN-FLIGHT abort cuts both requests and comes out as AbortError', async () => {
    // The user fixes their input during the probe: not a failure, the screen
    // must not show "server unreachable".
    const t = transport((_u, init) => hangingResponse(init));
    const controller = new AbortController();
    const probing = probeServer('https://x', controller.signal, t);
    controller.abort();
    await assert.rejects(probing, (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, 'AbortError');
      assert.ok(!(e instanceof ServerError));
      return true;
    });
    assert.equal(t.signals.get('/api/info')?.aborted, true);
    assert.equal(t.signals.get('/api/v1/settings.public')?.aborted, true);
  });

  test('a signal already aborted by the caller comes out as AbortError, with no request sent', async () => {
    const t = transport(() => json({ version: '8.5' }));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(probeServer('https://x', controller.signal, t), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, 'AbortError');
      return true;
    });
    assert.deepEqual(t.urls, []);
  });

  test('an invalid address fails BEFORE any request', async () => {
    const t = transport(() => json({ version: '8.5' }));
    await assert.rejects(probeServer('', undefined, t), ServerError);
    assert.deepEqual(t.urls, []);
  });

  test('a HANGING /api/info no longer blocks the login screen forever', async () => {
    // THE bug of workstream 8. `/api/info` went out on a bare `fetch`, with no
    // maximum timeout: if `settings.public` succeeded and `/api/info` stayed
    // hanging (reverse proxy, captive portal), the `Promise.all` of
    // `probeServer` hung forever. The `finally` of app/login.tsx never ran,
    // its `inFlight` guard stayed armed, and a second tap bounced off it
    // WITHOUT ever reaching `abort()`: screen dead and silent until the app
    // restarted.
    //
    // Mocked timers: this exercises the 15 s timeout of `ClientRest`, not the
    // test suite's patience.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      // This `fetch` NEVER answers on its own: it rejects only when its signal
      // fires, exactly like the real one. So the only thing that can unblock
      // it is the `ClientRest` timer.
      const silentFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).endsWith('/api/info')) return json(SETTINGS);
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('The operation was aborted.');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }) as unknown as typeof globalThis.fetch;

      const p = probeServer('https://x', undefined, { fetch: silentFetch });
      let state = 'pendante';
      void p.then(
        () => (state = 'résolue'),
        () => (state = 'rejetée'),
      );

      mock.timers.tick(14_999);
      await Promise.resolve();
      assert.equal(state, 'pendante', 'no cut before the timeout');

      mock.timers.tick(2);
      await assert.rejects(p, (e: unknown) => {
        assert.ok(e instanceof ServerError);
        assert.match(e.message, /no response within 15 s/);
        return true;
      });
    } finally {
      mock.timers.reset();
    }
  });
});
