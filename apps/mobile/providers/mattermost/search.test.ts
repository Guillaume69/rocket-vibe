import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MmClient } from './client.ts';
import { MmDirectory } from './directory.ts';
import { roomSearchTarget } from './search.ts';
import { fakeServer } from './testing.ts';
import { createMattermostProvider } from './index.ts';
import { RestClient } from '../../lib/rest.ts';
import type { Session } from '../../lib/auth.ts';

for (const [type, memberIds, scope] of [
  ['O', [], 'dev'], ['P', [], 'dev'], ['D', ['me', 'bob-id'], '@bob'],
  ['G', ['me', 'bob-id', 'carol-id'], '@bob,carol,me'], ['D', ['me'], '@me'],
] as const) test(`server-side search scope for ${type} ${scope}`, async () => {
  const server = fakeServer(call => {
    if (call.path === '/channels/room') return { body: { id: 'room', type, name: 'dev', team_id: type === 'O' || type === 'P' ? 'team' : '' } };
    if (call.path === '/channels/room/members') return { body: memberIds.map(user_id => ({ user_id })) };
    if (call.path === '/users/ids') return { body: (call.body as string[]).map(id => ({ id, username: id.replace('-id', '') })) };
    if (call.path === '/users/me/teams') return { body: [{ id: 'team' }] };
    throw new Error(`Unexpected ${call.path}`);
  });
  const client = new MmClient(server.base, 'token', { fetch: server.fetcher });
  assert.deepEqual(await roomSearchTarget(client, new MmDirectory(client), 'room', 'me'), { teamId: 'team', scope });
});

test('missing membership or unresolved usernames never fall back to a team-wide search', async () => {
  for (const members of [[], [{ user_id: 'other' }], [{ user_id: 'me' }, { user_id: 'unknown' }]]) {
    const server = fakeServer(call => {
      if (call.path === '/channels/room') return { body: { id: 'room', type: 'D' } };
      if (call.path === '/channels/room/members') return { body: members };
      if (call.path === '/users/ids') return { body: [] };
      throw new Error(`Search must not run: ${call.path}`);
    });
    const client = new MmClient(server.base, 'token', { fetch: server.fetcher });
    await assert.rejects(roomSearchTarget(client, new MmDirectory(client), 'room', 'me'), /unavailable/);
    assert.ok(server.calls.every(call => !call.path.endsWith('/search')));
  }
});

test('the provider sends its exact scope and still rejects foreign-room results', async () => {
  const post = (id: string, channel_id: string) => ({ id, channel_id, user_id: 'me', message: 'needle', create_at: 1, update_at: 1, delete_at: 0, root_id: '', props: {} });
  const server = fakeServer(call => {
    if (call.path === '/channels/room') return { body: { id: 'room', type: 'O', name: 'dev', team_id: 'team' } };
    if (call.path === '/teams/team/posts/search') {
      assert.deepEqual(call.body, { terms: 'needle in:dev', is_or_search: false, page: 0, per_page: 60 });
      return { body: { order: ['own', 'foreign'], posts: { own: post('own', 'room'), foreign: post('foreign', 'other') } } };
    }
    if (call.path === '/users/ids') return { body: [{ id: 'me', username: 'me' }] };
    throw new Error(`Unexpected ${call.path}`);
  });
  const session: Session = { kind: 'mattermost', baseUrl: server.base, userId: 'me', username: 'me', authToken: 'token', siteUrl: null };
  const provider = createMattermostProvider(session, new RestClient(server.base), () => 'id', { fetch: server.fetcher });
  assert.ok(provider.searchMessages);
  assert.deepEqual((await provider.searchMessages('room', 'needle')).map(message => message.id), ['own']);
});
