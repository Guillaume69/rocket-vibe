import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { directInviteLink, INVITE_DAYS, inviteLink } from './invites.ts';
import type { RestClient } from './rest.ts';

describe('invite links', () => {
  test('the direct link, never the cloud redirector the server may answer', async () => {
    const calls: unknown[] = [];
    const client = {
      baseUrl: 'https://chat.example',
      post: async (path: string, options: unknown) => {
        calls.push([path, options]);
        return { _id: 'nCt2CW', url: 'https://go.rocket.chat/invite?host=chat.example&path=invite%2FnCt2CW' };
      },
    } as unknown as RestClient;
    assert.equal(await inviteLink(client, 'https://site.example/', 'r1'), 'https://site.example/invite/nCt2CW');
    assert.equal(await inviteLink(client, null, 'r1'), 'https://chat.example/invite/nCt2CW');
    assert.deepEqual(calls[0], ['findOrCreateInvite', { body: { rid: 'r1', days: INVITE_DAYS, maxUses: 0 } }]);
  });

  test('an answer without an id is a failure', async () => {
    const client = { baseUrl: 'https://chat.example', post: async () => ({}) } as unknown as RestClient;
    await assert.rejects(inviteLink(client, null, 'r1'));
    assert.equal(directInviteLink('https://a/', 'x y'), 'https://a/invite/x%20y');
  });
});
