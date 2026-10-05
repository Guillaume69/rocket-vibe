import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RestClient } from '../../lib/rest.ts';
import { ActionsRC } from './actions.ts';

/** Fake client: we observe the endpoint and body of each `post`. */
function fakeClient(response: unknown = {}) {
  const calls: { path: string; body: unknown }[] = [];
  const client = {
    post: async (path: string, options: { body?: unknown } = {}) => {
      calls.push({ path, body: options.body });
      return response;
    },
  } as unknown as RestClient;
  return { client, calls };
}

describe('ActionsRC', () => {
  test('infosSalon preserves the official rooms.info route and neutral fields',async()=>{
    const calls:unknown[]=[];
    const client={get:async(path:string,options:unknown)=>{calls.push([path,options]);return {room:{_id:'r1',name:'room',fname:'A room',t:'p',description:'Description',topic:'Sujet',announcement:'Annonce',usersCount:4,ro:true}};}} as unknown as RestClient;
    assert.deepEqual(await new ActionsRC(client).roomInfo('r1'),{id:'r1',name:'A room',type:'p',description:'Description',topic:'Sujet',announcement:'Annonce',members:4,readOnly:true});
    assert.deepEqual(calls,[['rooms.info',{params:{roomId:'r1'}}]]);
  });
  test('react wraps the shortname in :code: and passes shouldReact', async () => {
    const { client, calls } = fakeClient();
    await new ActionsRC(client).react('r1', 'm1', '+1', true);
    assert.deepEqual(calls, [
      { path: 'chat.react', body: { messageId: 'm1', emoji: ':+1:', shouldReact: true } },
    ]);
  });

  test('edit and delete target roomId + msgId', async () => {
    const { client, calls } = fakeClient();
    const a = new ActionsRC(client);
    await a.edit('r1', 'm1', 'hi');
    await a.delete('r1', 'm1');
    assert.deepEqual(calls[0], {
      path: 'chat.update',
      body: { roomId: 'r1', msgId: 'm1', text: 'hi' },
    });
    assert.deepEqual(calls[1], { path: 'chat.delete', body: { roomId: 'r1', msgId: 'm1' } });
  });

  test('editing an encrypted message sends `content` and the mentions, never `text`', async () => {
    const { client, calls } = fakeClient();
    const content = { algorithm: 'rc.v2.aes-sha2', kid: 'k', iv: 'aXY=', ciphertext: 'Y3Q=' };
    await new ActionsRC(client).edit('r1', 'm1', 'hi @bob', { encrypt: () => content });
    assert.deepEqual(calls, [
      {
        path: 'chat.update',
        body: {
          roomId: 'r1',
          msgId: 'm1',
          content,
          e2eMentions: { e2eUserMentions: ['@bob'], e2eChannelMentions: [] },
        },
      },
    ]);
  });

  test('editing an encrypted message without a key fails without sending anything', async () => {
    const { client, calls } = fakeClient();
    await assert.rejects(new ActionsRC(client).edit('r1', 'm1', 'x', { encrypt: () => null }));
    assert.equal(calls.length, 0);
  });

  test('pin and markRead', async () => {
    const { client, calls } = fakeClient();
    const a = new ActionsRC(client);
    await a.pin('r1', 'm1');
    await a.markRead('r1');
    assert.deepEqual(calls[0], { path: 'chat.pinMessage', body: { messageId: 'm1' } });
    assert.deepEqual(calls[1], { path: 'subscriptions.read', body: { rid: 'r1' } });
  });

  test('unpin and star (set, remove)', async () => {
    const { client, calls } = fakeClient();
    const a = new ActionsRC(client);
    await a.unpin('r1', 'm1');
    await a.star('r1', 'm1', true);
    await a.star('r1', 'm1', false);
    assert.deepEqual(calls, [
      { path: 'chat.unPinMessage', body: { messageId: 'm1' } },
      { path: 'chat.starMessage', body: { messageId: 'm1' } },
      { path: 'chat.unStarMessage', body: { messageId: 'm1' } },
    ]);
  });

  test('listPinned / listStarred: one GET per list, normalised, most recent first', async () => {
    const read: { path: string; params: unknown }[] = [];
    const u = { _id: 'u1', username: 'alice' };
    const client = {
      get: async (path: string, options: { params?: unknown } = {}) => {
        read.push({ path, params: options.params });
        return {
          messages: [
            { _id: 'a', rid: 'r1', ts: '2026-01-01T00:00:00.000Z', msg: 'old', u, pinned: true },
            { _id: 'unreadable' },
            { _id: 'b', rid: 'r1', ts: '2026-02-01T00:00:00.000Z', msg: 'recent', u, pinned: true },
          ],
        };
      },
    } as unknown as RestClient;
    const a = new ActionsRC(client);
    const pinned = await a.listPinned('r1');
    await a.listStarred('r1');
    assert.deepEqual(
      pinned.map((m) => [m.id, m.text, m.pinned]),
      [
        ['b', 'recent', true],
        ['a', 'old', true],
      ],
    );
    assert.deepEqual(read, [
      { path: 'chat.getPinnedMessages', params: { roomId: 'r1', count: 50 } },
      { path: 'chat.getStarredMessages', params: { roomId: 'r1', count: 50 } },
    ]);
  });

  test('openOrCreateDm returns the rid AND the raw document to ingest', async () => {
    const room = { _id: 'dm1', t: 'd' };
    const { client, calls } = fakeClient({ room });
    const result = await new ActionsRC(client).openOrCreateDm('lea');
    assert.deepEqual(calls, [{ path: 'im.create', body: { username: 'lea' } }]);
    assert.deepEqual(result, { rid: 'dm1', rawRoom: room });
  });

  test('openOrCreateDm rejects a 200 without a usable room', async () => {
    // Response without `room`, then `room` without `_id`: the two abnormal shapes.
    await assert.rejects(new ActionsRC(fakeClient({}).client).openOrCreateDm('lea'));
    await assert.rejects(
      new ActionsRC(fakeClient({ room: { t: 'd' } }).client).openOrCreateDm('lea'),
    );
  });
});
