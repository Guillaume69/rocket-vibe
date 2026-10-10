import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PresenceEngine } from '../../lib/presence.ts';
import { TypingEngine } from '../../lib/typing.ts';
import { MmCategories } from './categories.ts';
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
  test('typing and status changes reach the engines in their Rocket.Chat shapes', async () => {
    const { live } = setup();
    const presence = new PresenceEngine();
    for (const event of await live.expand('status_change', { user_id: 'u-bob', status: 'dnd' }, {})) presence.apply(event);
    assert.equal(presence.statusOf('u-bob'), 'busy');
    const typing = new TypingEngine({ rid: 'ch1', me: 'me', schedule: () => 0, cancel: () => {} });
    for (const event of await live.expand('typing', { user_id: 'u-bob', parent_id: '' }, { channel_id: 'ch1' })) typing.apply(event);
    assert.deepEqual(typing.whoIsTyping(), ['bob']);
  });

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

  test('a live reply brings its root back with fresh reply counters', async () => {
    const { live, server } = setup((call) =>
      call.path === '/posts/root1' ? { body: post('root1', { channel_id: 'ch1', reply_count: 4, last_reply_at: 900 }) } : undefined,
    );
    const reply = JSON.stringify(post('r9', { channel_id: 'ch1', root_id: 'root1', user_id: 'u-bob' }));
    const events = await live.expand('posted', { post: reply }, { channel_id: 'ch1' });
    const posts = events.filter((e) => e.collection === MM_POST).map((e) => (e.args[0] as { id: string; reply_count?: number }));
    assert.deepEqual(posts.map((p) => p.id), ['r9', 'root1']);
    assert.equal(posts[1]?.reply_count, 4);
    assert.equal(server.calls.filter((c) => c.path === '/posts/root1').length, 1);
  });

  test('a root post asks for nothing more', async () => {
    const { live, server } = setup();
    await live.expand('posted', { post: JSON.stringify(post('p5', { channel_id: 'ch1' })) }, { channel_id: 'ch1' });
    assert.equal(server.calls.some((c) => c.path.startsWith('/posts/')), false);
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

describe('sidebar categories', () => {
  test('a category event reads them again and rewrites every membership', async () => {
    let favorites: string[] = [];
    const server = fakeServer((call) => {
      if (call.path === '/users/me/teams') return { body: [{ id: 'T' }] };
      if (call.path === '/users/me/teams/T/channels/categories') {
        return { body: { categories: [{ id: 'fav', type: 'favorites', channel_ids: favorites }], order: ['fav'] } };
      }
      return undefined;
    });
    const client = new MmClient(server.base, 'tok', { fetch: server.fetcher });
    const directory = new MmDirectory(client);
    const categories = new MmCategories(client);
    const live = new MmLive(client, directory, 'u-me', categories);
    live.remember({ id: 'ch1', type: 'O', name: 'dev' }, { channel_id: 'ch1', user_id: 'u-me' });
    const translator = new MmTranslator(directory, 'u-me', categories);
    favorites = ['ch1'];
    const events = await live.expand('sidebar_category_updated', {}, { team_id: 'T' });
    assert.deepEqual(events.map((e) => e.collection), [MM_MEMBERSHIP]);
    assert.equal(translator.toSubscription(events[0]!.args[0] as Record<string, unknown>)?.favorite, true);
  });
});

describe('kChat reads made elsewhere', () => {
  test('badge_updated reads my memberships again and rewrites only the rooms that moved', async () => {
    const { live, translator } = setup((call) =>
      call.path === '/users/me/channel_members'
        ? { body: [{ channel_id: 'ch1', user_id: 'u-me', msg_count: 11, msg_count_root: 9, mention_count: 0, last_viewed_at: 99 }, { channel_id: 'other', msg_count: 1 }] }
        : undefined,
    );
    await live.expand('posted', { post: post('p9', { create_at: 50 }) }, {});
    const events = await live.expand('badge_updated', { badge: 0 }, {});
    assert.deepEqual(events.map((e) => [e.collection, e.eventKey]), [[MM_MEMBERSHIP, 'ch1']]);
    assert.equal(translator.toSubscription(events[0]!.args[0] as Record<string, unknown>)?.unread, 0);
    assert.deepEqual(await live.expand('badge_updated', { badge: 0 }, {}), []);
  });
});

describe('Preferences set elsewhere', () => {
  test('a new name format names the conversations again; a closed DM leaves the list', async () => {
    const server = fakeServer(() => undefined);
    const client = new MmClient(server.base, 'tok', { fetch: server.fetcher });
    const directory = new MmDirectory(client);
    directory.remember({ id: 'u-bob', username: 'bob', displayName: 'Bob Builder', lastPictureUpdate: null, fullName: 'Bob Builder', nickname: null });
    const categories = new MmCategories(client, 'u-me');
    const live = new MmLive(client, directory, 'u-me', categories);
    const translator = new MmTranslator(directory, 'u-me', categories);
    live.remember({ id: 'd1', type: 'D', name: 'u-bob__u-me', total_msg_count: 1, total_msg_count_root: 1 }, { channel_id: 'd1', user_id: 'u-me', msg_count: 1, msg_count_root: 1 });
    const renamed = await live.expand('preferences_changed', { preferences: JSON.stringify([{ category: 'display_settings', name: 'name_format', value: 'username' }]) }, {});
    assert.equal(translator.toRoom(renamed.find((e) => e.collection === MM_ROOM)!.args[0] as Record<string, unknown>)?.displayName, 'bob');
    const closed = await live.expand('preferences_changed', { preferences: [{ category: 'direct_channel_show', name: 'u-bob', value: 'false' }] }, {});
    assert.equal(translator.toSubscription(closed.find((e) => e.collection === MM_MEMBERSHIP)!.args[0] as Record<string, unknown>)?.open, false);
  });
});
