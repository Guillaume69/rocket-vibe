import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeServer } from './testing.ts';
import { createMattermostProvider } from './index.ts';
import { RestClient } from '../../lib/rest.ts';
import type { Session } from '../../lib/auth.ts';

const session = (base: string): Session => ({ kind: 'mattermost', baseUrl: base, userId: 'me', username: 'me', authToken: 'token', siteUrl: null });

test('a channel is renamed through its display name, a DM is not offered', async () => {
  const channels: Record<string, unknown> = {
    c1: { id: 'c1', type: 'O', name: 'town-square', display_name: 'Town Square' },
    d1: { id: 'd1', type: 'D', name: 'me__bob', display_name: '' },
  };
  const server = fakeServer((call) => {
    const id = call.path.match(/^\/channels\/(\w+)(\/stats)?$/);
    if (id && call.method === 'GET') return { body: id[2] ? { member_count: 2 } : channels[id[1]] };
    if (call.path === '/channels/c1/patch') return { body: { ...(channels.c1 as object), display_name: 'Lobby' } };
    return undefined;
  });
  const provider = createMattermostProvider(session(server.base), new RestClient(server.base), () => 'id', { fetch: server.fetcher });
  assert.deepEqual(await provider.actions.editableSettings!('c1'), { name: true, texts: false, readOnly: false });
  assert.equal(await provider.actions.editableSettings!('d1'), null);
  await provider.actions.saveRoomSettings!('c1', { name: 'Lobby' });
  const patch = server.calls.find((call) => call.path === '/channels/c1/patch');
  assert.deepEqual([patch?.method, patch?.body], ['PUT', { display_name: 'Lobby' }]);
});
