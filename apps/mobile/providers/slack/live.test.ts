import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { DdpEvent } from '../../lib/ddp.ts';
import { PRESENCE_EVENT, STREAM_NOTIFY_LOGGED } from '../../lib/presence.ts';
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

  test('a reply only in its thread moves neither the preview, the latest ts nor the unread', async () => {
    const { value } = live();
    const events = await value.expand({ type: 'message', channel: 'C1', ts: '2.000500', thread_ts: '2.000000', user: 'U001', text: 're' });
    assert.deepEqual(collections(events), [SLACK_MESSAGE]);
    assert.deepEqual(value.counts.get('C1'), { id: 'C1', has_unreads: false, mention_count: 0, latest: '1.000000' });
  });

  test('a thread reply naming me counts the mention, the room left read', async () => {
    const { value } = live();
    const events = await value.expand({ type: 'message', channel: 'C1', ts: '2.000500', thread_ts: '2.000000', user: 'U001', text: 'hey <@U000>' });
    assert.deepEqual(collections(events), [SLACK_MESSAGE, SLACK_SUBSCRIPTION]);
    const counts = (events[1]!.args[0] as { counts: Record<string, unknown> }).counts;
    assert.deepEqual([counts.has_unreads, counts.mention_count, counts.latest], [false, 1, '1.000000']);
  });

  test('a reply also sent to the room counts as a room message, never as its preview', async () => {
    const { value } = live();
    const events = await value.expand({ type: 'message', subtype: 'thread_broadcast', channel: 'C1', ts: '2.000500', thread_ts: '2.000000', user: 'U001', text: 're' });
    assert.deepEqual(collections(events), [SLACK_MESSAGE, SLACK_ROOM, SLACK_SUBSCRIPTION]);
    assert.equal((events[1]!.args[0] as { lastMessage?: unknown }).lastMessage, undefined);
  });

  test('message_replied and other hidden frames are no new message', async () => {
    const { value } = live();
    const replied = await value.expand({
      type: 'message', subtype: 'message_replied', hidden: true, channel: 'C1', ts: '3.000000',
      message: { type: 'message', ts: '2.000000', user: 'U001', text: 'root', reply_count: 1 },
    });
    const hidden = await value.expand({ type: 'message', subtype: 'channel_name', hidden: true, channel: 'C1', ts: '3.000001', user: 'U001' });
    assert.deepEqual([...replied, ...hidden], []);
    assert.equal(value.counts.get('C1')?.latest, '1.000000');
  });

  test('message_changed of an older message replaces it only, no preview or unread move', async () => {
    const { value } = live();
    const events = await value.expand({
      type: 'message',
      subtype: 'message_changed',
      channel: 'C1',
      ts: '3.000000',
      message: { type: 'message', ts: '0.500000', user: 'U001', text: 'edited', edited: { ts: '3.000000' } },
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

  test('a marked frame moves the mark the actions start from, backwards too', async () => {
    const { value } = live();
    value.marks.set('C1', '5.000000');
    await value.expand({ type: 'channel_marked', channel: 'C1', ts: '2.000000', unread_count_display: 1 });
    assert.equal(value.marks.get('C1'), '2.000000');
  });

  test('a reaction on a thread reply re-reads it from its thread', async () => {
    const reply = { type: 'message', ts: '2.000500', thread_ts: '2.000000', user: 'U001', text: 're', reactions: [{ name: 'tada', users: ['U001'] }] };
    const { value } = live((call) => {
      if (call.method === 'conversations.history') return { body: historyOf([], call.args) };
      if (call.method === 'conversations.replies') return { body: { ok: true, messages: [reply], has_more: false } };
      return undefined;
    });
    const events = await value.expand({ type: 'reaction_added', user: 'U002', reaction: 'tada', item: { type: 'message', channel: 'C1', ts: '2.000500' } });
    assert.deepEqual(collections(events), [SLACK_MESSAGE]);
    assert.equal((events[0]!.args[0] as { ts: string }).ts, '2.000500');
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

describe('SlackLive new conversations', () => {
  const info = (channels: Record<string, Record<string, unknown>>) => (call: { method: string; args: Record<string, string> }) => {
    if (call.method === 'users.info') return { body: { ok: true, user: { id: call.args.user, name: 'alice' } } };
    if (call.method !== 'conversations.info') return undefined;
    const channel = channels[call.args.channel!];
    return { body: channel === undefined ? { ok: false, error: 'channel_not_found' } : { ok: true, channel } };
  };

  test('a joined or opened conversation is read and listed', async () => {
    const { value } = live(info({ D9: { id: 'D9', is_im: true, user: 'U009' }, C9: { id: 'C9', name: 'new', is_channel: true, is_member: true }, G9: { id: 'G9', name: 'mpdm-a--b-1', is_mpim: true } }));
    const im = await value.expand({ type: 'im_created', user: 'U000', channel: { id: 'D9' } });
    const channel = await value.expand({ type: 'channel_joined', channel: { id: 'C9', name: 'new' } });
    const mpim = await value.expand({ type: 'mpim_open', user: 'U000', channel: 'G9' });
    assert.deepEqual([...im, ...channel, ...mpim].map((e) => [e.collection, e.eventKey]), [
      [SLACK_ROOM, 'D9'], [SLACK_SUBSCRIPTION, 'D9'], [SLACK_ROOM, 'C9'], [SLACK_SUBSCRIPTION, 'C9'], [SLACK_ROOM, 'G9'], [SLACK_SUBSCRIPTION, 'G9'],
    ]);
    assert.ok(value.channels.has('D9'));
    assert.deepEqual(value.presenceIds(), ['U000', 'U009']);
  });

  test('a channel someone else created is not mine to list', async () => {
    const { value, calls } = live(info({ C9: { id: 'C9', name: 'new', is_channel: true } }));
    assert.deepEqual(await value.expand({ type: 'channel_created', channel: { id: 'C9', name: 'new', creator: 'U001' } }), []);
    assert.ok(!calls.some((c) => c.method === 'conversations.info'));
    const mine = await value.expand({ type: 'channel_created', channel: { id: 'C9', name: 'new', creator: 'U000' } });
    assert.deepEqual(collections(mine), [SLACK_ROOM, SLACK_SUBSCRIPTION]);
  });

  test('a message in a room not known yet brings the room, then counts as unread', async () => {
    const { value, calls } = live(info({ C9: { id: 'C9', name: 'new', is_channel: true, is_member: true } }));
    const events = await value.expand({ type: 'message', channel: 'C9', ts: '2.000000', user: 'U001', text: 'hi' });
    assert.deepEqual(collections(events), [SLACK_ROOM, SLACK_SUBSCRIPTION, SLACK_MESSAGE, SLACK_ROOM, SLACK_SUBSCRIPTION]);
    assert.equal((events[4]!.args[0] as { counts: Record<string, unknown> }).counts.has_unreads, true);
    const unknown = await value.expand({ type: 'message', channel: 'C8', ts: '2.000000', user: 'U001', text: 'hi' });
    await value.expand({ type: 'message', channel: 'C8', ts: '2.000001', user: 'U001', text: 'hi' });
    assert.deepEqual(collections(unknown), [SLACK_MESSAGE]);
    assert.equal(calls.filter((c) => c.method === 'conversations.info' && c.args.channel === 'C8').length, 1);
  });
});

describe('SlackLive presence and pins', () => {
  test('presence_change maps active to online and away to away, batched or single; my manual change too', async () => {
    const { value } = live();
    const one = await value.expand({ type: 'presence_change', user: 'U001', presence: 'active' });
    const many = await value.expand({ type: 'presence_change', users: ['U002', 'U003'], presence: 'away' });
    const mine = await value.expand({ type: 'manual_presence_change', presence: 'away' });
    assert.deepEqual([...one, ...many, ...mine].map((e) => [e.collection, e.eventKey, (e.args[0] as unknown[])[0], (e.args[0] as unknown[])[2]]), [
      [STREAM_NOTIFY_LOGGED, PRESENCE_EVENT, 'U001', 1],
      [STREAM_NOTIFY_LOGGED, PRESENCE_EVENT, 'U002', 2],
      [STREAM_NOTIFY_LOGGED, PRESENCE_EVENT, 'U003', 2],
      [STREAM_NOTIFY_LOGGED, PRESENCE_EVENT, 'U000', 2],
    ]);
    assert.deepEqual([...value.presence], [['U001', 'online'], ['U002', 'away'], ['U003', 'away'], ['U000', 'away']]);
    assert.deepEqual(await value.expand({ type: 'presence_change', user: 'U001', presence: 'unknown' }), []);
  });

  test('presence follows me and my direct conversations', () => {
    const { value } = live();
    value.remember({ id: 'D1', is_im: true, user: 'U007' }, null);
    value.remember({ id: 'G1', is_mpim: true, name: 'mpdm-a--b-1' }, null);
    assert.deepEqual(value.presenceIds(), ['U000', 'U007']);
  });

  test('pin_added and pin_removed rewrite the message with its pinned state', async () => {
    const { value } = live();
    const item = (pinned: string[]) => ({ type: 'message', channel: 'C1', message: { type: 'message', ts: '2.000000', user: 'U001', text: 'x', pinned_to: pinned } });
    const added = await value.expand({ type: 'pin_added', channel_id: 'C1', item: item([]) });
    const removed = await value.expand({ type: 'pin_removed', channel_id: 'C1', item: item(['C1', 'C9']) });
    assert.deepEqual([...added, ...removed].map((e) => [e.collection, (e.args[0] as Record<string, unknown>).channel, (e.args[0] as Record<string, unknown>).pinned_to]), [
      [SLACK_MESSAGE, 'C1', ['C1']],
      [SLACK_MESSAGE, 'C1', ['C9']],
    ]);
  });
});
