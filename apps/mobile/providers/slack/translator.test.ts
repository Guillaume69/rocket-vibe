import { shortcodeOfUnicode } from '../../lib/emojis.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlackClient } from './client.ts';
import { SlackDirectory } from './directory.ts';
import { messageId, mrkdwnToMarkdown, parseMessageId, SlackTranslator } from './translator.ts';
import { COOKIE, TOKEN, fakeSlack, message } from './testing.ts';

function setup() {
  const server = fakeSlack(() => undefined);
  const directory = new SlackDirectory(new SlackClient(TOKEN, COOKIE, { fetch: server.fetcher }), 'https://test.slack.com');
  directory.remember({ id: 'U000', username: 'me', displayName: 'Me Myself', avatar: null });
  directory.remember({ id: 'U001', username: 'alice', displayName: 'Alice A', avatar: 'https://avatars.example/a.png' });
  directory.remember({ id: 'U002', username: 'bob', displayName: null, avatar: null });
  const rooms = new Map([['C001', 'general']]);
  return { directory, translator: new SlackTranslator(directory, 'U000', rooms) };
}
/** `ui/messageOrder.ts`: `ts DESC, id DESC`, ids compared bytewise like SQLite. */
const newestFirst = (a: { ts: number; id: string }, b: { ts: number; id: string }) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const resolver = { username: (id: string) => ({ U001: 'alice' } as Record<string, string>)[id] ?? null, roomName: (id: string) => (id === 'C001' ? 'general' : null) };

test('mrkdwn: mentions, rooms, broadcasts, groups and links', () => {
  assert.equal(mrkdwnToMarkdown('hi <@U001> and <@U009|zed>', resolver), 'hi @alice and @zed');
  assert.equal(mrkdwnToMarkdown('<@U009>', resolver), '@U009');
  assert.equal(mrkdwnToMarkdown('in <#C001> <#C002|random> <#C003>', resolver), 'in #general #random #C003');
  assert.equal(mrkdwnToMarkdown('<!here> <!channel> <!everyone> <!subteam^S001|@devs>', resolver), '@here @all @all @devs');
  assert.equal(mrkdwnToMarkdown('see <https://example.test/a?b=1&amp;c=2|the doc> or <https://example.test>', resolver), 'see [the doc](https://example.test/a?b=1&c=2) or https://example.test');
  assert.equal(mrkdwnToMarkdown('<mailto:a@example.test|a@example.test>', resolver), '[a@example.test](mailto:a@example.test)');
});

test('mrkdwn: bold and strike rewritten, italic kept, escapes decoded last', () => {
  assert.equal(mrkdwnToMarkdown('*bold* _it_ ~gone~', resolver), '**bold** _it_ ~~gone~~');
  assert.equal(mrkdwnToMarkdown('*hi <@U001>*', resolver), '**hi @alice**');
  assert.equal(mrkdwnToMarkdown('2*3*4 and a*b', resolver), '2*3*4 and a*b');
  assert.equal(mrkdwnToMarkdown('a &lt;tag&gt; &amp;lt; b', resolver), 'a <tag> &lt; b');
});

test('mrkdwn: code spans and blocks stay untouched but decoded', () => {
  assert.equal(mrkdwnToMarkdown('`*x* <@U001>` then *y*', resolver), '`*x* <@U001>` then **y**');
  assert.equal(mrkdwnToMarkdown('```\n*keep* ~this~ &lt;b&gt;\n``` *out*', resolver), '```\n*keep* ~this~ <b>\n``` **out**');
});

test('a message keeps its exact id, its millisecond time and its edit', () => {
  const { translator } = setup();
  const row = translator.toMessage({ ...message('1780000000.123456', { text: 'hello <@U002>', edited: { user: 'U001', ts: '1780000060.000001' } }), channel: 'C001' })!;
  assert.equal(row.id, 'C001:1780000000.123456');
  assert.equal(row.rid, 'C001');
  assert.equal(row.ts, 1780000000123);
  assert.equal(row.text, 'hello @bob');
  assert.equal(row.authorId, 'U001');
  assert.equal(row.authorName, 'alice');
  assert.equal(row.md, null);
  assert.equal(row.editedAt, 1780000060000);
  assert.equal(row.updatedAt, 1780000060000);
  assert.deepEqual(parseMessageId(row.id), { channel: 'C001', ts: '1780000000.123456' });
  assert.equal(parseMessageId('C001:1780000000.5'), null);
  assert.equal(translator.toMessage(message('1780000000.123456')), null);
});

test('two messages in one millisecond stay distinct and in microsecond order', () => {
  const { translator } = setup();
  const a = translator.toMessage({ ...message('1780000000.000001'), channel: 'C001' })!;
  const b = translator.toMessage({ ...message('1780000000.000999'), channel: 'C001' })!;
  assert.equal(a.ts, b.ts);
  assert.notEqual(a.id, b.id);
  assert.deepEqual([a, b].sort(newestFirst).map((m) => m.id), [b.id, a.id]);
});

test('threads: a root counts its replies, a reply names its root, a broadcast shows in the room', () => {
  const { translator } = setup();
  const root = translator.toMessage({ ...message('1780000000.000100', { thread_ts: '1780000000.000100', reply_count: 3, latest_reply: '1780000300.000200' }), channel: 'C001' })!;
  assert.equal(root.threadId, null);
  assert.equal(root.threadCount, 3);
  assert.equal(root.threadLast, 1780000300000);
  const reply = translator.toMessage({ ...message('1780000100.000000', { thread_ts: '1780000000.000100' }), channel: 'C001' })!;
  assert.equal(reply.threadId, messageId('C001', '1780000000.000100'));
  assert.equal(reply.threadCount, 0);
  assert.equal(reply.threadShown, false);
  const broadcast = translator.toMessage({ ...message('1780000200.000000', { thread_ts: '1780000000.000100', subtype: 'thread_broadcast' }), channel: 'C001' })!;
  assert.equal(broadcast.threadShown, true);
});

test('subtypes: joins, leaves, topic and purpose as system rows; bots; hidden and tombstones skipped', () => {
  const { translator } = setup();
  const at = (over: Record<string, unknown>) => translator.toMessage({ ...message('1780000000.000001', over), channel: 'C001' });
  assert.deepEqual([at({ subtype: 'channel_join' })?.systemType, at({ subtype: 'channel_join' })?.text], ['uj', 'alice']);
  assert.equal(at({ subtype: 'channel_leave' })?.systemType, 'ul');
  assert.deepEqual([at({ subtype: 'channel_topic', topic: 'New topic' })?.systemType, at({ subtype: 'channel_topic', topic: 'New topic' })?.text], ['room_changed_topic', 'New topic']);
  assert.deepEqual([at({ subtype: 'channel_purpose', purpose: 'Why' })?.systemType, at({ subtype: 'channel_purpose', purpose: 'Why' })?.text], ['room_changed_description', 'Why']);
  const bot = at({ subtype: 'bot_message', user: undefined, bot_id: 'B001', username: 'deploybot', text: 'shipped' })!;
  assert.deepEqual([bot.authorId, bot.authorName, bot.systemType], ['B001', 'deploybot', null]);
  assert.equal(at({ hidden: true }), null);
  assert.equal(at({ subtype: 'tombstone' }), null);
});

test('files become attachments: image thumbnails, video and audio played from the file, other hosts left out', () => {
  const { translator } = setup();
  const pri = (id: string, name: string) => `https://files.slack.com/files-pri/T000-${id}/${name}`;
  const row = translator.toMessage({ ...message('1780000000.000001', { subtype: 'file_share', text: 'look', files: [
    { id: 'F001', name: 'a.png', mimetype: 'image/png', size: 10, original_w: 800, original_h: 600, url_private: pri('F001', 'a.png'), url_private_download: pri('F001', 'download/a.png'), thumb_360: 'https://files.slack.com/files-tmb/T000-F001-x/a_360.png' },
    { id: 'F002', name: 'b.mp4', mimetype: 'video/mp4', size: 20, url_private: pri('F002', 'b.mp4') },
    { id: 'F003', name: 'c.m4a', mimetype: 'audio/mp4', size: 30, url_private: pri('F003', 'c.m4a') },
    { id: 'F004', name: 'd.pdf', mimetype: 'application/pdf', size: 40, url_private: pri('F004', 'd.pdf') },
    { id: 'F005', name: 'gone', mode: 'tombstone', url_private: pri('F005', 'gone') },
    { id: 'F006', name: 'odd', url_private: 'https://evil.example/odd' },
  ] }), channel: 'C001' })!;
  assert.equal(row.text, 'look');
  const list = JSON.parse(row.attachments!) as Record<string, unknown>[];
  assert.deepEqual(list.map((a) => a.title), ['a.png', 'b.mp4', 'c.m4a', 'd.pdf']);
  assert.deepEqual([list[0]!.image_url, list[0]!.title_link, list[0]!.image_dimensions], ['https://files.slack.com/files-tmb/T000-F001-x/a_360.png', pri('F001', 'download/a.png'), { width: 800, height: 600 }]);
  assert.equal(list[1]!.video_url, pri('F002', 'b.mp4'));
  assert.equal(list[2]!.audio_url, pri('F003', 'c.m4a'));
  assert.deepEqual([list[3]!.title_link, list[3]!.image_url], [pri('F004', 'd.pdf'), undefined]);
});

test('reactions take the Rocket.Chat shape with usernames', () => {
  const { translator } = setup();
  const row = translator.toMessage({ ...message('1780000000.000001', { reactions: [{ name: 'thumbsup', users: ['U001', 'U002'], count: 2 }, { name: 'eyes', users: ['U009'], count: 1 }] }), channel: 'C001' })!;
  const thumbs = shortcodeOfUnicode('\u{1F44D}');
  assert.deepEqual(JSON.parse(row.reactions!), { [`:${thumbs}:`]: { usernames: ['alice', 'bob'] }, ':eyes:': { usernames: ['U009'] } }, "the app's own code for 👍");
});

test('rooms: kinds, DM names and a group DM named after its people', () => {
  const { translator } = setup();
  assert.equal(translator.toRoom({ channel: { id: 'C001', name: 'general', is_channel: true } })?.type, 'c');
  assert.equal(translator.toRoom({ channel: { id: 'G001', name: 'secret', is_private: true } })?.type, 'p');
  const dm = translator.toRoom({ channel: { id: 'D001', is_im: true, user: 'U001' }, counts: { id: 'D001', latest: '1780000000.000001' } })!;
  assert.deepEqual([dm.type, dm.name, dm.displayName, dm.dmOtherUid, dm.dmOtherUsername, dm.keepPreview, dm.lastMessageTs], ['d', 'alice', 'Alice A', 'U001', 'alice', true, 1780000000000]);
  const group = translator.toRoom({ channel: { id: 'G002', name: 'mpdm-me--alice--bob-1', is_mpim: true, is_private: true }, lastMessage: null })!;
  assert.deepEqual([group.type, group.displayName, group.keepPreview, group.lastMessage], ['d', 'Alice A, bob', false, null]);
  const withPreview = translator.toRoom({ channel: { id: 'C001', name: 'general' }, lastMessage: message('1780000000.000001', { text: '*hey*' }) })!;
  assert.deepEqual([withPreview.lastMessage, withPreview.lastMessageTs], ['**hey**', 1780000000000]);
});

test('subscriptions from client.counts, and none when it is missing', () => {
  const { translator } = setup();
  const sub = translator.toSubscription({ channel: { id: 'C001' }, counts: { id: 'C001', has_unreads: true, mention_count: 0, last_read: '1780000000.000001', latest: '1780000005.000000' } })!;
  assert.deepEqual([sub.subId, sub.alert, sub.unread, sub.mentions, sub.lastSeen, sub.open], ['C001', true, 1, 0, 1780000000000, true]);
  const mentioned = translator.toSubscription({ channel: { id: 'D001' }, counts: { id: 'D001', has_unreads: true, mention_count: 4, last_read: '0000000000.000000' } })!;
  assert.deepEqual([mentioned.unread, mentioned.mentions, mentioned.lastSeen], [4, 4, null]);
  const silent = translator.toSubscription({ channel: { id: 'C002' }, counts: null })!;
  assert.deepEqual([silent.unread, silent.mentions, silent.alert, silent.updatedAt], [0, 0, false, 0]);
});
