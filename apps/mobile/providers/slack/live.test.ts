import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { DdpEvent } from '../../lib/ddp.ts';
import { STREAM_NOTIFY_ROOM_TYPING } from '../../lib/typing.ts';
import { SlackClient } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { SlackHistory } from './history.ts';
import { SlackLive } from './live.ts';
import { SLACK_MESSAGE, SLACK_MESSAGE_DELETED, SLACK_ROOM, SLACK_SUBSCRIPTION } from './translator.ts';
import { AUTH, COOKIE, TOKEN, fakeSlack, historyOf } from './testing.ts';

const CHANNEL = { id: 'C1', name: 'general', is_channel: true };

function live(route: Parameters<typeof fakeSlack>[0] = () => undefined) {
  const { fetcher, calls } = fakeSlack((call) => (call.method === 'auth.test' ? { body: AUTH } : route(call)));
  const client = new SlackClient(TOKEN, COOKIE, { fetch: fetcher });
  const directory = new SlackDirectory(client, 'https://test.slack.com');
  const history = new SlackHistory(client, directory);
  const value = new SlackLive({ client, directory, history, myId: 'U000' });
  value.remember(CHANNEL, { id: 'C1', has_unreads: false, mention_count: 0, latest: '1.000000' });
  return { value, calls };
}

const collections = (events: DdpEvent[]) => events.map((e) => e.collection);

describe('SlackLive.expand', () => {
  test('a new message from another user upserts it, bumps the preview, raises unread', async () => {
    const { value } = live();
    const events = await value.expand({ type: 'message', channel: 'C1', ts: '2.000000', user: 'U001', text: 'hi' });
    assert.deepEqual(collections(events), [SLACK_MESSAGE, SLACK_ROOM, SLACK_SUBSCRIPTION]);
    const sub = events[2]!.args[0] as { counts: Record<string, unknown> };
    assert.equal(sub.counts.has_unreads, true);
    const room = events[1]!.args[0] as { lastMessage?: unknown };
    assert.ok(room.lastMessage);
  });

  test('my own message bumps the preview but never unread', async () => {
    const { value } = live();
    const events = await value.expand({ type: 'message', channel: 'C1', ts: '2.000000', user: 'U000', text: 'mine' });
    assert.deepEqual(collections(events), [SLACK_MESSAGE, SLACK_ROOM]);
  });

  test('a mention of me increments the mention count', async () => {
    const { value } = live();
    const events = await value.expand({ type: 'message', channel: 'C1', ts: '2.000000', user: 'U001', text: 'hey <@U000>' });
    const sub = events[2]!.args[0] as { counts: Record<string, unknown> };
    assert.equal(sub.counts.mention_count, 1);
  });

  test('a reply does not become the room preview', async () => {
    const { value } = live();
    const events = await value.expand({ type: 'message', channel: 'C1', ts: '2.000500', thread_ts: '2.000000', user: 'U001', text: 're' });
    const room = events.find((e) => e.collection === SLACK_ROOM)!;
    assert.equal((room.args[0] as { lastMessage?: unknown }).lastMessage, undefined);
  });

  test('message_changed replaces the message only, no preview or unread move', async () => {
    const { value } = live();
    const events = await value.expand({
      type: 'message',
      subtype: 'message_changed',
      channel: 'C1',
      ts: '3.000000',
      message: { type: 'message', ts: '2.000000', user: 'U001', text: 'edited', edited: { ts: '3.000000' } },
    });
    assert.deepEqual(collections(events), [SLACK_MESSAGE]);
    assert.equal((events[0]!.args[0] as { text: string }).text, 'edited');
  });

  test('message_deleted tombstones the deleted ts', async () => {
    const { value } = live();
    const events = await value.expand({ type: 'message', subtype: 'message_deleted', channel: 'C1', ts: '3.000000', deleted_ts: '2.000000' });
    assert.deepEqual(collections(events), [SLACK_MESSAGE_DELETED]);
    assert.equal((events[0]!.args[0] as { ts: string }).ts, '2.000000');
  });

  test('a marked frame overwrites the unread counts', async () => {
    const { value } = live();
    const events = await value.expand({ type: 'channel_marked', channel: 'C1', ts: '2.000000', unread_count_display: 0, mention_count_display: 0 });
    assert.deepEqual(collections(events), [SLACK_SUBSCRIPTION]);
    const counts = (events[0]!.args[0] as { counts: Record<string, unknown> }).counts;
    assert.equal(counts.has_unreads, false);
    assert.equal(counts.last_read, '2.000000');
  });

  test('a reaction re-reads the one message it touched', async () => {
    const stored = [{ type: 'message', ts: '2.000000', user: 'U001', text: 'hi', reactions: [{ name: 'tada', users: ['U001'] }] }];
    const { value, calls } = live((call) => (call.method === 'conversations.history' ? { body: historyOf(stored, call.args) } : undefined));
    const events = await value.expand({ type: 'reaction_added', user: 'U002', reaction: 'tada', item: { type: 'message', channel: 'C1', ts: '2.000000' } });
    assert.deepEqual(collections(events), [SLACK_MESSAGE]);
    assert.ok(calls.some((c) => c.method === 'conversations.history'));
  });

  test('user_typing names the typist for the typing indicator', async () => {
    const { value } = live((call) => (call.method === 'users.info' ? { body: { ok: true, user: { id: 'U001', name: 'bob' } } } : undefined));
    const events = await value.expand({ type: 'user_typing', channel: 'C1', user: 'U001', id: 1 });
    assert.deepEqual(collections(events), [STREAM_NOTIFY_ROOM_TYPING]);
    assert.equal(events[0]!.eventKey, 'C1/user-activity');
    assert.equal(events[0]!.args[0], 'bob');
  });

  test('my own typing frame is dropped', async () => {
    const { value } = live();
    assert.deepEqual(await value.expand({ type: 'user_typing', channel: 'C1', user: 'U000', id: 1 }), []);
  });

  test('an unknown event is counted quiet, never raw', async () => {
    const { value } = live();
    const events = await value.expand({ type: 'dnd_updated', user: 'U000' });
    assert.equal(events[0]!.collection, 'slack:quiet');
  });
});
