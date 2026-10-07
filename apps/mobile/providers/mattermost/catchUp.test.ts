import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SyncEngine } from '../../lib/sync.ts';
import { MmCatchUp } from './catchUp.ts';
import { MmClient } from './client.ts';
import { MmDirectory } from './directory.ts';
import { MmHistory } from './history.ts';
import { MmLive } from './live.ts';
import { fakeServer, memoryStore, post, postList, type Call } from './testing.ts';
import { MmTranslator } from './translator.ts';

const CHANNELS = [
  { id: 'ch1', type: 'O', name: 'dev', display_name: 'Dev', update_at: 5, last_post_at: 100, last_root_post_at: 100, total_msg_count: 4, total_msg_count_root: 3 },
  { id: 'd1', type: 'D', name: 'u-bob__u-me', update_at: 5, last_post_at: 90, total_msg_count: 1, total_msg_count_root: 1 },
];
const MEMBERS = [
  { channel_id: 'ch1', user_id: 'u-me', msg_count: 2, msg_count_root: 1, mention_count: 1 },
  { channel_id: 'd1', user_id: 'u-me', msg_count: 1, msg_count_root: 1, mention_count: 0 },
];

function setup(extra: (call: Call) => ReturnType<Parameters<typeof fakeServer>[0]> = () => undefined, deletedRoute = false) {
  const server = fakeServer((call) => {
    if (call.path === '/users/me/channels') return { body: CHANNELS };
    if (call.path === '/users/me/channel_members') return { body: MEMBERS };
    if (call.path === '/users/ids') return { body: [{ id: 'u-bob', username: 'bob' }] };
    if (call.path === '/channels/ch1/posts' && call.query.get('per_page') === '1') return { body: postList([post('last', { channel_id: 'ch1', create_at: 100 })]) };
    return extra(call) ?? { body: postList([]) };
  });
  const client = new MmClient(server.base, 'tok', { fetch: server.fetcher });
  const directory = new MmDirectory(client);
  directory.remember({ id: 'u-me', username: 'me', displayName: null, lastPictureUpdate: null });
  const live = new MmLive(client, directory, 'u-me');
  const history = new MmHistory(client, live);
  const local = memoryStore();
  const engine = new SyncEngine(local.store, new MmTranslator(directory, 'u-me'));
  const catchUp = new MmCatchUp({ client, directory, live, history, myId: 'u-me', deletedRoute });
  return { catchUp, engine, history, server, ...local };
}

describe('MmCatchUp', () => {
  test('global: rooms with previews, memberships with counters, DM peers resolved', async () => {
    const { catchUp, engine, rooms, subscriptions, cursors } = setup();
    await catchUp.global(engine, () => false);
    assert.equal(rooms.get('ch1')?.lastMessage, 'message last');
    assert.equal(rooms.get('d1')?.dmOtherUsername, 'bob');
    assert.equal(subscriptions.get('ch1')?.unread, 2);
    assert.equal(subscriptions.get('ch1')?.mentions, 1);
    assert.equal(cursors.get('*|mm-last-post'), 100);
  });

  test('global again with nothing new: no room is rewritten', async () => {
    const { catchUp, engine, rooms } = setup();
    await catchUp.global(engine, () => false);
    rooms.clear();
    await catchUp.global(engine, () => false);
    assert.equal(rooms.size, 0);
  });

  test('room: never loaded, nothing is asked', async () => {
    const { catchUp, engine, server } = setup();
    await catchUp.room(engine, 'ch1', () => false);
    assert.equal(server.calls.length, 0);
  });

  test('room: since the newest local post, edits ingested and deletions applied', async () => {
    const { catchUp, engine, messages, store } = setup((call) =>
      call.path === '/channels/ch1/posts' && call.query.get('since') === '10'
        ? { body: postList([post('p1', { channel_id: 'ch1', update_at: 20, message: 'edited' }), post('p2', { channel_id: 'ch1', delete_at: 15 })]) }
        : undefined,
    );
    await store.upsertMessage({ ...(new MmTranslator(new MmDirectory(new MmClient('http://x', null)), 'u-me').toMessage(post('p2', { channel_id: 'ch1', update_at: 10 })))! });
    await catchUp.room(engine, 'ch1', () => false);
    assert.equal(messages.get('p1')?.text, 'edited');
    assert.equal(messages.has('p2'), false);
  });

  test('reconcile: the live rooms are kept, the rest purged', async () => {
    const { catchUp, engine, purges } = setup();
    await catchUp.reconcile(engine, () => false);
    assert.deepEqual(purges[0]?.alive, ['ch1', 'd1']);
  });
});

describe('MmHistory', () => {
  test('the screen bound turns back into the id of the post seen at that instant', async () => {
    const { history, engine, server } = setup((call) => {
      if (call.path !== '/channels/ch1/posts') return undefined;
      if (call.query.get('before') === 'p50') return { body: postList([post('p49', { channel_id: 'ch1', create_at: 49 })]) };
      return { body: postList([post('p51', { channel_id: 'ch1', create_at: 51 }), post('p50', { channel_id: 'ch1', create_at: 50 })]) };
    });
    const first = await history.loadHistory(engine, 'ch1');
    assert.equal(first.oldest, 50);
    const older = await history.loadHistory(engine, 'ch1', new Date(50).toISOString());
    assert.equal(older.oldest, 49);
    assert.equal(server.calls.at(-1)?.query.get('collapsedThreads'), 'true');
  });
});
