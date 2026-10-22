import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TEAMS_ORIGIN, discoverRoutes, idClaims, validTeamsSession } from './auth.ts';
import {
  TeamsDirectory, chatRoom, channelRoom, conversationOf, deleted, htmlToMarkdown, messageId, profileFields, reacted, reactionCode,
  reactionKey, splitId, toMessage, toSubscription,
} from './translate.ts';

test('ids split on the last slash', () => {
  const id = messageId('19:abc@thread.v2', '1792540504421');
  assert.deepEqual(splitId(id), { rid: '19:abc@thread.v2', server: '1792540504421' });
  assert.equal(splitId('19:abc@thread.v2'), null);
  assert.equal(splitId('19:abc/12x'), null);
});

test('html becomes markdown, scripts and remote images dropped', () => {
  const md = htmlToMarkdown([
    '<p>Hi <span itemtype="http://schema.skype.com/Mention" itemscope itemid="0">Ada</span>,</p>',
    '<p><b>bold</b> <i>it</i> <s>gone</s> <code>x()</code> &amp; <a href="https://example.com/a?b=1&amp;c=2">a link</a></p>',
    '<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>',
    '<img itemtype="http://schema.skype.com/Emoji" alt="😀" src="https://x">',
    '<img src="https://tracker.example/p.gif"><script>alert(1)</script><style>p{}</style>',
  ].join(''));
  assert.ok(md.startsWith('Hi @Ada,'), md);
  assert.ok(md.includes('**bold** _it_ ~~gone~~ `x()` & [a link](https://example.com/a?b=1&c=2)'), md);
  assert.ok(md.includes('- one\n- two') && md.includes('1. first'), md);
  assert.ok(md.includes('😀') && !md.includes('alert') && !md.includes('tracker') && !md.includes('p{}'), md);
  assert.equal(htmlToMarkdown('<a href="javascript:x">click</a>'), 'click');
  assert.equal(htmlToMarkdown('<pre>a\n  b</pre>'), '```\na\n  b\n```');
});

const raw = (id: string, extra: Record<string, unknown> = {}) => ({
  id, messagetype: 'RichText/Html', contenttype: 'text', content: '<p>hello</p>',
  from: 'https://teams.microsoft.com/api/chatsvc/fr/v1/users/ME/contacts/8:orgid:aaa',
  imdisplayname: 'Ada', originalarrivaltime: '2026-10-20T23:55:21.7260000Z', version: id,
  conversationLink: 'https://teams.microsoft.com/api/chatsvc/fr/v1/users/ME/conversations/19:c@thread.v2',
  ...extra,
});

test('messages, edits, reactions and deletions', () => {
  const d = new TeamsDirectory();
  const m = toMessage('19:c@thread.v2', raw('1792540521726'), d)!;
  assert.equal(m.id, '19:c@thread.v2/1792540521726');
  assert.deepEqual([m.text, m.authorId, m.authorName, m.ts], ['hello', '8:orgid:aaa', 'Ada', 1792540521726]);
  const edited = raw('1792540521726', { properties: { edittime: '1792540590172', emotions: [
    { key: 'like', users: [{ mri: '8:orgid:aaa' }] }, { key: 'heart', users: [] }, { key: '1f525_fire', users: [{ mri: '8:orgid:bbb' }] },
  ] } });
  const e = toMessage('19:c@thread.v2', edited, d)!;
  assert.equal(e.editedAt, 1792540590172);
  const reactions = JSON.parse(e.reactions!) as Record<string, { usernames: string[] }>;
  assert.deepEqual(reactions[':+1:']!.usernames, ['Ada']);
  assert.deepEqual(reactions[':fire:']!.usernames, ['8:orgid:bbb']);
  assert.equal(reactions[':heart:'], undefined);
  assert.ok(reacted(edited, 'like', '8:orgid:aaa') && !reacted(edited, 'heart', '8:orgid:aaa'));
  const gone = raw('1', { content: '', properties: { deletetime: '1792540597454' } });
  assert.ok(deleted(gone) && toMessage('c', gone, d) === null);
  const asString = raw('5', { properties: { emotions: '[{"key":"laugh","users":[{"mri":"m"}]}]' } });
  assert.ok(toMessage('c', asString, d)!.reactions!.includes(':laughing:'));
});

test('replies, member activity and skipped kinds', () => {
  const d = new TeamsDirectory();
  d.remember('8:orgid:bbb', 'Bob');
  const reply = raw('20', { conversationLink: 'https://t/v1/users/ME/conversations/19:ch@thread.tacv2;messageid=10' });
  assert.equal(conversationOf(reply), '19:ch@thread.tacv2');
  assert.equal(conversationOf({ conversationLink: 'https://t/conversations/19%3Ax%40thread.v2' }), '19:x@thread.v2');
  assert.equal(toMessage('19:ch@thread.tacv2', reply, d)!.threadId, '19:ch@thread.tacv2/10');
  const added = raw('30', { messagetype: 'ThreadActivity/AddMember', content: '<addmember><target>8:orgid:bbb</target></addmember>' });
  const a = toMessage('c', added, d)!;
  assert.deepEqual([a.systemType, a.text], ['au', 'Bob']);
  for (const kind of ['Event/Call', 'ThreadActivity/MemberJoined', 'RichText/Media_CallRecording']) {
    assert.equal(toMessage('c', raw('40', { messagetype: kind }), d), null, kind);
  }
});

test('reaction keys both ways', () => {
  assert.equal(reactionCode('like'), '+1');
  assert.equal(reactionCode('1f525_fire'), 'fire');
  assert.equal(reactionKey(':thumbsup:'), 'like');
  assert.equal(reactionKey('joy'), 'laugh');
  assert.equal(reactionKey('fire'), null);
});

test('chats, channels and their read state', () => {
  const d = new TeamsDirectory();
  const me = '8:orgid:me';
  const chat = {
    id: '19:x@thread.v2', chatType: 'chat', isOneOnOne: true, isRead: false,
    members: [{ mri: me }, { mri: '8:orgid:bbb' }],
    consumptionHorizon: { originalArrivalTime: 100, timeStamp: 101, clientMessageId: '1' },
    lastMessage: { messageType: 'RichText/Html', content: '<p>yo</p>', from: '8:orgid:bbb', imDisplayName: 'Bob', composeTime: '2026-10-20T23:55:21.726Z', id: '1' },
  };
  const room = chatRoom(me, chat, d)!;
  assert.deepEqual([room.type, room.displayName, room.lastMessage, room.dmOtherUid], ['d', 'Bob', 'yo', '8:orgid:bbb']);
  const sub = toSubscription(chat.id, chat, me, null);
  assert.ok(sub.alert && sub.unread === 1 && sub.open && sub.lastSeen === 100);
  assert.equal(toSubscription('r', { ...chat, isLastMessageFromMe: true }, me, null).alert, false);
  const meeting = { id: '19:m@thread.v2', chatType: 'meeting', title: 'Standup', isRead: true, hidden: true };
  assert.deepEqual([chatRoom(me, meeting, d)!.type, chatRoom(me, meeting, d)!.name], ['p', 'Standup']);
  assert.equal(toSubscription('r', meeting, me, null).open, false);
  const channel = { id: '19:g@thread.tacv2', displayName: 'General', isMessageRead: true, channelType: 'Standard' };
  assert.equal(channelRoom(channel, d)!.type, 'c');
  const s = toSubscription(channel.id, channel, me, { id: 'team', name: 'Ops' });
  assert.deepEqual([s.groupName, s.alert], ['Ops', false]);
});

test('routes keep Teams hosts only; a stored account must look like one Microsoft gave', () => {
  const body = { regionGtms: {
    chatServiceAfd: 'https://teams.microsoft.com/api/chatsvc/fr', chatSvcAggAfd: 'https://teams.microsoft.com/api/csa/emea',
    calling_trouterUrl: 'https://go-eu.trouter.teams.microsoft.com/v3/c',
  } };
  assert.equal(discoverRoutes(body)!.chat, 'https://teams.microsoft.com/api/chatsvc/fr');
  for (const bad of ['http://teams.microsoft.com/a', 'https://teams.microsoft.com.evil.example/a', 'https://u@teams.microsoft.com/a', 'https://evilteams.microsoft.com/a']) {
    assert.equal(discoverRoutes({ regionGtms: { ...body.regionGtms, chatServiceAfd: bad } }), null, bad);
  }
  const session = {
    baseUrl: TEAMS_ORIGIN, authToken: '', userId: '8:orgid:00000000-0000-4000-8000-0000000000aa', username: 'Ada',
    kind: 'teams' as const, siteUrl: null, teamsTenantId: '00000000-0000-4000-8000-000000000001', teamsRefresh: 'r',
  };
  assert.ok(validTeamsSession(session));
  assert.equal(validTeamsSession({ ...session, baseUrl: 'https://evil.example' }), false);
  assert.equal(validTeamsSession({ ...session, userId: '8:orgid:nope' }), false);
  const payload = btoa(JSON.stringify({ tid: 't', oid: 'o' })).replace(/=+$/, '');
  assert.equal(idClaims(`h.${payload}.s`)!.oid, 'o');
  assert.equal(idClaims('garbage'), null);
});

test('a short profile row becomes the card fields; a missing row keeps the learned name', () => {
  const d = new TeamsDirectory();
  const mri = '8:orgid:aaaa-bbbb';
  d.remember(mri, 'Known Name');
  const full = profileFields(mri, { mri, displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com', jobTitle: 'Engineer' }, d);
  assert.deepEqual(full, { _id: mri, username: 'ada@contoso.com', name: 'Ada Lovelace', roles: [], bio: 'Engineer', bot: false });
  const degraded = profileFields(mri, undefined, d);
  assert.equal(degraded.name, 'Ada Lovelace');
  assert.equal(degraded.username, mri);
  assert.equal(degraded.bio, null);
  const bot = profileFields('28:orgid:app', { displayName: 'Helper' }, d);
  assert.equal(bot.bot, true);
});
