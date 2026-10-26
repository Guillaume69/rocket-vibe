import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TEAMS_ORIGIN, discoverRoutes, idClaims, validTeamsSession } from './auth.ts';
import {
  TeamsDirectory, channelLink, chatLink, isTeamsImage, meetupLink, objectId, chatRoom, channelRoom, conversationOf, deleted, fileAttachments, htmlToMarkdown, isGraphShare, messageId, profileFields, conversationTopic, rosterPage, searchHits, reacted, reactionCode,
  reactionKey, splitId, toMessage, toSubscription, lastId, readUpTo,
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

test('a call starts as a join card and its end replaces it', () => {
  const d = new TeamsDirectory();
  const channel = '19:ch@thread.tacv2';
  const link = `https://t/conversations/${channel};messageid=1792713340033`;
  const running = toMessage(channel, raw('1792713340033', {
    messagetype: 'Event/Call', conversationLink: link,
    content: '<partlist alt =""></partlist><callEventType>callStarted</callEventType><callId>c1</callId>',
  }), d)!;
  assert.deepEqual([running.id, running.systemType, running.callId, running.threadId], [`${channel}/1792713340033`, 'videoconf', `${channel}/1792713340033`, null]);
  const over = toMessage(channel, raw('1792713355826', {
    messagetype: 'Event/Call', conversationLink: link,
    content: '<ended/><partlist count="2"><part><duration>76</duration></part><part><duration>40</duration></part></partlist><callEventType>callEnded</callEventType>',
  }), d)!;
  assert.deepEqual([over.id, over.ts, over.systemType, over.text, over.callId, over.threadId], [running.id, 1792713340033, 'videoconf-ended', '76', null, null]);
  assert.ok(over.updatedAt > running.updatedAt);
  const csa = { id: '9', messagetype: 'Event/Call', parentMessageId: '5', originalarrivaltime: '2026-10-22T23:55:55.826Z', content: '<ended/><callEventType>callEnded</callEventType>' };
  assert.equal(toMessage(channel, csa, d)!.id, `${channel}/5`);
  assert.equal(toMessage('c', raw('40', { messagetype: 'Event/Call' }), d), null);
});

test('call links open the conversation in Teams', () => {
  assert.equal(
    channelLink('19:ch@thread.tacv2', 'Général', 'g-1', 't-1'),
    'https://teams.microsoft.com/l/channel/19%3Ach%40thread.tacv2/G%C3%A9n%C3%A9ral?groupId=g-1&tenantId=t-1',
  );
  assert.equal(chatLink('19:a_b@unq.gbl.spaces', 't-1'), 'https://teams.microsoft.com/l/chat/19%3Aa_b%40unq.gbl.spaces/conversations?tenantId=t-1');
  assert.equal(
    meetupLink('19:ch@thread.tacv2', '1792769688903', 't-1', 'o-1'),
    'https://teams.microsoft.com/l/meetup-join/19%3ach%40thread.tacv2/1792769688903?context=%7B%22Tid%22%3A%22t-1%22%2C%22Oid%22%3A%22o-1%22%7D',
  );
  assert.deepEqual([objectId('8:orgid:o-1'), objectId('8:live:bob')], ['o-1', null]);
});

test('messages, edits, reactions and deletions', () => {
  const d = new TeamsDirectory();
  const m = toMessage('19:c@thread.v2', raw('1792540521726'), d)!;
  assert.equal(m.id, '19:c@thread.v2/1792540521726');
  assert.deepEqual([m.text, m.authorId, m.authorName, m.ts], ['hello', '8:orgid:aaa', 'Ada', 1792540521726]);
  assert.equal(m.pinned, false);
  const pinned = raw('1792540521726', { properties: { pinned: '{"creatorId":"8:orgid:aaa","pinnedTime":1}' } });
  assert.equal(toMessage('19:c@thread.v2', pinned, d)!.pinned, true);
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

test('channels never opened or ending on an event are read', () => {
  const me = '8:orgid:me', team = { id: 'team', name: 'Ops' };
  const text = { messageType: 'RichText/Html', content: '<p>yo</p>', from: '8:orgid:bbb', composeTime: '2026-10-20T23:55:21.726Z', id: '1792540521726' };
  const neverOpened = { id: '19:g@thread.tacv2', lastMessage: text };
  assert.equal(toSubscription(neverOpened.id, neverOpened, me, team).alert, false);
  assert.equal(toSubscription('19:x@thread.v2', neverOpened, me, null).alert, true, 'a chat with no horizon stays unread');
  const seenBefore = { ...neverOpened, consumptionHorizon: { originalArrivalTime: 1792540500000 } };
  assert.equal(toSubscription(seenBefore.id, seenBefore, me, team).alert, true);
  const event = { ...seenBefore, lastMessage: { ...text, messageType: 'ThreadActivity/MemberJoined' } };
  assert.equal(toSubscription(event.id, event, me, team).alert, false);
  assert.equal(lastId(seenBefore), 1792540521726);
  const read = readUpTo(seenBefore, 1792540521726);
  assert.equal(toSubscription(read.id as string, read, me, team).alert, false);
  assert.equal(readUpTo(read, 1), read, 'never marked backwards');
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

test('a conversation document yields its topic from threadProperties', () => {
  assert.equal(conversationTopic({ threadProperties: { topic: 'Launch', rosterVersion: '9' } }), 'Launch');
  assert.equal(conversationTopic({ threadProperties: { topic: '' } }), null);
  assert.equal(conversationTopic({}), null);
});

test('search hits keep the room and map the Substrate source', () => {
  const d = new TeamsDirectory();
  d.remember('8:orgid:aaaa', 'Ada Lovelace');
  const body = { EntitySets: [{ ResultSets: [{ Results: [
    { Source: { ClientConversationId: '19:room@thread.tacv2', ClientThreadId: '19:room@thread.tacv2', Preview: 'found this', DateTimeSent: '2026-10-22T08:01:52Z', ImmutableId: 'AAItem1', From: { EmailAddress: { Name: 'Ada Lovelace' } } } },
    { Source: { ClientConversationId: '19:other@thread.tacv2', Preview: 'nope', DateTimeSent: '2026-10-22T09:00:00Z', From: { EmailAddress: { Name: 'Someone Else' } } } },
  ] }] }] };
  const hits = searchHits(body, '19:room@thread.tacv2', d);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, 'found this');
  assert.equal(hits[0].authorName, 'Ada Lovelace');
  assert.equal(hits[0].authorId, '8:orgid:aaaa');
  assert.equal(hits[0].id, '19:room@thread.tacv2/search:AAItem1');
  assert.ok(hits[0].ts > 0);
  assert.deepEqual(searchHits({}, '19:room@thread.tacv2', d), []);
});

test('a roster maps members, resolves names and filters by display name', () => {
  const d = new TeamsDirectory();
  d.remember('8:orgid:aaaa', 'Ada Lovelace');
  const body = { members: [{ id: '8:orgid:aaaa', role: 'Admin' }, { id: '8:orgid:bbbb', role: 'User' }] };
  const page = rosterPage(body, d, '');
  assert.equal(page.total, 2);
  assert.equal(page.members[0].username, 'Ada Lovelace');
  assert.deepEqual(page.members[0].roles, ['Admin']);
  assert.equal(page.members[1].username, '8:orgid:bbbb');
  assert.equal(rosterPage(body, d, 'ada').total, 1);
  assert.deepEqual(rosterPage({}, d, '').members, []);
});

test('isGraphShare recognises SharePoint and OneDrive hosts only', () => {
  assert.ok(isGraphShare('https://contoso.sharepoint.com/sites/x/a.pdf'));
  assert.ok(isGraphShare('https://contoso-my.sharepoint.com/personal/u/a.pdf'));
  assert.ok(isGraphShare('https://1drv.ms/x/s!abc'));
  assert.ok(!isGraphShare('https://as-api.asyncgw.teams.microsoft.com/v1/objects/0/views/original'));
  assert.ok(!isGraphShare('nonsense'));
});

test('fileAttachments keeps SharePoint files in the RC shape, drops AMS media', () => {
  const raw = {
    messagetype: 'RichText/Media_GenericFile',
    properties: { files: JSON.stringify([
      { title: 'report.pdf', fileInfo: { fileUrl: 'https://contoso.sharepoint.com/sites/x/report.pdf', fileSize: 1234 } },
      { title: 'clip.mp4', fileInfo: { fileUrl: 'https://as-api.asyncgw.teams.microsoft.com/v1/objects/0/views/original' } },
    ]) },
  };
  const files = JSON.parse(fileAttachments(raw) ?? '[]') as Record<string, unknown>[];
  assert.equal(files.length, 1);
  assert.equal(files[0].title, 'report.pdf');
  assert.equal(files[0].title_link, 'https://contoso.sharepoint.com/sites/x/report.pdf');
  assert.equal(files[0].type, 'file');
  assert.equal(files[0].size, 1234);
  assert.equal(fileAttachments({ properties: {} }), null);
});

test('images on the object store show inline, a file with its preview image', () => {
  const preview = 'https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frc-d2-ab/views/imgo';
  const raw = {
    content: '<p><img itemtype="http://schema.skype.com/AMSImage" width="300" height="200" src="https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frc-d1-cd/views/imgo"></p>'
      + '<img itemtype="http://schema.skype.com/Emoji" alt="x" src="https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/e/views/imgo">'
      + '<img src="https://tracker.example/p.gif">',
    properties: { files: JSON.stringify([{ title: 'photo.png', fileInfo: { fileUrl: 'https://contoso.sharepoint.com/sites/x/Shared Documents/photo.png' }, filePreview: { previewUrl: preview, previewWidth: 512, previewHeight: 256 } }]) },
  };
  const found = JSON.parse(fileAttachments(raw)!) as Record<string, unknown>[];
  assert.equal(found.length, 3);
  assert.deepEqual(found[0].image_dimensions, { width: 300, height: 200 });
  assert.deepEqual(found[1], { image_url: preview, title: 'photo.png', image_dimensions: { width: 512, height: 256 } });
  assert.equal(found[2].type, 'file');
  for (const no of [
    'http://fr-prod.asyncgw.teams.microsoft.com/v1/objects/a/views/imgo',
    'https://evil.example/v1/objects/a/views/imgo',
    'https://asyncgw.teams.microsoft.com.evil.example/v1/objects/a/views/imgo',
    'https://u@fr-prod.asyncgw.teams.microsoft.com/v1/objects/a/views/imgo',
  ]) assert.equal(isTeamsImage(no), false, no);
});
