import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import type { WebSocketLike } from '../../lib/ddp.ts';
import type { Listener } from '../../lib/provider.ts';
import { RestClient } from '../../lib/rest.ts';
import { kchatServers, loginMattermost, MmMfaRequired } from './auth.ts';
import { MmClient, MmError } from './client.ts';
import { createMattermostProvider } from './index.ts';
import { mattermostSidebarSettings } from './sidebarSettings.ts';
import { pendingPostId } from './outbox.ts';
import { authorizeUrl, codeFromRedirect, createPkce, KCHAT_REDIRECT } from './kchatOAuth.ts';
import { KchatPusher } from './pusher.ts';
import { fakeServer } from './testing.ts';

const sha256 = async (text: string) => new Uint8Array(createHash('sha256').update(text).digest());

describe('kChat OAuth', () => {
  test('S256 challenge matches the RFC 7636 example', async () => {
    const verifierBytes = Buffer.from('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'base64url');
    let first = true;
    const pkce = await createPkce((size) => {
      const out = first ? new Uint8Array(verifierBytes) : new Uint8Array(size);
      first = false;
      return out;
    }, sha256);
    assert.equal(pkce.verifier, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    assert.equal(pkce.challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('the redirect is only accepted for our state', async () => {
    const pkce = { verifier: 'v', challenge: 'c', state: 'abc' };
    assert.equal(codeFromRedirect(`${KCHAT_REDIRECT}?code=xyz&state=abc`, pkce), 'xyz');
    assert.throws(() => codeFromRedirect(`${KCHAT_REDIRECT}?code=xyz&state=other`, pkce));
    assert.throws(() => codeFromRedirect(`${KCHAT_REDIRECT}?error=access_denied&state=abc`, pkce));
    const url = new URL(authorizeUrl(pkce));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), KCHAT_REDIRECT);
  });

  test('servers of an account come from the global kChat directory', async () => {
    const server = fakeServer((call) => (call.path === '/users/me/servers' ? { body: [{ id: 's1', name: 'acme', display_name: 'ACME', url: 'https://acme.kchat.infomaniak.com/' }] } : undefined), 'https://kchat.infomaniak.com');
    const list = await kchatServers('ik', { fetch: server.fetcher });
    assert.deepEqual(list, [{ id: 's1', name: 'acme', displayName: 'ACME', url: 'https://acme.kchat.infomaniak.com' }]);
    assert.equal(server.calls[0]?.headers.Authorization, 'Bearer ik');
  });
});

describe('Mattermost login', () => {
  test('the token comes from the Token header; an MFA account asks for its code', async () => {
    let withCode = false;
    const server = fakeServer((call) => {
      const body = call.body as Record<string, unknown>;
      if (body.token === undefined) return { status: 401, body: { id: 'mfa.validate_token.authenticate.app_error', message: 'mfa' } };
      withCode = true;
      return { body: { id: 'u-me', username: 'me' }, headers: { Token: 'sess' } };
    });
    await assert.rejects(loginMattermost(server.base, 'me', 'pw', undefined, { fetch: server.fetcher }), MmMfaRequired);
    const session = await loginMattermost(server.base, 'me', 'pw', '123456', { fetch: server.fetcher });
    assert.ok(withCode);
    assert.equal(session.authToken, 'sess');
    assert.equal(session.kind, 'mattermost');
    assert.equal(server.calls[0]?.headers['X-Requested-With'], undefined, 'no cookie session: it would shadow the bearer');
  });
});

describe('MmClient', () => {
  test('a 429 waits for the reset then retries', async () => {
    let n = 0;
    const server = fakeServer(() => (++n === 1 ? { status: 429, headers: { 'X-Ratelimit-Reset': '1' } } : { body: { ok: true } }));
    const waits: number[] = [];
    const client = new MmClient(server.base, 't', { fetch: server.fetcher, sleep: async (ms) => void waits.push(ms) });
    assert.deepEqual(await client.get('/x'), { ok: true });
    assert.deepEqual(waits, [1000]);
  });

  test('a 401 revokes the session only on an authenticated call', async () => {
    const server = fakeServer(() => ({ status: 401, body: { id: 'api.context.session_expired.app_error', message: 'expired' } }));
    const revoked: string[] = [];
    const client = new MmClient(server.base, 't', { fetch: server.fetcher, onTokenRejected: (t) => void revoked.push(t) });
    await assert.rejects(client.get('/users/me', { anonymous: true }));
    assert.deepEqual(revoked, []);
    await assert.rejects(client.get('/users/me'));
    assert.deepEqual(revoked, ['t']);
  });
  test("kChat's plain {message} 401 is believed, but not on upstream Mattermost", async () => {
    const server = fakeServer(() => ({ status: 401, body: { message: 'Unauthorized' } }));
    const revoked: string[] = [];
    const upstream = new MmClient(server.base, 't', { fetch: server.fetcher, onTokenRejected: (t) => void revoked.push(t) });
    await assert.rejects(upstream.get('/users/me'));
    assert.equal(revoked.length, 0);
    const kchat = new MmClient(server.base, 't', { fetch: server.fetcher, plainErrors: true, onTokenRejected: (t) => void revoked.push(t) });
    await assert.rejects(kchat.get('/users/me'));
    assert.deepEqual(revoked, ['t']);
  });

  test('pending_post_id is <my id>:<digits>, the same for the same row', () => {
    const me = '0196fc24-9fdf-72a9-9dfe-81b84476e14f';
    assert.equal(pendingPostId(me, 'ffffffffffffffffffffffff'), `${me}:79228162514264337593543950335`);
    assert.equal(pendingPostId(me, 'a1b2c3d4e5f6a7b8c9d0e1f2'), pendingPostId(me, 'a1b2c3d4e5f6a7b8c9d0e1f2'));
    assert.match(pendingPostId(me, 'a1b2c3d4e5f6a7b8c9d0e1f2'), /^[0-9a-f-]{36}:\d+$/);
  });
});

describe('KchatPusher', () => {
  test('channels are authorized by the team server, then events are expanded', async () => {
    const server = fakeServer((call) => {
      if (call.path === '/config/client') return { body: { WebsocketURL: 'wss://ws.test' } };
      if (call.path === '/users/me') return { body: { id: 'u-me', user_id: 42, team_id: 't1' } };
      if (call.path === '/broadcasting/auth') return { body: { auth: `sig:${new URLSearchParams(String(call.body)).get('channel_name')}` } };
      return undefined;
    }, 'https://acme.kchat.test');
    const sent: Record<string, unknown>[] = [];
    let ws: WebSocketLike | null = null;
    const create = (url: string): WebSocketLike => {
      assert.ok(url.startsWith('wss://ws.test/app/kchat-key'));
      const socket: WebSocketLike = {
        onopen: null, onmessage: null, onclose: null, onerror: null,
        send(data: string) {
          const frame = JSON.parse(data) as { event: string; data: { channel?: string } };
          sent.push(frame);
          if (frame.event === 'pusher:subscribe') {
            queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ event: 'pusher_internal:subscription_succeeded', channel: frame.data.channel, data: '{}' }) }));
          }
        },
        close() { socket.onclose?.({}); },
      };
      ws = socket;
      queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ event: 'pusher:connection_established', data: '{"socket_id":"1.2","activity_timeout":120}' }) }));
      return socket;
    };
    const expanded: string[] = [];
    const pusher = new KchatPusher(new MmClient(server.base, 'ik', { fetch: server.fetcher }), async (name, data) => {
      expanded.push(`${name}:${String((data.post as { id?: string } | undefined)?.id)}`);
      return [];
    }, { createWebSocket: create });
    await pusher.connect();
    assert.equal(pusher.state, 'authenticated');
    assert.deepEqual(sent.map((f) => (f.data as { channel: string }).channel), ['private-team.t1', 'presence-user.42', 'presence-teamUser.u-me']);
    const auth = server.calls.find((c) => c.path === '/broadcasting/auth');
    assert.equal(auth?.headers.Authorization, 'Bearer ik');
    (ws as WebSocketLike | null)?.onmessage?.({ data: JSON.stringify({ event: 'posted', channel: 'presence-teamUser.u-me', data: JSON.stringify({ post: { id: 'p1' } }) }) });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(expanded, ['posted:p1']);
    pusher.close();
  });
});

describe('What a 401 means', () => {
  const rejected = async (body: string, plainErrors = false) => {
    let revoked = 0;
    const server = fakeServer(() => ({ status: 401, body: body === '' ? undefined : JSON.parse(body) }));
    const client = new MmClient(server.base, 'tok', { fetch: server.fetcher, plainErrors, onTokenRejected: () => void revoked++ });
    const error = await client.get('/users/me').catch((e: unknown) => e as MmError);
    return { revoked, rejectsToken: (error as MmError).rejectsToken };
  };

  test("the server's own envelope stands for a refused token", async () => {
    assert.deepEqual(await rejected('{"id":"api.context.session_expired.app_error","message":"Invalid","status_code":401}'), { revoked: 1, rejectsToken: true });
    assert.deepEqual(await rejected('{"message":"Unauthorized"}', true), { revoked: 1, rejectsToken: true });
  });

  test("a proxy's 401 or a mistyped password does not", async () => {
    assert.deepEqual(await rejected(''), { revoked: 0, rejectsToken: false });
    assert.deepEqual(await rejected('{"message":"Unauthorized"}'), { revoked: 0, rejectsToken: false });
    assert.deepEqual(await rejected('{"id":"api.user.check_user_password.invalid.app_error","message":"bad","status_code":401}'), { revoked: 0, rejectsToken: false });
  });

  test("kChat's channel authorization follows the same rule", async () => {
    let revoked = 0;
    const html = async () => new Response('<html>401</html>', { status: 401 });
    const client = new MmClient('https://acme.kchat.infomaniak.com', 'tok', { fetch: html as typeof fetch, plainErrors: true, onTokenRejected: () => void revoked++ });
    await assert.rejects(client.postForm('https://acme.kchat.infomaniak.com/broadcasting/auth', { channel_name: 'x' }));
    assert.equal(revoked, 0);
  });
});

describe('The kChat directory', () => {
  test('only https addresses on kchat.infomaniak.com receive the token', async () => {
    const server = fakeServer(() => ({
      body: [
        { id: 'a', name: 'a', url: 'https://acme.kchat.infomaniak.com' },
        { id: 'b', name: 'b', url: 'http://plain.kchat.infomaniak.com' },
        { id: 'c', name: 'c', url: 'https://kchat.infomaniak.com.evil.example' },
        { id: 'd', name: 'd', url: 'https://evil.example' },
      ],
    }), 'https://kchat.infomaniak.com');
    const list = await kchatServers('ik', { fetch: server.fetcher });
    assert.deepEqual(list.map((s) => s.id), ['a']);
  });
});

describe('MmClient.pages', () => {
  test('reads page after page until a short one', async () => {
    const server = fakeServer((call) => ({ body: Array.from({ length: call.query.get('page') === '0' ? 200 : 3 }, (_, i) => ({ i })) }));
    const client = new MmClient(server.base, 'tok', { fetch: server.fetcher });
    assert.equal((await client.pages('/emoji')).length, 203);
    assert.deepEqual(server.calls.map((c) => c.query.get('page')), ['0', '1']);
  });
});

describe('Mattermost custom emoji', () => {
  test('every page of /emoji, each image addressed by its id', async () => {
    const server = fakeServer((call) => (call.path === '/emoji' ? { body: call.query.get('page') === '0' ? [{ id: 'e1', name: 'alb-youpi' }, { name: 'no-id' }] : [] } : undefined));
    const session = { baseUrl: server.base, authToken: 'tok', userId: 'u-me', username: 'me', kind: 'mattermost' as const, siteUrl: null };
    const listener = { onEvent: () => () => {}, onLoss: () => () => {} } as unknown as Listener;
    const provider = createMattermostProvider(session, new RestClient(server.base), () => 'id', { fetch: server.fetcher, listener });
    assert.deepEqual(await provider.listCustomEmojis?.(), [{ name: 'alb-youpi', extension: 'png', aliases: [], uri: `${server.base}/api/v4/emoji/e1/image` }]);
  });
});

describe('Conversation list settings', () => {
  test("read from the account's preferences, the server's format winning when locked; written back as preferences", async () => {
    let locked = 'false';
    const server = fakeServer((call) => {
      if (call.path === '/config/client') return { body: { TeammateNameDisplay: 'username', LockTeammateNameDisplay: locked } };
      if (call.path === '/users/me/preferences' && call.method === 'GET') {
        return { body: [{ category: 'display_settings', name: 'name_format', value: 'full_name' }, { category: 'sidebar_settings', name: 'limit_visible_dms_gms', value: '20' }] };
      }
      if (call.path === '/users/me/preferences' && call.method === 'PUT') return { body: true };
      return undefined;
    });
    const settings = mattermostSidebarSettings(new MmClient(server.base, 't', { fetch: server.fetcher }), 'u-me');
    assert.deepEqual(await settings.read(), { nameFormat: 'full_name', nameLocked: false, dmLimit: 20 });
    locked = 'true';
    assert.deepEqual(await settings.read(), { nameFormat: 'username', nameLocked: true, dmLimit: 20 });
    await settings.write({ dmLimit: 10 });
    assert.deepEqual(server.calls.at(-1)?.body, [{ user_id: 'u-me', category: 'sidebar_settings', name: 'limit_visible_dms_gms', value: '10' }]);
  });
});
