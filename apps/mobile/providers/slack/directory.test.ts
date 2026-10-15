import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SlackClient } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { COOKIE, TOKEN } from './testing.ts';

test('ids already known never wait behind a running lookup; a queued one does', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asked: string[] = [];
  const client = new SlackClient(TOKEN, COOKIE, {
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const user = new URLSearchParams(String(init?.body ?? '')).get('user')!;
      asked.push(user);
      await gate;
      return new Response(JSON.stringify({ ok: true, user: { id: user, name: user.toLowerCase() } }), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  });
  const directory = new SlackDirectory(client, 'https://test.slack.com');
  directory.remember({ id: 'U001', username: 'alice', displayName: null, avatar: null });
  const slow = directory.ensure(['U009']);
  let known = false;
  void directory.ensure(['U001']).then(() => {
    known = true;
  });
  let queued = false;
  void directory.ensure(['U009']).then(() => {
    queued = true;
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([known, queued], [true, false]);
  release();
  await slow;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(queued, true);
  assert.deepEqual(asked, ['U009']);
  assert.equal(directory.username('U009'), 'u009');
});
