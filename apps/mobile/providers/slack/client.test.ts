import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlackClient, SlackError, compareTimestamp, latestOfMs, oldestOfMs, timestampMs, validateCredentials } from './client.ts';
import { AUTH, COOKIE, TOKEN, fakeSlack } from './testing.ts';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const noSleep = async () => {};

test('token and original cookie accompany form reads at the fixed origin, never redirected', async () => {
  const server = fakeSlack((call) => ({ body: call.method === 'auth.test' ? AUTH : { ok: true, channels: [], response_metadata: { next_cursor: 'opaque+/=' } } }));
  const client = new SlackClient(TOKEN, COOKIE, { fetch: server.fetcher });
  assert.equal((await client.authenticate()).key, 'slack:T000:U000');
  assert.equal((await client.page('users.conversations', { types: 'im' }, 'channels')).nextCursor, 'opaque+/=');
  await client.page('users.conversations', { limit: 200, list: ['a'] }, 'channels', 'opaque+/=');
  for (const call of server.calls) {
    assert.equal(call.init?.method, 'POST');
    assert.equal(call.init?.redirect, 'error');
    assert.equal(call.init?.credentials, 'omit');
    assert.equal(call.headers.get('Cookie'), 'd=' + COOKIE);
    assert.equal(call.headers.get('Authorization'), 'Bearer ' + TOKEN);
    assert.equal(call.headers.get('Content-Type'), 'application/x-www-form-urlencoded; charset=utf-8');
  }
  assert.equal(server.calls[2]!.args.cursor, 'opaque+/=');
  assert.equal(server.calls[2]!.args.list, '["a"]');
  client.close();
});

test('a followed redirect is refused before its body is read', async () => {
  for (const response of [Object.defineProperty(json(AUTH), 'redirected', { value: true }), Object.defineProperty(json(AUTH), 'url', { value: 'https://elsewhere.test/api/auth.test' })]) {
    const client = new SlackClient(TOKEN, COOKIE, { fetch: async () => response });
    await assert.rejects(client.authenticate(), (e) => e instanceof SlackError && e.code === 'redirected');
  }
});

test('credentials reject header injection and preserve percent encoding', () => {
  validateCredentials(TOKEN, COOKIE);
  for (const bad of ['xoxd-a; other=b', 'xoxd-a\r\nX: y', 'xoxd-a b', 'xoxd-a,b', 'xoxd-a\\b', 'd=xoxd-a']) assert.throws(() => validateCredentials(TOKEN, bad), SlackError);
  assert.throws(() => validateCredentials('xoxc-a\n', COOKIE), SlackError);
});

test('only a Slack envelope refuses the session; proxies, HTML and 5xx are transport trouble', async () => {
  let rejected = 0;
  for (const code of ['not_authed', 'invalid_auth', 'token_expired', 'token_revoked', 'account_inactive']) {
    const client = new SlackClient(TOKEN, COOKIE, { fetch: async () => json({ ok: false, error: code }), onRejected: () => rejected++ });
    await assert.rejects(client.authenticate(), (e) => e instanceof SlackError && e.code === code && e.rejectsSession);
    await assert.rejects(client.authenticate(), SlackError);
  }
  assert.equal(rejected, 5);
  for (const response of [new Response('private secret', { status: 401 }), new Response('<html>private secret</html>'), json({ ok: false, error: 'private secret' }), json({ team_id: 'T000' }), json({ ok: false, error: 'missing_scope' }), new Response('', { status: 503 })]) {
    const client = new SlackClient(TOKEN, COOKIE, { fetch: async () => response, onRejected: () => rejected++ });
    await assert.rejects(client.authenticate(), (e) => e instanceof SlackError && !e.rejectsSession && !e.message.includes('private secret'));
  }
  const offline = new SlackClient(TOKEN, COOKIE, { fetch: async () => { throw new TypeError('Network request failed'); } });
  await assert.rejects(offline.authenticate(), (e) => e instanceof SlackError && e.code === 'connection_failed' && !e.rejectsSession);
  assert.equal(rejected, 5);
});

test("a 4xx carrying Slack's envelope is read like a 200; a 5xx or a non-JSON 4xx is not", async () => {
  let rejected = 0;
  const envelope = new SlackClient(TOKEN, COOKIE, { fetch: async () => json({ ok: false, error: 'invalid_auth' }, 401), onRejected: () => rejected++ });
  await assert.rejects(envelope.authenticate(), (e) => e instanceof SlackError && e.code === 'invalid_auth' && e.status === 401 && e.rejectsSession);
  assert.equal(rejected, 1);
  for (const response of [json({ ok: false, error: 'invalid_auth' }, 502), json({ ok: true }, 400), new Response('<html>no</html>', { status: 403 })]) {
    const client = new SlackClient(TOKEN, COOKIE, { fetch: async () => response, onRejected: () => rejected++ });
    await assert.rejects(client.authenticate(), (e) => e instanceof SlackError && e.code === 'http_error' && !e.rejectsSession);
  }
  assert.equal(rejected, 1);
});

test('429 waits for Retry-After, capped, and retries exactly once', async () => {
  const waits: number[] = [];
  let calls = 0;
  const client = new SlackClient(TOKEN, COOKIE, { fetch: async () => (++calls === 1 ? json({}, 429, { 'retry-after': '7' }) : json(AUTH)), sleep: async (ms) => void waits.push(ms) });
  await client.authenticate();
  assert.deepEqual(waits, [7000]);
  calls = 0;
  const stubborn = new SlackClient(TOKEN, COOKIE, { fetch: async () => { calls++; return json({ ok: false, error: 'ratelimited' }, 200, { 'retry-after': '120' }); }, sleep: async (ms) => void waits.push(ms) });
  await assert.rejects(stubborn.authenticate(), (e) => e instanceof SlackError && e.code === 'ratelimited' && e.retryAfter === 120);
  assert.equal(calls, 2);
  assert.equal(waits[1], 30_000);
});

test('identity validates the workspace boundary, the expected account and cannot change', async () => {
  for (const url of ['https://evilslack.com/', 'https://test.slack.com.evil.test/', 'http://test.slack.com/', 'https://user@test.slack.com/', 'https://test.slack.com:444/']) {
    await assert.rejects(new SlackClient(TOKEN, COOKIE, { fetch: async () => json({ ...AUTH, url }) }).authenticate(), SlackError);
  }
  const other = new SlackClient(TOKEN, COOKIE, { fetch: async () => json(AUTH), expected: { teamId: 'T001', userId: 'U000' } });
  await assert.rejects(other.authenticate(), (e) => e instanceof SlackError && e.code === 'identity_mismatch');
  await assert.rejects(other.authenticate(), (e) => e instanceof SlackError && e.code === 'cancelled');
  let first = true;
  const client = new SlackClient(TOKEN, COOKIE, { fetch: async () => { const body = first ? AUTH : { ...AUTH, team_id: 'T001' }; first = false; return json(body); } });
  await client.authenticate();
  await assert.rejects(client.authenticate(), (e) => e instanceof SlackError && e.code === 'identity_changed');
});

test('exact timestamps: microsecond order, millisecond display, millisecond bounds', () => {
  assert.equal(compareTimestamp('9.999999', '10.000000'), -1);
  assert.equal(compareTimestamp('1780000000.000001', '1780000000.000009'), -1);
  assert.equal(timestampMs('1780000000.123999'), 1780000000123);
  assert.equal(timestampMs('1780000000.000001'), 1780000000000);
  assert.equal(latestOfMs(1780000000007), '1780000000.007999');
  assert.equal(oldestOfMs(1780000000007), '1780000000.007000');
  assert.throws(() => timestampMs('1780000000.5'), SlackError);
});

test('paging follows cursors, refuses a repeated one and a truncation without one', async () => {
  const cursors = ['a', 'b', 'a'];
  let n = 0;
  const looping = new SlackClient(TOKEN, COOKIE, { fetch: async () => json({ ok: true, channels: [{ id: `C00${n}` }], response_metadata: { next_cursor: cursors[n++] } }), sleep: noSleep });
  await assert.rejects(looping.pages('users.conversations', {}, 'channels'), (e) => e instanceof SlackError && e.code === 'pagination_loop');
  const truncated = new SlackClient(TOKEN, COOKIE, { fetch: async () => json({ ok: true, messages: [], has_more: true }) });
  await assert.rejects(truncated.page('conversations.history', { channel: 'C000' }, 'messages'), (e) => e instanceof SlackError && e.code === 'pagination_unsupported');
});

test('closing aborts in-flight reads and discards late success', async () => {
  let signal: AbortSignal | undefined;
  let resolve!: (r: Response) => void;
  const client = new SlackClient(TOKEN, COOKIE, { fetch: async (_url, init) => { signal = init?.signal ?? undefined; return new Promise<Response>((r) => { resolve = r; }); } });
  const pending = client.authenticate();
  client.close();
  assert.equal(signal?.aborted, true);
  resolve(json(AUTH));
  await assert.rejects(pending, (e) => e instanceof SlackError && e.code === 'cancelled');
  await assert.rejects(client.authenticate(), SlackError);
});
