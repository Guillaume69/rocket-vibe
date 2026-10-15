import assert from 'node:assert/strict';
import { test } from 'node:test';

import { slackActivity } from './activity.ts';
import { SlackClient } from './client.ts';
import { COOKIE, TOKEN, fakeSlack } from './testing.ts';

test('my presence: read from users.getPresence, set as auto or away', async () => {
  let presence = 'active';
  const server = fakeSlack((call) => {
    if (call.method === 'users.getPresence') return { body: { ok: true, presence, manual_away: presence === 'away' } };
    if (call.method === 'users.setPresence') return { body: { ok: true } };
    return undefined;
  });
  const activity = slackActivity(new SlackClient(TOKEN, COOKIE, { fetch: server.fetcher }), 'U000');
  assert.equal(await activity.read(), 'online');
  presence = 'away';
  assert.equal(await activity.read(), 'away');
  assert.deepEqual(await Promise.all((['online', 'away', 'busy', 'offline'] as const).map((s) => activity.set(s))), ['online', 'away', 'away', 'away']);
  assert.deepEqual(server.calls.map((c) => [c.method, c.args.user ?? c.args.presence]), [
    ['users.getPresence', 'U000'],
    ['users.getPresence', 'U000'],
    ['users.setPresence', 'auto'],
    ['users.setPresence', 'away'],
    ['users.setPresence', 'away'],
    ['users.setPresence', 'away'],
  ]);
});
