import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RestClient, RestError } from './rest.ts';
import { MmClient, MmError } from '../providers/mattermost/client.ts';

function stalledBody() {
  let calls = 0;
  let release: () => void = () => {};
  const reading = new Promise<void>(resolve => { release = resolve; });
  const fetcher: typeof fetch = async (_input, init) => {
    calls++;
    return new Response(new ReadableStream({
      start(stream) {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('Body aborted');
          error.name = 'AbortError';
          stream.error(error);
        }, { once: true });
      },
      pull() { release(); },
    }), { status: 200 });
  };
  return { fetcher, reading, calls: () => calls };
}

for (const kind of ['rocketchat', 'mattermost'] as const) {
  test(kind + ': the deadline still aborts a stalled response body', { timeout: 1000 }, async () => {
    const body = stalledBody();
    const result = kind === 'rocketchat'
      ? new RestClient('http://chat.test', { fetch: body.fetcher, timeoutMs: 20 }).get('me', { networkReplay: true })
      : new MmClient('http://chat.test', 'token', { fetch: body.fetcher, timeoutMs: 20 }).get('/users/me');
    await assert.rejects(result, error => {
      assert.ok(error instanceof RestError || error instanceof MmError);
      assert.equal(error.status, 0);
      return true;
    });
    assert.equal(body.calls(), 1, 'a body failure never blindly replays the request');
  });

  test(kind + ': caller cancellation survives receipt of the headers', { timeout: 1000 }, async () => {
    const body = stalledBody();
    const controller = new AbortController();
    const result = kind === 'rocketchat'
      ? new RestClient('http://chat.test', { fetch: body.fetcher }).get('me', { signal: controller.signal })
      : new MmClient('http://chat.test', 'token', { fetch: body.fetcher }).get('/users/me', { signal: controller.signal });
    const rejected = assert.rejects(result);
    await body.reading;
    controller.abort();
    await rejected;
    assert.equal(body.calls(), 1);
  });
}

test('kChat form authentication also bounds a stalled response body', { timeout: 1000 }, async () => {
  const body = stalledBody();
  const client = new MmClient('http://chat.test', 'token', { fetch: body.fetcher, timeoutMs: 20 });
  await assert.rejects(client.postForm('http://chat.test/broadcasting/auth', {}), error => error instanceof MmError && error.status === 0);
});

test('a delayed Mattermost 401 cannot revoke a replacement token', async () => {
  const rejected: string[] = [];
  let answer: (response: Response) => void = () => {};
  const fetcher: typeof fetch = () => new Promise(resolve => { answer = resolve; });
  const client = new MmClient('http://chat.test', 'old-token', { fetch: fetcher, onTokenRejected: token => rejected.push(token) });
  const request = client.get('/users/me');
  const failed = assert.rejects(request, error => error instanceof MmError && error.status === 401);
  client.token = 'new-token';
  answer(new Response(JSON.stringify({ id: 'api.context.session_expired.app_error', message: 'Expired' }), { status: 401 }));
  await failed;
  assert.deepEqual(rejected, []);
});
