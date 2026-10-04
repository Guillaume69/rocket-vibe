import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  applySession,
  prepareTwoFactorCode,
  resumeSession,
  logIn,
  logOut,
} from './auth.ts';
import { RestClient, TwoFactorError } from './rest.ts';

const hash = async (t: string) => createHash('sha256').update(t).digest('hex');

let server: Server;
let base: string;
let handle: (req: IncomingMessage, res: ServerResponse, body: string) => void;
let received: { url: string; body: unknown; headers: Record<string, string | string[] | undefined> }[] =
  [];

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        body: raw === '' ? null : (JSON.parse(raw) as unknown),
        headers: req.headers,
      });
      handle(req, res, raw);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (typeof a === 'string' || a === null) throw new Error('unexpected address');
  base = `http://127.0.0.1:${a.port}`;
});

after(() => server.close());
beforeEach(() => {
  received = [];
});

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const LOGIN_SUCCESS = {
  status: 'success',
  data: { authToken: 'jeton-abc', userId: 'u1', me: { username: 'alice' } },
};

describe('auth', () => {
  test('a login without 2FA returns a session', async () => {
    handle = (_q, res) => json(res, 200, LOGIN_SUCCESS);
    const s = await logIn(new RestClient(base), {
      user: 'alice',
      password: 'secret',
    });
    assert.deepEqual(s, {
      baseUrl: base,
      authToken: 'jeton-abc',
      userId: 'u1',
      username: 'alice',
      kind: 'rocketchat',
      // `Site_Url` does not come from the login: the login screen fills it in
      // from its probe before persisting.
      siteUrl: null,
    });
    assert.deepEqual(received[0].body, { user: 'alice', password: 'secret' });
  });

  test('the login sends no auth headers', async () => {
    handle = (_q, res) => json(res, 200, LOGIN_SUCCESS);
    const c = new RestClient(base);
    c.auth = { authToken: 'ancien', userId: 'vieux' };
    await logIn(c, { user: 'alice', password: 'secret' });
    assert.equal(received[0].headers['x-auth-token'], undefined);
  });

  test('a required 2FA throws TwoFactorError with its method', async () => {
    handle = (_q, res) =>
      json(res, 401, {
        success: false,
        errorType: 'totp-required',
        details: { method: 'totp', availableMethods: ['totp'], codeGenerated: false },
      });
    await assert.rejects(
      logIn(new RestClient(base), { user: 'alice', password: 's' }),
      (e: unknown) => {
        assert.ok(e instanceof TwoFactorError);
        assert.equal(e.method, 'totp');
        return true;
      },
    );
  });

  test('a TOTP code is sent as is', async () => {
    const error = new TwoFactorError('totp', ['totp'], false);
    const code = await prepareTwoFactorCode(error, ' 123456 ', hash);
    assert.deepEqual(code, { method: 'totp', code: '123456' });
  });

  test('for the `password` method, the SHA-256 is sent, not the plain text', async () => {
    const error = new TwoFactorError('password', [], false);
    const code = await prepareTwoFactorCode(error, 'mon-mot-de-passe', hash);
    assert.equal(code.method, 'password');
    assert.equal(code.code, await hash('mon-mot-de-passe'));
    assert.notEqual(code.code, 'mon-mot-de-passe');
    assert.match(code.code, /^[0-9a-f]{64}$/);
  });

  test('the replay with the code sends the 2FA headers', async () => {
    handle = (_q, res) => json(res, 200, LOGIN_SUCCESS);
    await logIn(
      new RestClient(base),
      { user: 'alice', password: 's' },
      { code: '123456', method: 'totp' },
    );
    assert.equal(received[0].headers['x-2fa-code'], '123456');
    assert.equal(received[0].headers['x-2fa-method'], 'totp');
  });

  test('resumeSession sends `resume`, no password', async () => {
    handle = (_q, res) => json(res, 200, LOGIN_SUCCESS);
    const s = await resumeSession(new RestClient(base), 'jeton-stocke');
    assert.deepEqual(received[0].body, { resume: 'jeton-stocke' });
    assert.equal(s.userId, 'u1');
  });

  test('a login response without a token is rejected cleanly', async () => {
    handle = (_q, res) => json(res, 200, { status: 'success', data: { me: {} } });
    await assert.rejects(
      logIn(new RestClient(base), { user: 'a', password: 'b' }),
      /Invalid login response/,
    );
  });

  test('a 200 login without a body does not produce a raw TypeError', async () => {
    // `RestClient` returns `{}` on an empty 200 (needed for /logout): without a
    // guard, `response.data.authToken` would throw an unintelligible TypeError.
    handle = (_q, res) => {
      res.writeHead(200);
      res.end();
    };
    await assert.rejects(
      logIn(new RestClient(base), { user: 'a', password: 'b' }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.equal(e.name, 'LoginError');
        return true;
      },
    );
  });

  test('logOut is best-effort: a 401 does not reject', async () => {
    handle = (_q, res) => json(res, 401, { success: false, error: 'invalid' });
    const c = new RestClient(base);
    c.auth = { authToken: 'x', userId: 'y' };
    await logOut(c); // must not throw
    assert.equal(c.auth, null, 'an already invalid token must not stay in memory');
  });

  test('applySession plugs the credentials into the client', () => {
    const c = new RestClient(base);
    applySession(c, {
      baseUrl: base,
      authToken: 't',
      userId: 'u',
      username: 'alice',
      kind: 'rocketchat',
      siteUrl: null,
    });
    assert.deepEqual(c.auth, { authToken: 't', userId: 'u' });
  });
});
