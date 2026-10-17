import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { reactionList } from '../../lib/reactions.ts';
import { MmClient } from './client.ts';
import { MmDirectory } from './directory.ts';
import { post } from './testing.ts';
import { MM_POST, MM_QUIET, MmTranslator, ephemeralNote, membershipCounts, mentionedUsernames, permalinkPosts, record } from './translator.ts';
import { quoteText } from '../../lib/quote.ts';
import { integrationCard } from '../../lib/integrationCards.ts';
import { reminderAcknowledgement } from '../../lib/reminder.ts';
import { reminderFormatter, translate } from '../../ui/messages.ts';

function translator() {
  const directory = new MmDirectory(new MmClient('http://mm.test', 't'));
  directory.remember({ id: 'u-me', username: 'me', displayName: 'Me Myself', lastPictureUpdate: null });
  directory.remember({ id: 'u-bob', username: 'bob', displayName: 'Bob Builder', lastPictureUpdate: null });
  directory.remember({ id: 'u-euria', username: 'euria', displayName: 'Euria', lastPictureUpdate: null, bot: true });
  return new MmTranslator(directory, 'u-me');
}

describe('MmTranslator.toMessage', () => {
  test('a plain post carries its author by username and its server times', () => {
    const m = translator().toMessage(post('p1', { create_at: 10, update_at: 20, edit_at: 15 }));
    assert.equal(m?.authorName, 'bob');
    assert.equal(m?.ts, 10);
    assert.equal(m?.updatedAt, 20);
    assert.equal(m?.editedAt, 15);
    assert.equal(m?.threadId, null);
  });

  test('a reply points at its root; a root carries its thread counters', () => {
    const t = translator();
    assert.equal(t.toMessage(post('p2', { root_id: 'p1' }))?.threadId, 'p1');
    const root = t.toMessage(post('p1', { reply_count: 3, last_reply_at: 50 }));
    assert.equal(root?.threadCount, 3);
    assert.equal(root?.threadLast, 50);
  });

  test('a deleted post is not a message', () => {
    assert.equal(translator().toMessage(post('p1', { delete_at: 5 })), null);
  });

  test('system posts map onto the types the renderer knows', () => {
    const joined = translator().toMessage(post('p1', { type: 'system_join_channel', props: { username: 'bob' } }));
    assert.equal(joined?.systemType, 'uj');
    assert.equal(joined?.text, 'bob');
    const header = translator().toMessage(post('p2', { type: 'system_header_change', props: { new_header: 'news' } }));
    assert.equal(header?.systemType, 'room_changed_topic');
    assert.equal(header?.text, 'news');
  });

  test('reactions group by emoji with usernames, readable by `reactionList`', () => {
    const m = translator().toMessage(post('p1', {
      metadata: { reactions: [
        { user_id: 'u-me', emoji_name: '+1' },
        { user_id: 'u-bob', emoji_name: '+1' },
        { user_id: 'u-bob', emoji_name: 'smile' },
      ] },
    }));
    const list = reactionList(m?.reactions ?? null, 'me');
    assert.deepEqual(list.find((r) => r.code === '+1'), { code: '+1', total: 2, byMe: true });
    assert.deepEqual(list.find((r) => r.code === 'smile'), { code: 'smile', total: 1, byMe: false });
  });

  test('files become attachments on the file API, images with their preview', () => {
    const m = translator().toMessage(post('p1', {
      metadata: { files: [
        { id: 'f1', name: 'cat.png', mime_type: 'image/png', size: 9, width: 4, height: 3, has_preview_image: true },
        { id: 'f2', name: 'doc.pdf', mime_type: 'application/pdf', size: 7 },
      ] },
    }));
    const [image, doc] = JSON.parse(m?.attachments ?? '[]');
    assert.equal(image.image_url, '/api/v4/files/f1/preview');
    assert.deepEqual(image.image_dimensions, { width: 4, height: 3 });
    assert.equal(doc.title_link, '/api/v4/files/f2');
    assert.equal(doc.image_url, undefined);
  });
});

describe('MmTranslator rooms and memberships', () => {
  test('a DM is named after the other user, never me', () => {
    const room = translator().toRoom({ channel: { id: 'd1', type: 'D', name: 'u-bob__u-me', update_at: 1 } });
    assert.equal(room?.type, 'd');
    assert.equal(room?.dmOtherUid, 'u-bob');
    assert.equal(room?.dmOtherUsername, 'bob');
    assert.equal(room?.displayName, 'Bob Builder');
  });

  test('a group DM drops my own name from its label', () => {
    const room = translator().toRoom({ channel: { id: 'g1', type: 'G', name: 'x', display_name: 'bob, me, carol' } });
    assert.equal(room?.displayName, 'Bob Builder, carol');
  });

  test('the newest root post feeds the list preview', () => {
    const room = translator().toRoom({ channel: { id: 'ch1', type: 'O', name: 'dev', display_name: 'Dev' }, lastPost: post('p9', { create_at: 77 }) });
    assert.equal(room?.lastMessage, 'message p9');
    assert.equal(room?.lastMessageTs, 77);
  });

  test('unread counts root posts only, mentions come from the membership', () => {
    const sub = translator().toSubscription({
      channel: { id: 'ch1', total_msg_count: 30, total_msg_count_root: 10 },
      member: { channel_id: 'ch1', msg_count: 20, msg_count_root: 7, mention_count: 2, roles: 'channel_user channel_admin' },
    });
    assert.equal(sub?.unread, 3);
    assert.equal(sub?.mentions, 2);
    assert.equal(sub?.roles, JSON.stringify(['owner']));
  });

  test('a DM shows its unread count, not every message as a mention', () => {
    const sub = translator().toSubscription({
      channel: { id: 'd1', type: 'D', total_msg_count: 4, total_msg_count_root: 4 },
      member: { channel_id: 'd1', msg_count: 1, msg_count_root: 1, mention_count: 3 },
    });
    assert.deepEqual([sub?.unread, sub?.mentions], [3, 0]);
  });
});

describe('MmTranslator.translateEvent', () => {
  test('a post envelope carrying a deletion is a deletion', () => {
    const t = translator().translateEvent({ collection: MM_POST, eventKey: 'ch1', args: [post('p1', { delete_at: 3 })] });
    assert.deepEqual(t, { kind: 'change', change: { type: 'message-deleted', id: 'p1' } });
  });

  test('quiet events are silence, unknown ones are counted', () => {
    assert.equal(translator().translateEvent({ collection: MM_QUIET, eventKey: 'typing', args: [] }).kind, 'silence');
    assert.equal(translator().translateEvent({ collection: 'channel_bookmark_created', eventKey: '', args: [] }).kind, 'ignore');
  });

  test('nested documents are accepted as JSON strings (Mattermost) and objects (kChat)', () => {
    assert.deepEqual(record('{"a":1}'), { a: 1 });
    assert.deepEqual(record({ a: 1 }), { a: 1 });
    assert.equal(record('[1]'), null);
  });
});

describe('kMeet call posts (kChat)', () => {
  const call = (props: Record<string, unknown>) => translator().toMessage(post('c1', { type: 'custom_call', message: 'bob started a call', props }));

  test('a running call is joined through its conference', () => {
    const m = call({ url: 'https://kmeet.infomaniak.com/room-1', conference_id: 'conf-1', status: 'calling', start_at: 1000 });
    assert.deepEqual([m?.systemType, m?.callId, m?.text], ['videoconf', 'conf-1', '']);
  });

  test('an ended call carries its length and nothing to join', () => {
    const m = call({ url: 'https://kmeet.infomaniak.com/room-1', status: 'ended', start_at: 1_000, end_at: 2_888_000 });
    assert.deepEqual([m?.systemType, m?.callId, m?.text], ['videoconf-ended', null, '2887']);
    assert.equal(call({ status: 'missed' })?.text, '');
  });

});

describe('Room previews', () => {
  test('a room whose last post is unknown keeps the stored preview; a known one rewrites it', () => {
    const channel = { id: 'ch1', type: 'O', name: 'dev', update_at: 5, last_post_at: 9 };
    assert.equal(translator().toRoom({ channel })?.keepPreview, true);
    assert.equal(translator().toRoom({ channel, lastPost: null })?.keepPreview, false);
  });
});

describe('membershipCounts', () => {
  const channel = { type: 'O', total_msg_count_root: 10, total_msg_count: 12 };
  test('unread roots and mentions of a membership', () => {
    assert.deepEqual(membershipCounts(channel, { msg_count_root: 7, mention_count: 2 }), { unread: 3, mentions: 2 });
  });
  test('a muted channel counts its mentions only', () => {
    assert.deepEqual(
      membershipCounts(channel, { msg_count_root: 7, mention_count: 0, notify_props: { mark_unread: 'mention' } }),
      { unread: 0, mentions: 0 },
    );
    assert.deepEqual(
      membershipCounts(channel, { msg_count_root: 7, mention_count: 1, notify_props: { mark_unread: 'mention' } }),
      { unread: 1, mentions: 1 },
    );
    assert.deepEqual(
      membershipCounts(channel, { msg_count_root: 7, mention_count: 0, notify_props: { mark_unread: 'all' } }),
      { unread: 3, mentions: 0 },
    );
  });
});

describe('MmTranslator integrations and links', () => {
  test('a card keeps its pretext apart; its text falls back on the fallback, not the pretext', () => {
    const m = translator().toMessage(post('p1', {
      props: { attachments: [
        { pretext: ':file_folder: New push', text: '[abc](https://git.test/abc) **fix**', title: 'Repo', fields: [{ title: 'Branch', value: '`main`', short: true }] },
        { pretext: 'Only a pretext', fallback: 'Only a pretext' },
        { fallback: 'plain summary' },
      ] },
    }));
    const [full, pretextOnly, summary] = (JSON.parse(m?.attachments ?? '[]') as unknown[]).map(integrationCard);
    assert.equal(full?.pretext, ':file_folder: New push');
    assert.equal(full?.text, '[abc](https://git.test/abc) **fix**');
    assert.equal(full?.fields[0]?.value, '`main`');
    assert.equal(pretextOnly?.pretext, 'Only a pretext');
    assert.equal(pretextOnly?.text, null);
    assert.equal(summary?.text, 'plain summary');
  });

  test('a card keeps only its buttons, with their id, name, style and cookie', () => {
    const m = translator().toMessage(post('p1', {
      props: { attachments: [{ text: 'Deploy?', actions: [
        { id: 'ok', name: 'Approve', style: 'primary', cookie: 'c1', integration: { url: 'https://hook.test' } },
        { id: 'no', name: 'Reject', type: 'button', style: 'danger' },
        { id: 'pick', name: 'Pick', type: 'select', options: [] },
        { id: '', name: 'No id' },
        { id: 'unnamed' },
      ] }] },
    }));
    const [raw] = JSON.parse(m?.attachments ?? '[]') as Record<string, unknown>[];
    assert.deepEqual(raw?.actions, [{ id: 'ok', name: 'Approve', style: 'primary', cookie: 'c1' }, { id: 'no', name: 'Reject', style: 'danger' }]);
    assert.deepEqual(integrationCard(raw)?.actions, [
      { id: 'ok', name: 'Approve', style: 'primary', cookie: 'c1' },
      { id: 'no', name: 'Reject', style: 'danger', cookie: null },
    ]);
  });

  test('a card shows at most ten buttons, their names capped like a title', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, name: `B${i}` }));
    assert.equal(integrationCard({ text: 'x', actions: many })?.actions.length, 10);
    const card = integrationCard({ text: 'x', actions: [{ id: 'long', name: 'é'.repeat(257) }, { id: 'ok', name: 'Fine' }] });
    assert.deepEqual(card?.actions.map((a) => a.id), ['ok']);
    assert.equal(integrationCard({ actions: [{ id: 'only', name: 'Only a button' }] })?.actions.length, 1, 'a card of buttons alone still shows');
  });

  test('a permalink embed becomes a quote of the linked post, named like an author', () => {
    const m = translator().toMessage(post('p1', {
      message: 'see http://mm.test/team/pl/q1',
      metadata: { embeds: [
        { type: 'permalink', data: { post_id: 'q1', channel_display_name: 'Town', team_name: 'team', post: { id: 'q1', user_id: 'u-bob', message: 'the **original**', create_at: 5000 } } },
        { type: 'permalink', data: { post_id: 'q2' } },
        { type: 'opengraph', url: 'https://x.test' },
      ] },
    }));
    const attachments = JSON.parse(m?.attachments ?? '[]') as Record<string, unknown>[];
    assert.equal(attachments.length, 1, 'an embed without its post is skipped');
    const [quoted] = attachments;
    assert.equal(quoted?.message_link, 'http://mm.test/_redirect/pl/q1');
    assert.equal(quoted?.author_name, 'Bob Builder');
    assert.equal(quoted?.ts, new Date(5000).toISOString());
    assert.equal(quoteText(quoted as { text?: string }), 'the **original**');
    assert.equal(integrationCard(quoted), null, 'a quote is never drawn as a card');
  });

  test('`permalinkPosts` reads only permalink embeds that carry their post', () => {
    assert.deepEqual(permalinkPosts([{ type: 'permalink', data: { post_id: 'q1', post: { message: 'x' } } }, { type: 'image' }, null]), [{ message: 'x', id: 'q1' }]);
    assert.deepEqual(permalinkPosts(undefined), []);
  });

  test('a reminder is rebuilt from its props, the server link kept', () => {
    const t = translator();
    const said = t.toMessage(post('p1', {
      type: 'reminder',
      message: "Hi there, here's your reminder about this message from @bob: http://mm.test/team/pl/q1",
      props: { username: 'bob', team_name: 'team', post_id: 'q1' },
    }));
    assert.equal(said?.text, "Hi there, here's your reminder about this message from @bob: http://mm.test/team/pl/q1");
    assert.equal(said?.systemType, null);
    const built = t.toMessage(post('p2', { type: 'reminder', message: 'Rappel !', props: { username: 'bob', team_name: 'team', post_id: 'q9' } }));
    assert.equal(built?.text, "Hi there, here's your reminder about this message from @bob: http://mm.test/team/pl/q9");
  });

  test('a webhook post shows its chosen name and icon, flagged as a bot; the poster stays the author', () => {
    const t = translator();
    const hook = t.toMessage(post('p1', { props: { from_webhook: 'true', override_username: 'Uptime Kuma', override_icon_url: 'https://cdn.test/kuma.png' } }));
    assert.equal(hook?.authorName, 'bob');
    assert.equal(hook?.authorAlias, 'Uptime Kuma');
    assert.equal(hook?.authorAvatar, 'https://cdn.test/kuma.png');
    assert.equal(hook?.authorBot, true);
    const relative = t.toMessage(post('p2', { props: { from_webhook: 'true', override_username: 'Hook', override_icon_url: '/static/x.png' } }));
    assert.equal(relative?.authorAvatar, null);
    const notHook = t.toMessage(post('p3', { props: { override_username: 'Spoof' } }));
    assert.equal(notHook?.authorAlias, null);
    assert.equal(notHook?.authorName, 'bob');
    assert.equal(notHook?.authorBot, false);
    assert.equal(t.toMessage(post('p4', { props: { from_bot: 'true' } }))?.authorBot, true);
    assert.equal(t.toMessage(post('p5', { user_id: 'u-euria' }))?.authorBot, true);
  });

  test('`mentionedUsernames` finds people, not everyone mentions, emails or trailing punctuation', () => {
    assert.deepEqual(mentionedUsernames('hi @Marc-Etienne.Barrut. and @here, mail a@b.c, (@bob)'), ['marc-etienne.barrut', 'bob']);
  });

  test('`mentionedUsernames` skips code spans and fenced blocks, closed or not', () => {
    assert.deepEqual(mentionedUsernames('use `@Override` and ``a @Inject b`` with @carol'), ['carol']);
    assert.deepEqual(mentionedUsernames('@dan\n```java\n@Override\nvoid f() {}\n```\nthen @erin'), ['dan', 'erin']);
    assert.deepEqual(mentionedUsernames('~~~\n@Test\n```\n@Still\n~~~\n@frank'), ['frank']);
    assert.deepEqual(mentionedUsernames('@gus\n```\n@Override'), ['gus']);
  });
});


describe('ephemeralNote', () => {
  const card = { text: 'Pick one', actions: [{ id: 'yes', name: 'Yes', cookie: 'srv' }] };

  test('reads text, cards and post id from an object or a JSON string', () => {
    const raw = { id: 'e1', channel_id: 'r1', message: 'Hi @bob', props: { attachments: [card] } };
    for (const value of [raw, JSON.stringify(raw)]) {
      const note = ephemeralNote(value, 'http://mm.test');
      assert.equal(note?.rid, 'r1');
      assert.equal(note?.postId, 'e1');
      assert.equal(note?.text, 'Hi @bob');
      assert.deepEqual(note?.cards?.[0]?.actions, [{ id: 'yes', name: 'Yes', style: null, cookie: 'srv' }]);
      assert.equal(note?.reminder, null);
    }
  });

  test('a note with only cards still shows; one with nothing does not', () => {
    assert.equal(ephemeralNote({ id: 'e1', channel_id: 'r1', message: '', props: { attachments: [card] } }, 'http://mm.test')?.cards?.length, 1);
    assert.equal(ephemeralNote({ id: 'e1', channel_id: 'r1', message: '' }, 'http://mm.test'), null);
    assert.equal(ephemeralNote({ id: 'e1', message: 'x' }, 'http://mm.test'), null);
  });

  test('a reminder acknowledgement reads in the app language with its due time', () => {
    const at = Date.UTC(2026, 9, 14, 7, 0);
    const props = { type: 'reminder', target_time: at / 1000, username: 'bob', post_id: 'q1', team_name: 'team' };
    const said = ephemeralNote({ id: 'e1', channel_id: 'r1', message: 'You will be reminded about http://mm.test/team/pl/q9 by @bob at Wed, 14 Oct 2026 07:00:00 UTC', props }, 'http://mm.test');
    assert.deepEqual(said?.reminder, { username: 'bob', link: 'http://mm.test/team/pl/q9', at });
    const built = ephemeralNote({ id: 'e1', channel_id: 'r1', message: 'You will be reminded', props }, 'http://mm.test');
    assert.equal(built?.reminder?.link, 'http://mm.test/team/pl/q1');
    const textual = ephemeralNote({ id: 'e1', channel_id: 'r1', message: 'You will be reminded', props: { ...props, target_time: String(at / 1000) } }, 'http://mm.test');
    assert.equal(textual?.reminder?.at, at);
    const garbled = ephemeralNote({ id: 'e1', channel_id: 'r1', message: 'You will be reminded', props: { ...props, target_time: 'soon' } }, 'http://mm.test');
    assert.equal(garbled?.reminder, null);
    for (const language of ['fr', 'en'] as const) {
      const when = reminderFormatter(language);
      const text = reminderAcknowledgement((k, p) => translate(language, k, p), (ms) => when(ms), said!.reminder!);
      assert.equal(text, language === 'fr'
        ? `Vous recevrez un rappel de [ce message](http://mm.test/team/pl/q9) de @bob ${when(at)}`
        : `You will be reminded about [this message](http://mm.test/team/pl/q9) from @bob ${when(at)}`);
      assert.ok(when(at).length > 0);
    }
  });
});
