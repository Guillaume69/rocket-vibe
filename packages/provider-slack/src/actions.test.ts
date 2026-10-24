import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SlackActions, reactionName } from './actions.ts';
import { SlackClient, SlackError } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { SlackHistory } from './history.ts';
import { SlackLive } from './live.ts';
import { SlackSaved } from './saved.ts';
import { COOKIE, TOKEN, fakeSlack, historyOf, message, type SlackAnswer, type SlackCall } from './testing.ts';
import { SLACK_STARRED, SlackTranslator, markdownToMrkdwn } from './translator.ts';

function setup(route: (call: SlackCall) => SlackAnswer | undefined = () => ({ body: { ok: true } })) {
  const server = fakeSlack(route);
  const client = new SlackClient(TOKEN, COOKIE, { fetch: server.fetcher });
  const directory = new SlackDirectory(client, 'https://test.slack.com');
  directory.remember({ id: 'U001', username: 'alice', displayName: null, avatar: null });
  const history = new SlackHistory(client, directory);
  const live = new SlackLive({ client, directory, history, myId: 'U000' });
  live.remember({ id: 'C001', name: 'general' }, { id: 'C001', latest: '1780000000.000500' });
  const saved = new SlackSaved(client, history);
  const translator = new SlackTranslator(directory, 'U000', new Map(), saved.ids);
  return { actions: new SlackActions({ client, directory, history, live, translator, saved }), server, saved, live };
}

const MID = 'C001:1780000000.000100';

describe('SlackActions', () => {
  test('room information comes from conversations.info and a channel renames itself', async () => {
    const { actions, server } = setup((call) => call.method === 'conversations.info'
      ? { body: { ok: true, channel: call.args.channel === 'C001'
        ? { id: 'C001', name: 'general', is_private: false, num_members: 4, topic: { value: 'News' }, purpose: { value: '' } }
        : { id: 'D001', is_im: true, user: 'U001' } } }
      : { body: { ok: true } });
    const info = await actions.roomInfo('C001');
    assert.deepEqual([info.name, info.type, info.topic, info.description, info.members], ['general', 'c', 'News', null, 4]);
    assert.deepEqual(await actions.editableSettings('C001'), { name: true, texts: false, readOnly: false });
    assert.equal(await actions.editableSettings('D001'), null);
    await actions.saveRoomSettings('C001', { name: 'announcements' });
    const rename = server.calls.find((c) => c.method === 'conversations.rename');
    assert.deepEqual([rename?.args.channel, rename?.args.name], ['C001', 'announcements']);
  });

  test('edit and delete target the exact channel and ts', async () => {
    const { actions, server } = setup();
    await actions.edit('C001', MID, '~~old~~ new');
    await actions.delete('C001', MID);
    assert.deepEqual(server.calls.map((c) => [c.method, c.args.channel, c.args.ts]), [
      ['chat.update', 'C001', '1780000000.000100'],
      ['chat.delete', 'C001', '1780000000.000100'],
    ]);
    assert.equal(server.calls[0]!.args.text, '~old~ new');
  });

  test('a message of another room is refused before any request', async () => {
    const { actions, server } = setup();
    await assert.rejects(actions.edit('C002', MID, 'x'), (e) => e instanceof SlackError && e.code === 'message_not_found');
    assert.equal(server.calls.length, 0);
  });

  test('a reaction goes by bare name; the state already there settles it', async () => {
    const { actions, server } = setup((call) => ({ body: call.method === 'reactions.remove' ? { ok: false, error: 'no_reaction' } : { ok: true } }));
    await actions.react('C001', MID, ':+1:', true);
    await actions.react('C001', MID, 'tada', false);
    assert.deepEqual(server.calls.map((c) => [c.method, c.args.name, c.args.timestamp]), [
      ['reactions.add', '+1', '1780000000.000100'],
      ['reactions.remove', 'tada', '1780000000.000100'],
    ]);
  });

  test('mark read goes to the message shown, else the newest known, and never backwards', async () => {
    const { actions, server } = setup();
    await actions.markRead('C001');
    await actions.markRead('C001', { messageId: MID, adhesion: '' });
    await actions.markRead('C001');
    assert.deepEqual(server.calls.map((c) => c.args.ts), ['1780000000.000500']);
  });

  test('a room marked unread elsewhere is marked read again', async () => {
    const { actions, server, live } = setup();
    await actions.markRead('C001');
    await live.expand({ type: 'channel_marked', channel: 'C001', ts: '1780000000.000100', unread_count_display: 1 });
    await actions.markRead('C001');
    assert.deepEqual(server.calls.map((c) => c.args.ts), ['1780000000.000500', '1780000000.000500']);
  });

  test('pin and unpin by channel and timestamp; the state already there settles it', async () => {
    const { actions, server } = setup((call) => ({ body: call.method === 'pins.add' ? { ok: false, error: 'already_pinned' } : { ok: true } }));
    await actions.pin('C001', MID);
    await actions.unpin('C001', MID);
    assert.deepEqual(server.calls.map((c) => [c.method, c.args.channel, c.args.timestamp]), [
      ['pins.add', 'C001', '1780000000.000100'],
      ['pins.remove', 'C001', '1780000000.000100'],
    ]);
  });

  test('the pinned list keeps messages, translated and pinned, newest first', async () => {
    const { actions, server } = setup((call) => call.method === 'pins.list'
      ? { body: { ok: true, items: [
        { type: 'message', created_by: 'U001', message: message('1780000000.000100', { pinned_to: ['C001'] }) },
        { type: 'file', file: { id: 'F1' } },
        { type: 'message', created_by: 'U001', message: message('1780000000.000300', { pinned_to: ['C001'] }) },
      ] } }
      : { body: { ok: true } });
    const list = await actions.listPinned('C001');
    assert.deepEqual(list.map((m) => [m.id, m.pinned]), [['C001:1780000000.000300', true], ['C001:1780000000.000100', true]]);
    assert.deepEqual(server.calls[0]!.args, { channel: 'C001' });
  });

  test('a star saves the message for later; a missing save on removal is settled', async () => {
    const { actions, server, saved } = setup((call) => ({ body: call.method === 'saved.delete' ? { ok: false, error: 'not_found' } : { ok: true } }));
    await actions.star('C001', MID, true);
    assert.ok(saved.ids.has(MID));
    await actions.star('C001', MID, false);
    assert.equal(saved.ids.has(MID), false);
    assert.deepEqual(server.calls.map((c) => [c.method, c.args.item_type, c.args.item_id, c.args.ts]), [
      ['saved.add', 'message', 'C001', '1780000000.000100'],
      ['saved.delete', 'message', 'C001', '1780000000.000100'],
    ]);
  });

  test("the starred list: that room's saves, each read back, a thread reply from its thread", async () => {
    const room = [message('1780000000.000100'), message('1780000000.000300')];
    const { actions, server } = setup((call) => {
      if (call.method === 'saved.list') return { body: { ok: true, saved_items: [
        { item_id: 'C001', item_type: 'message', ts: '1780000000.000100' },
        { item_id: 'C002', item_type: 'message', ts: '1780000000.000200' },
        { item_id: 'C001', item_type: 'message', ts: '1780000000.000900' },
        { item_id: 'C001', item_type: 'message', ts: '1780000000.000300', state: 'completed' },
      ] } };
      if (call.method === 'conversations.history') return { body: historyOf(room, call.args) };
      if (call.method === 'conversations.replies') return { body: { ok: true, messages: [message('1780000000.000050'), message('1780000000.000900', { thread_ts: '1780000000.000050' })] } };
      return undefined;
    });
    const list = await actions.listStarred('C001');
    assert.deepEqual(list.map((m) => [m.id, m.starred, m.threadId]), [
      ['C001:1780000000.000900', '["U000"]', 'C001:1780000000.000050'],
      ['C001:1780000000.000100', '["U000"]', null],
    ]);
    const replies = server.calls.find((c) => c.method === 'conversations.replies')!;
    assert.deepEqual([replies.args.ts, replies.args.oldest, replies.args.latest, replies.args.inclusive], ['1780000000.000900', '1780000000.000900', '1780000000.000900', 'true']);
  });

  test('a save reset rewrites only the messages whose save moved', async () => {
    const { saved } = setup((call) => call.method === 'saved.list'
      ? { body: { ok: true, saved_items: [{ item_id: 'C001', item_type: 'message', ts: '1780000000.000100' }] } }
      : undefined);
    saved.mark('C001:1780000000.000200', true);
    saved.mark('C001:1780000000.000100', true);
    const events = await saved.reset();
    assert.deepEqual(events.map((e) => [e.collection, e.args[0]]), [[SLACK_STARRED, { id: 'C001:1780000000.000200', on: false }]]);
    assert.deepEqual([...saved.ids], ['C001:1780000000.000100']);
  });

  test('DMs still refuse', async () => {
    const { actions } = setup();
    await assert.rejects(actions.openOrCreateDm('alice'), SlackError);
  });
});

describe('reactionName', () => {
  test('strips the shortcode colons', () => {
    assert.equal(reactionName(':thumbsup:'), 'thumbsup');
    assert.equal(reactionName('eyes'), 'eyes');
  });
});

describe('markdownToMrkdwn', () => {
  const idOf = (u: string) => (u === 'alice' ? 'U001' : null);
  test('bold, italic, strike, links and mentions', () => {
    assert.equal(markdownToMrkdwn('**b** *i* ~~s~~', idOf), '*b* _i_ ~s~');
    assert.equal(markdownToMrkdwn('see [docs](https://x.test/a) @alice @bob @here @all', idOf), 'see <https://x.test/a|docs> <@U001> @bob <!here> <!channel>');
  });
  test('code keeps its text, and Slack entities are escaped everywhere, code included', () => {
    assert.equal(markdownToMrkdwn('a < b & `<@x> **y**`', idOf), 'a &lt; b &amp; `&lt;@x&gt; **y**`');
    assert.equal(markdownToMrkdwn('`Vec<String>` and ```\n<!here> a && b\n```', idOf), '`Vec&lt;String&gt;` and ```\n&lt;!here&gt; a &amp;&amp; b\n```');
    assert.equal(markdownToMrkdwn('mail me@alice.test, thanks @alice.', idOf), 'mail me@alice.test, thanks <@U001>.');
    assert.equal(markdownToMrkdwn('2*3*4 stays', idOf), '2*3*4 stays');
  });
});
