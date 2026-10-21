import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeServer } from './testing.ts';
import { createMattermostProvider } from './index.ts';
import { RestClient } from '../../lib/rest.ts';
import type { Session } from '../../lib/auth.ts';

const session = (base: string): Session => ({ kind: 'mattermost', baseUrl: base, userId: 'me', username: 'me', authToken: 'token', siteUrl: null });

test('a group DM resolves missing ids, posts me first and shows the channel', async () => {
  const group = { id: 'g1', type: 'G', name: 'hash', display_name: 'bob, carol, me' };
  const server = fakeServer((call) => {
    if (call.path === '/users/username/carol') return { body: { id: 'carol-id', username: 'carol' } };
    if (call.path === '/channels/group') return { status: 201, body: group };
    if (call.path === '/users/me/preferences') return { body: { status: 'OK' } };
    if (call.path === '/users/ids') return { body: (call.body as string[]).map((id) => ({ id, username: id.replace('-id', '') })) };
    if (call.path === '/users/usernames') return { body: (call.body as string[]).map((username) => ({ id: `${username}-id`, username })) };
    if (call.path === '/channels/g1') return { body: group };
    if (call.path === '/channels/g1/members/me') return { body: { channel_id: 'g1', user_id: 'me', msg_count: 0, mention_count: 0, last_viewed_at: 0 } };
    return undefined;
  });
  const provider = createMattermostProvider(session(server.base), new RestClient(server.base), () => 'id', { fetch: server.fetcher });
  const open = provider.actions.openOrCreateGroupDm;
  assert.ok(open);
  const { rid } = await open.call(provider.actions, [{ username: 'bob', uid: 'bob-id' }, { username: 'carol' }]);
  assert.equal(rid, 'g1');
  assert.deepEqual(server.calls.find((call) => call.path === '/channels/group')?.body, ['me', 'bob-id', 'carol-id']);
  assert.deepEqual(server.calls.find((call) => call.path === '/users/me/preferences')?.body, [
    { user_id: 'me', category: 'group_channel_show', name: 'g1', value: 'true' },
  ]);
});

test('a refused group DM rejects instead of opening nowhere', async () => {
  const server = fakeServer((call) =>
    call.path === '/channels/group' ? { status: 400, body: { id: 'api.channel.create_group.bad_size.app_error', message: 'bad size', status_code: 400 } } : undefined,
  );
  const provider = createMattermostProvider(session(server.base), new RestClient(server.base), () => 'id', { fetch: server.fetcher });
  await assert.rejects(provider.actions.openOrCreateGroupDm!([{ username: 'bob', uid: 'bob-id' }]));
  assert.equal(server.calls.filter((call) => call.path === '/users/me/preferences').length, 0);
});

test('people search leaves me and deactivated accounts out and names the rest', async () => {
  const server = fakeServer((call) => {
    if (call.path !== '/users/search') return undefined;
    assert.deepEqual(call.body, { term: 'bo', limit: 20 });
    return {
      body: [
        { id: 'me', username: 'me' },
        { id: 'bob-id', username: 'bob', first_name: 'Bob', last_name: 'Durand' },
        { id: 'old-id', username: 'old', delete_at: 5 },
        { id: 'bot-id', username: 'botty', nickname: 'Robot' },
        { id: 'plain-id', username: 'plain' },
      ],
    };
  });
  const provider = createMattermostProvider(session(server.base), new RestClient(server.base), () => 'id', { fetch: server.fetcher });
  assert.deepEqual(await provider.searchPeople!('@bo'), [
    { id: 'bob-id', name: 'bob', detail: 'Bob Durand' },
    { id: 'bot-id', name: 'botty', detail: 'Robot' },
    { id: 'plain-id', name: 'plain', detail: 'plain' },
  ]);
});
