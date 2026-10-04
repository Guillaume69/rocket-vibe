import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

import { RestClient, TwoFactorError, RestError, isTokenRejected } from './rest.ts';

type Handle = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base: string;
let handle: Handle;
/** Received requests, to check the headers actually sent. */
let received: { url: string; method: string; headers: Record<string, string | string[] | undefined> }[] = [];

before(async () => {
  server = createServer((req, res) => {
    received.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers });
    handle(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('unexpected address');
  base = `http://127.0.0.1:${address.port}`;
});

after(() => server.close());

// Without this, `received[0]` would point at another test's request as soon as
// one is added before, and the failure would be unintelligible.
beforeEach(() => {
  received = [];
});

function reply(res: ServerResponse, status: number, body: unknown, headers: object = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * Client whose sleep is instant, clock frozen and spread zero: delays stay
 * exact numbers, and the dedicated test below exercises the spread.
 */
function client(sleeps: number[] = []) {
  return new RestClient(base, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_000_000,
    random: () => 0,
  });
}

describe('RestClient', () => {
  test('a successful GET returns the JSON', async () => {
    handle = (_q, res) => reply(res, 200, { success: true, version: '8.5' });
    const r = await client().get<{ version: string }>('info');
    assert.equal(r.version, '8.5');
    assert.equal(received[0].url, '/api/v1/info');
  });

  test('query parameters are encoded, `undefined` is omitted', async () => {
    handle = (_q, res) => reply(res, 200, { success: true });
    await client().get('channels.history', {
      params: { roomId: 'a b&c', count: 100, absent: undefined },
    });
    assert.equal(received[0].url, '/api/v1/channels.history?roomId=a+b%26c&count=100');
  });

  test('auth headers are sent, except when anonymous', async () => {
    handle = (_q, res) => reply(res, 200, { success: true });
    const c = client();
    c.auth = { authToken: 'jeton', userId: 'moi' };

    await c.get('me');
    assert.equal(received[0].headers['x-auth-token'], 'jeton');
    assert.equal(received[0].headers['x-user-id'], 'moi');

    await c.post('login', { anonymous: true, body: {} });
    assert.equal(received[1].headers['x-auth-token'], undefined);
  });

  test('2FA headers are sent when a code is provided', async () => {
    handle = (_q, res) => reply(res, 200, { success: true });
    await client().post('settings/Push_enable', {
      body: { value: true },
      twoFactor: { code: 'abcdef', method: 'password' },
    });
    assert.equal(received[0].headers['x-2fa-code'], 'abcdef');
    assert.equal(received[0].headers['x-2fa-method'], 'password');
  });

  test('`totp-required` throws a TwoFactorError, even when the method is `password`', async () => {
    handle = (_q, res) =>
      reply(res, 401, {
        success: false,
        errorType: 'totp-required',
        details: { method: 'password', availableMethods: [], codeGenerated: false },
      });
    await assert.rejects(client().get('me'), (e: unknown) => {
      assert.ok(e instanceof TwoFactorError);
      assert.equal(e.method, 'password');
      assert.deepEqual(e.availableMethods, []);
      assert.equal(e.generatedCode, false);
      return true;
    });
  });

  test('the /login 2FA shape (`error`, no `errorType`) is recognised', async () => {
    // Recorded as is on an 8.5 server: /api/v1/login does NOT set errorType.
    handle = (_q, res) =>
      reply(res, 401, {
        success: false,
        error: 'totp-required',
        status: 'error',
        message: 'TOTP Required',
        details: { method: 'email', availableMethods: ['email'], codeGenerated: false },
      });
    await assert.rejects(client().post('login', { anonymous: true }), (e: unknown) => {
      assert.ok(e instanceof TwoFactorError, 'must be a TwoFactorError, not RestError');
      assert.equal(e.method, 'email');
      assert.deepEqual(e.availableMethods, ['email']);
      return true;
    });
  });

  test('an unknown 2FA method falls back on `password` without crashing', async () => {
    handle = (_q, res) =>
      reply(res, 401, {
        success: false,
        errorType: 'totp-required',
        details: { method: 'sms-du-futur', availableMethods: ['totp', 'martien'] },
      });
    await assert.rejects(client().get('me'), (e: unknown) => {
      assert.ok(e instanceof TwoFactorError);
      assert.equal(e.method, 'password');
      assert.deepEqual(e.availableMethods, ['totp']);
      return true;
    });
  });

  test('an ordinary 401 throws a RestError carrying the status', async () => {
    handle = (_q, res) => reply(res, 401, { success: false, error: 'unauthorized' });
    await assert.rejects(client().get('me'), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.status, 401);
      assert.equal(e.error, 'unauthorized');
      return true;
    });
  });

  test("/login's `status: 'error'` is treated as a failure despite the 200", async () => {
    handle = (_q, res) => reply(res, 200, { status: 'error', message: 'Unauthorized' });
    await assert.rejects(client().post('login', { anonymous: true }), RestError);
  });

  test('a 429 is retried honouring `x-ratelimit-reset`', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    handle = (_q, res) => {
      calls++;
      if (calls <= 2) {
        // now() is frozen at 1_000_000: reset in 2 s.
        reply(res, 429, { success: false }, { 'x-ratelimit-reset': '1002000' });
      } else {
        reply(res, 200, { success: true, ok: 1 });
      }
    };
    const r = await client(sleeps).get<{ ok: number }>('chat.postMessage');
    assert.equal(r.ok, 1);
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [2250, 2250], 'delay = reset - now + 250 ms');
  });

  test('without a reset header, the backoff is exponential', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    handle = (_q, res) => {
      calls++;
      calls <= 2 ? reply(res, 429, { success: false }) : reply(res, 200, { success: true });
    };
    await client(sleeps).get('chat.postMessage');
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  test('after 3 retries, the 429 surfaces as an error', async () => {
    const sleeps: number[] = [];
    handle = (_q, res) => reply(res, 429, { success: false, error: 'too-many' });
    await assert.rejects(client(sleeps).get('chat.postMessage'), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.status, 429);
      return true;
    });
    assert.equal(sleeps.length, 3);
  });

  test('an HTML body with a 200 does not become "server unreachable"', async () => {
    handle = (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>502 Bad Gateway</html>');
    };
    await assert.rejects(client().get('info'), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.match(e.message, /non-JSON/);
      return true;
    });
  });

  test('a 200 with an empty body is a success, not "invalid JSON"', async () => {
    // `POST /api/v1/logout` behaves exactly like this on an 8.5 server.
    handle = (_q, res) => {
      res.writeHead(200);
      res.end();
    };
    assert.deepEqual(await client().post('logout'), {});
  });

  test('an empty body with a 4xx stays an error', async () => {
    handle = (_q, res) => {
      res.writeHead(502);
      res.end();
    };
    await assert.rejects(client().get('info'), RestError);
  });

  test('a cancellation by the caller propagates AbortError, not a RestError', async () => {
    handle = () => {
      /* never a response */
    };
    const controller = new AbortController();
    const p = client().get('info', { signal: controller.signal });
    controller.abort();
    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, 'AbortError');
      return true;
    });
  });

  test('an already aborted signal stops the request from going out', async () => {
    handle = (_q, res) => reply(res, 200, { success: true });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client().get('info', { signal: controller.signal }), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, 'AbortError');
      return true;
    });
    assert.equal(received.length, 0, 'no request must reach the server');
  });

  test('networkReplay: a one-off network failure is replayed once then succeeds', async () => {
    // Reproduces the dead keep-alive connection on the 1st send: the `fetch`
    // rejects once (no HTTP response), the replay goes to the real server.
    handle = (_q, res) => reply(res, 200, { success: true, ok: 1 });
    let calls = 0;
    const sleeps: number[] = [];
    const c = new RestClient(base, {
      fetch: async (url, init) => {
        calls += 1;
        if (calls === 1) throw new TypeError('Network request failed');
        return globalThis.fetch(url, init);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1_000_000,
    });
    const r = await c.post<{ ok: number }>('users.updateOwnBasicInfo', {
      body: { data: {} },
      networkReplay: true,
    });
    assert.equal(r.ok, 1);
    assert.equal(calls, 2, 'one failure then one replay');
    assert.equal(sleeps.length, 1, 'a single replay wait');
  });

  test('networkReplay: two failures in a row surface "server unreachable"', async () => {
    let calls = 0;
    const c = new RestClient(base, {
      fetch: async () => {
        calls += 1;
        throw new TypeError('Network request failed');
      },
      sleep: async () => {},
      now: () => 1_000_000,
    });
    await assert.rejects(c.post('users.setStatus', { body: {}, networkReplay: true }), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.status, 0);
      assert.match(e.message, /unreachable/);
      return true;
    });
    assert.equal(calls, 2, 'the original call plus a single replay');
  });

  test('without networkReplay, a network failure throws at once (no replay)', async () => {
    // `chat.sendMessage` does not enable the replay: the row stays "en-attente"
    // in lib/outbox, the only place where its deduplication is safe.
    let calls = 0;
    const c = new RestClient(base, {
      fetch: async () => {
        calls += 1;
        throw new TypeError('Network request failed');
      },
      sleep: async () => {},
      now: () => 1_000_000,
    });
    await assert.rejects(c.post('chat.sendMessage', { body: {} }), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.status, 0);
      return true;
    });
    assert.equal(calls, 1, 'no replay without the flag');
  });

  test('the 429 retry is SPREAD, and the spread stays bounded', async () => {
    // Two concurrent calls receive the SAME `x-ratelimit-reset`: without
    // spread they go out on the same millisecond into a window that allows
    // only ten, and get another 429.
    const measure = async (random: number) => {
      const sleeps: number[] = [];
      let calls = 0;
      handle = (_q, res) => {
        calls++;
        if (calls === 1) {
          reply(res, 429, { success: false }, { 'x-ratelimit-reset': '1002000' });
        } else {
          reply(res, 200, { success: true });
        }
      };
      const c = new RestClient(base, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        now: () => 1_000_000,
        random: () => random,
      });
      await c.get('chat.postMessage');
      return sleeps[0];
    };

    const [bottom, middle, top] = [await measure(0), await measure(0.5), await measure(1)];
    assert.ok(bottom < middle && middle < top, `the randomness must modulate: ${bottom}/${middle}/${top}`);
    // Bounds: never BEFORE the announced reset, never more than half a second
    // after, or the spread would cost more than it gives back.
    for (const d of [bottom, middle, top]) {
      assert.ok(d >= 2250 && d <= 2750, `out of bounds: ${d}`);
    }
  });

  test('an aberrant reset header stays capped, spread included', async () => {
    const sleeps: number[] = [];
    handle = (_q, res) =>
      reply(res, 429, { success: false }, { 'x-ratelimit-reset': '9999999999999' });
    const c = new RestClient(base, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1_000_000,
      random: () => 1,
    });
    await assert.rejects(c.get('chat.postMessage'), RestError);
    assert.deepEqual(sleeps, [30_000, 30_000, 30_000], 'the cap holds despite the spread');
  });

  test('an abort() DURING the retry sleep is noticed AT ONCE', async () => {
    // `call`'s `finally` removes the abort listener before sleeping: the abort
    // was only seen on return from recursion, up to 30 s later. Here the sleep
    // NEVER ends on its own; only the cancellation can unblock, so the test
    // cannot pass by accident.
    handle = (_q, res) =>
      reply(res, 429, { success: false }, { 'x-ratelimit-reset': '1030000' });
    let sleepsNow: () => void = () => {};
    const sleepStarted = new Promise<void>((r) => {
      sleepsNow = r;
    });
    const c = new RestClient(base, {
      sleep: () =>
        new Promise<void>(() => {
          sleepsNow();
        }),
      now: () => 1_000_000,
      random: () => 0,
    });

    const controller = new AbortController();
    const p = c.get('chat.postMessage', { signal: controller.signal });
    await sleepStarted; // we KNOW we are sleeping, no arbitrary delay
    controller.abort();

    // The watchdog is NOT a synchronisation: the correct path answers at once.
    // It is there so a regression reads as a failure, not as a test suite
    // hanging forever.
    const verdict = await Promise.race([
      p.then(
        () => 'résolue',
        (e: unknown) => (e instanceof Error && e.name === 'AbortError' ? 'annulée' : 'autre'),
      ),
      new Promise((r) => setTimeout(() => r('pendante'), 250)),
    ]);
    assert.equal(verdict, 'annulée', 'the cancellation must be seen DURING the sleep');
  });

  test('a signal aborted just BEFORE the sleep does not let it start', async () => {
    // `addEventListener('abort')` on an ALREADY aborted signal never fires:
    // without the test at the head of `cancelableSleep`, we would sleep the
    // full delay and the abort would only be seen on return from recursion.
    //
    // The window is narrow but real: `call` removes its relay in its
    // `finally`, then `await response.body?.cancel()` yields. We abort exactly
    // there, by supplying the response body ourselves.
    let naps = 0;
    const controller = new AbortController();
    const c = new RestClient(base, {
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              controller.abort();
            },
          }),
          { status: 429, headers: { 'x-ratelimit-reset': '1030000' } },
        ),
      sleep: async () => {
        naps++;
      },
      now: () => 1_000_000,
      random: () => 0,
    });

    await assert.rejects(c.get('chat.postMessage', { signal: controller.signal }), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, 'AbortError');
      return true;
    });
    assert.equal(naps, 0, 'no sleep started: 30 s saved');
  });

  test('the trailing slash of baseUrl is normalised', () => {
    assert.equal(new RestClient('http://x:3000///').baseUrl, 'http://x:3000');
  });
});

/**
 * The predicate that allows an automatic logout. Written and tested BEFORE
 * being wired: it is the only safeguard against the real danger of this
 * workstream, ejecting a user whose session is perfectly valid.
 *
 * The status values below are not chosen: they are the ones recorded against
 * a Rocket.Chat 8.5 (local bench, 30/07/2026).
 */
describe('isTokenRejected', () => {
  /** What `RestClient` builds when it has READ the Rocket.Chat envelope. */
  const fromServer = (status: number, error?: string, errorType?: string) =>
    new RestError(error ?? 'x', status, error, errorType, true);

  test('a 401 from the application server is a rejected token', () => {
    // The exact body of a token revoked by `logout`, recorded on 8.5.
    assert.equal(isTokenRejected(fromServer(401, 'You must be logged in to do this.')), true);
  });

  test('a 2FA challenge is NOT a rejected token', () => {
    // `TwoFactorError` DECLARES itself 401 whatever the real HTTP status, and
    // on 8.5 a sensitive operation mid-session (users.update) answers 400.
    // Without this exclusion, changing one's password logged out.
    assert.equal(isTokenRejected(new TwoFactorError('password', ['password'], false)), false);
  });

  test('a network failure (status 0) is NOT a rejected token', () => {
    // Half of the workstream: offline is not revoked. A mobile client spends
    // its life without network; dropping the session for that would be worse
    // than the zombie state being fixed.
    assert.equal(isTokenRejected(new RestError('serveur injoignable.', 0)), false);
  });

  test('an error from another transport (DDP) is NOT a rejected token', () => {
    class DdpError extends Error {}
    assert.equal(isTokenRejected(new DdpError('Message refusé')), false);
    assert.equal(isTokenRejected(new Error('boum')), false);
    assert.equal(isTokenRejected('401'), false);
    assert.equal(isTokenRejected(null), false);
    assert.equal(isTokenRejected(undefined), false);
  });

  test('a 401 whose body is NOT Rocket.Chat is ignored', () => {
    // The corporate proxy, the captive portal, the maintenance page: they
    // answer 401 in HTML. `RestClient` then throws without `understoodResponse`
    // (the "non-JSON response" branch), and that status is THEIRS.
    assert.equal(isTokenRejected(new RestError('réponse non JSON (401, 812 octets).', 401)), false);
  });

  test('the refusals 8.5 returns OTHER than as 401 are ignored', () => {
    // Recorded one by one on the bench. Each happens in a perfectly valid
    // session, and each would have ejected the user had we settled for "the
    // server said no".
    assert.equal(isTokenRejected(fromServer(403, 'User does not have the permissions required for this action [error-unauthorized]')), false);
    assert.equal(isTokenRejected(fromServer(400, 'Not allowed [error-not-allowed]', 'error-not-allowed')), false);
    assert.equal(isTokenRejected(fromServer(400, 'does not match any channel [error-room-not-found]', 'error-room-not-found')), false);
    assert.equal(isTokenRejected(fromServer(404, 'Not Found')), false);
    assert.equal(isTokenRejected(fromServer(429, 'too many requests')), false);
    assert.equal(isTokenRejected(fromServer(500, 'boum')), false);
  });
});

describe('RestClient: rejected token reporting', () => {
  test('a server 401 reports the token ACTUALLY sent', async () => {
    handle = (_req, res) =>
      reply(res, 401, {
        success: false,
        error: 'You must be logged in to do this.',
        status: 'error',
        message: 'You must be logged in to do this.',
      });
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    const reported: string[] = [];
    c.onTokenRejected = (j) => reported.push(j);

    await assert.rejects(c.get('chat.syncMessages'));
    assert.deepEqual(reported, ['jeton-a']);
  });

  test('the reported token is the one at DEPARTURE, not at arrival', async () => {
    // The real race: logout then login while the request was in flight.
    // Reporting the current token would erase the BRAND NEW session.
    const c = client();
    c.auth = { authToken: 'ancien', userId: 'u1' };
    handle = (_req, res) => {
      c.auth = { authToken: 'tout-neuf', userId: 'u1' };
      reply(res, 401, { success: false, error: 'You must be logged in to do this.' });
    };
    const reported: string[] = [];
    c.onTokenRejected = (j) => reported.push(j);

    await assert.rejects(c.get('me'));
    assert.deepEqual(reported, ['ancien'], 'the caller must be able to recognise a stale 401');
  });

  test('an ANONYMOUS call reports nothing: it sent no token', async () => {
    // `settings.public`, `/api/info`, the login itself. Their 401 says nothing
    // about the session, and at login there is not even one yet.
    handle = (_req, res) => reply(res, 401, { success: false, error: 'unauthorized' });
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    let reported = 0;
    c.onTokenRejected = () => reported++;

    await assert.rejects(c.get('settings.public', { anonymous: true }));
    assert.equal(reported, 0);
  });

  test('a 2FA challenge mid-session reports nothing', async () => {
    // Probed on 8.5: `users.update` without a code answers **400** `totp-required`.
    handle = (_req, res) =>
      reply(res, 400, {
        success: false,
        error: 'TOTP Required [totp-required]',
        errorType: 'totp-required',
        details: { method: 'password', codeGenerated: false, availableMethods: [] },
      });
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    let reported = 0;
    c.onTokenRejected = () => reported++;

    await assert.rejects(c.post('users.update'), (e: unknown) => e instanceof TwoFactorError);
    assert.equal(reported, 0, 'changing one’s password must not log out');
  });

  test('a JSON 401 that is NOT Rocket.Chat reports nothing', async () => {
    // An API gateway happily answers `{"message":"Unauthorized"}`: it parses,
    // so "we read JSON" proves nothing. What is needed is the mark of the
    // house envelope: `success`, `status`, `errorType`.
    handle = (_req, res) => reply(res, 401, { message: 'Unauthorized' });
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    let reported = 0;
    c.onTokenRejected = () => reported++;

    await assert.rejects(c.get('me'), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.understoodResponse, false);
      return true;
    });
    assert.equal(reported, 0);
  });

  test('a LOGIN 401 does carry the envelope, but the call is anonymous', async () => {
    // Probed on 8.5: a wrong password returns
    // `{"success":false,"error":"Unauthorized","status":"error"}` with a 401. It
    // is a perfectly valid Rocket.Chat envelope: only the `anonymous` guard
    // stops a typo from destroying the current session.
    handle = (_req, res) =>
      reply(res, 401, { success: false, error: 'Unauthorized', status: 'error' });
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    let reported = 0;
    c.onTokenRejected = () => reported++;

    await assert.rejects(c.post('login', { anonymous: true, body: { user: 'x', password: 'y' } }));
    assert.equal(reported, 0);
  });

  test('an HTML 401 (proxy) reports nothing', async () => {
    handle = (_req, res) => {
      res.writeHead(401, { 'content-type': 'text/html' });
      res.end('<html><body>401 Authorization Required</body></html>');
    };
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    let reported = 0;
    c.onTokenRejected = () => reported++;

    await assert.rejects(c.get('me'), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.status, 401, 'the proxy status is kept...');
      assert.equal(e.understoodResponse, false, '...but it does not come from the application server');
      return true;
    });
    assert.equal(reported, 0);
  });

  test('a healthy session never reports anything', async () => {
    // The three legitimate 8.5 refusals, played against a real HTTP server.
    const cases = [
      [403, { success: false, error: 'User does not have the permissions required for this action [error-unauthorized]' }],
      [400, { success: false, error: 'Not allowed [error-not-allowed]', errorType: 'error-not-allowed' }],
      [500, { success: false, error: 'boum' }],
    ] as const;
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    let reported = 0;
    c.onTokenRejected = () => reported++;

    for (const [status, body] of cases) {
      handle = (_req, res) => reply(res, status, body);
      await assert.rejects(c.get('quelque.chose'));
    }
    assert.equal(reported, 0);
  });

  test('without a subscriber, a 401 stays an ordinary error', async () => {
    handle = (_req, res) => reply(res, 401, { success: false, error: 'You must be logged in to do this.' });
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    await assert.rejects(c.get('me'), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.status, 401);
      return true;
    });
  });
});
