import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MmClient } from './client.ts';
import { MmDirectory } from './directory.ts';
import { MmLive } from './live.ts';
import { fakeServer, post } from './testing.ts';
import { MM_MEMBERSHIP, MM_POST, MM_ROOM, MM_ROOM_DELETED, MmTranslator } from './translator.ts';

function setup(route: Parameters<typeof fakeServer>[0] = () => undefined) {
  const server = fakeServer(route);
  const client = new MmClient(server.base, 'tok', { fetch: server.fetcher });
  const directory = new MmDirectory(client);
  directory.remember({ id: 'u-me', username: 'me', displayName: null, lastPictureUpdate: null });
  directory.remember({ id: 'u-bob', username: 'bob', displayName: null, lastPictureUpdate: null });
  const live = new MmLive(client, directory, 'u-me');
  live.remember(
    { id: 'ch1', type: 'O', name: 'dev', total_msg_count: 10, total_msg_count_root: 8 },
    { channel_id: 'ch1', user_id: 'u-me', msg_count: 10, msg_count_root: 8, mention_count: 0 },
  );
  return { live, server, translator: new MmTranslator(directory, 'u-me') };
}

const membership = (events: { collection: string; args: unknown[] }[]) =>
  events.find((e) => e.collection === MM_MEMBERSHIP)?.args[0] as { member: Record<string, unknown> };

describe('MmLive.expand', () => {
  test("someone else's root post: message, room preview, one more unread", async () => {
    const { live, translator } = setup();
    const events = await live.expand('posted', { post: JSON.stringify(post('p1', { create_at: 50 })), mentions: '["u-me"]' }, { channel_id: 'ch1' });
    assert.deepEqual(events.map((e) => e.collection), [MM_POST, MM_ROOM, MM_MEMBERSHIP]);
    const sub = translator.toSubscription(events[2]!.args[0] as Record<string, unknown>);
    assert.equal(sub?.unread, 1);
    assert.equal(sub?.mentions, 1);
    const room = translator.toRoom(events[1]!.args[0] as Record<string, unknown>);
    assert.equal(room?.lastMessage, 'message p1');
  });

  test('a reply leaves the room preview alone and adds no root unread', async () => {
    const { live, translator } = setup();
    const events = await live.expand('posted', { post: post('p2', { root_id: 'p1' }) }, {});
    assert.deepEqual(events.map((e) => e.collection), [MM_POST, MM_MEMBERSHIP]);
    assert.equal(translator.toSubscription(events[1]!.args[0] as Record<string, unknown>)?.unread, 0);
  });

  test('my own post keeps the room read', async () => {
    const { live } = setup();
    const events = await live.expand('posted', { post: post('p3', { user_id: 'u-me' }) }, {});
    assert.equal(membership(events).member.msg_count_root, 9);
  });

  test('a view resets unread and mentions', async () => {
    const { live } = setup();
    await live.expand('posted', { post: post('p1'), mentions: ['u-me'] }, {});
    const events = await live.expand('multiple_channels_viewed', { channel_times: { ch1: 99 } }, {});
    assert.equal(membership(events).member.mention_count, 0);
    assert.equal(membership(events).member.msg_count_root, 9);
  });

  test('a reaction refetches its post', async () => {
    const { live, server } = setup((call) =>
      call.path === '/posts/p1' ? { body: post('p1', { metadata: { reactions: [{ user_id: 'u-bob', emoji_name: 'tada' }] } }) } : undefined,
    );
    const events = await live.expand('reaction_added', { reaction: '{"post_id":"p1","emoji_name":"tada"}' }, {});
    assert.equal(server.calls[0]?.path, '/posts/p1');
    assert.equal(events[0]?.collection, MM_POST);
  });

  test('a post in an unknown channel loads it first', async () => {
    const { live, server } = setup((call) => {
      if (call.path === '/channels/new') return { body: { id: 'new', type: 'O', total_msg_count: 0, total_msg_count_root: 0 } };
      if (call.path === '/channels/new/members/me') return { body: { channel_id: 'new', msg_count: 0, msg_count_root: 0, mention_count: 0 } };
      return undefined;
    });
    const events = await live.expand('posted', { post: post('p4', { channel_id: 'new' }) }, {});
    assert.ok(server.calls.some((c) => c.path === '/channels/new'));
    assert.equal(events.length, 3);
  });

  test('being removed from a room deletes it; someone else leaving does not', async () => {
    const { live } = setup();
    assert.deepEqual(await live.expand('user_removed', { user_id: 'u-bob' }, { channel_id: 'ch1' }), []);
    const events = await live.expand('user_removed', { user_id: 'u-me' }, { channel_id: 'ch1' });
    assert.equal(events[0]?.collection, MM_ROOM_DELETED);
  });
});
