import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shortcodeOfUnicode, unicodeOfShortcode } from '@rocket-vibe/provider-api/emojis';

import { TEAMS_ORIGIN, discoverRoutes, idClaims, validTeamsSession } from './auth.ts';
import {
  TeamsDirectory, channelLink, chatLink, isTeamsImage, meetupLink, objectId, chatRoom, channelRoom, conversationOf, deleted, fileAttachments, htmlToMarkdown, isGraphShare, messageId, profileFields, conversationTopic, rosterPage, searchHits, reacted, reactionCode,
  reactionKey, splitId, toMessage, toSubscription, lastId, readUpTo, withoutSubject, keepNewerLast, newerLast, listedChat, newOneOnOne, oneOnOneId, oneOnOneThread, unknownPeople, groupThread, newGroupChat, isGroupChat, people, peopleRequest,
  convert, isGiphy, permalink, qualifiedName, spellMentions, callAllowed, callLink, callPeople, actor, replyTarget, replyQuote,
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
  const a = toMessage('19:ch@thread.tacv2', added, d)!;
  assert.deepEqual([a.systemType, a.text], ['au', 'Bob']);
  const group = raw('31', { messagetype: 'ThreadActivity/AddMember', content: '<addmember><initiator>8:orgid:aaa</initiator><target>8:orgid:aaa</target><target>8:orgid:bbb</target><target>8:orgid:ccc</target></addmember>' });
  const g = toMessage('19:g@thread.v2', group, d)!;
  assert.deepEqual([g.systemType, g.text], ['rv-chat-added', 'Bob, 8:orgid:ccc']);
  const created = raw('32', { messagetype: 'ThreadActivity/AddMember', content: '<addmember><initiator>8:orgid:aaa</initiator><target>8:orgid:aaa</target></addmember>' });
  assert.equal(toMessage('19:g@thread.v2', created, d), null);
  const joined = toMessage('19:ch@thread.tacv2', created, d)!;
  assert.deepEqual([joined.systemType, joined.text], ['uj', null]);
  assert.equal(toMessage('19:aaa_bbb@unq.gbl.spaces', group, d), null);
  for (const kind of ['Event/Call', 'ThreadActivity/MemberJoined', 'RichText/Media_CallRecording']) {
    assert.equal(toMessage('c', raw('40', { messagetype: kind }), d), null, kind);
  }
});

test('reaction keys both ways', () => {
  assert.equal(reactionCode('like'), '+1');
  assert.equal(reactionCode('1f525_fire'), 'fire');
  assert.equal(reactionKey(':thumbsup:'), 'like');
  assert.equal(reactionKey('joy'), 'laugh');
  assert.equal(reactionKey(':tada:'), '1f389_partypopper');
  assert.equal(reactionKey('rocket'), 'launch');
  assert.equal(reactionKey('heavy_check_mark'), '2714_heavycheckmark');
  assert.equal(unicodeOfShortcode(reactionCode(reactionKey('tada') ?? '')), '🎉');
  assert.equal(reactionKey('not_an_emoji'), null);
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
  assert.equal(channelRoom(channel, null, d)!.type, 'c');
  const s = toSubscription(channel.id, channel, me, { id: 'team', name: 'Ops' });
  assert.deepEqual([s.groupName, s.alert], ['Ops', false]);
});

test('chats only the chat service lists take the aggregator shape', () => {
  const d = new TeamsDirectory();
  const last = { id: '1792540521726', messagetype: 'RichText/Html', content: '<p>yo</p>', from: 'https://t/v1/users/ME/contacts/8:orgid:bbb', imdisplayname: 'Bob', composetime: '2026-10-20T23:55:21.726Z' };
  const chat = listedChat({ id: '19:aaa_bbb@unq.gbl.spaces', threadProperties: {}, lastMessage: last, properties: { consumptionhorizon: '1792540500000;1792540500001;42' } })!;
  assert.deepEqual(chat.members, [{ mri: '8:orgid:aaa' }, { mri: '8:orgid:bbb' }]);
  const room = chatRoom('8:orgid:aaa', chat, d)!;
  assert.deepEqual([room.type, room.displayName, room.dmOtherUid], ['d', 'Bob', '8:orgid:bbb']);
  assert.equal(toSubscription(room.rid, chat, '8:orgid:aaa', null).alert, true);
  assert.equal(listedChat({ id: '19:g@thread.v2', threadProperties: { topic: 'Point infra', threadType: 'chat' }, lastMessage: last })?.title, 'Point infra');
  assert.equal(listedChat({ id: '19:meeting_x@thread.v2', threadProperties: { threadType: 'meeting' }, lastMessage: last })?.chatType, 'meeting');
  for (const skipped of [
    { id: '19:c@thread.tacv2', lastMessage: last },
    { id: '19:s@thread.v2', threadProperties: { threadType: 'space' }, lastMessage: last },
    { id: '48:notes', lastMessage: last },
    { id: '19:empty@thread.v2', threadProperties: {} },
  ]) assert.equal(listedChat(skipped), null, skipped.id);
});

test('a hidden chat shows again once it has a message', () => {
  const last = { messageType: 'RichText/Html', content: '<p>yo</p>', id: '1' };
  assert.equal(toSubscription('19:x@thread.v2', { id: '19:x@thread.v2', hidden: true, lastMessage: last }, 'me', null).open, true);
  assert.equal(toSubscription('19:x@thread.v2', { id: '19:x@thread.v2', hidden: true }, 'me', null).open, false);
  assert.equal(toSubscription('19:x@thread.v2', { id: '19:x@thread.v2', isConversationDeleted: true, lastMessage: last }, 'me', null).open, false);
});

test('a post shows its subject as a title, which an edit leaves out', () => {
  const d = new TeamsDirectory();
  const post = { id: '10', messagetype: 'RichText/Html', content: '<p>https://x.example</p>', originalarrivaltime: '2026-10-20T23:55:21.726Z', properties: { subject: 'Des failles php &amp; co' } };
  assert.equal(toMessage('19:ch@thread.tacv2', post, d)?.text, '**Des failles php & co**\n\nhttps://x.example');
  assert.equal(withoutSubject(post, '**Des failles php & co**\n\nfixed'), 'fixed');
  assert.equal(withoutSubject({}, '**bold** start'), '**bold** start');
  assert.equal(toMessage('c', { ...post, properties: { subject: '  ' } }, d)?.text, 'https://x.example');
  const channel = { id: '19:ch@thread.tacv2', lastMessage: { messageType: 'RichText/Html', content: '<p>link</p>', subject: 'Faille Gitlab', composeTime: '2026-10-20T23:55:21.726Z', id: '1' } };
  assert.equal(channelRoom(channel, null, d)?.lastMessage, '**Faille Gitlab**\n\nlink');
});

test('channels carry their team and are favorites only when pinned', () => {
  const d = new TeamsDirectory();
  const general = { id: '19:g@thread.tacv2', isFavorite: true };
  const room = channelRoom(general, 'Tech', d)!;
  assert.deepEqual([room.name, room.displayName], ['General', 'Tech · General']);
  const team = { id: 'team', name: 'Tech' };
  assert.equal(toSubscription(general.id, general, 'me', team).favorite, false, 'shown, not starred');
  assert.equal(toSubscription('19:p@thread.tacv2', { id: '19:p@thread.tacv2', isPinned: true }, 'me', team).favorite, true);
  assert.equal(toSubscription('19:x@thread.v2', { id: '19:x@thread.v2', isFavorite: true }, 'me', null).favorite, true);
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

test('people are the suggestions with an id, me left out', () => {
  const me = '8:orgid:f1c9871e-4fe6-43b1-aa6f-5151f41cb073';
  const body = { Groups: [
    { Type: 'People', Suggestions: [
      { DisplayName: 'Fairouz Lemkaddem', MRI: '8:orgid:e91438dc-73eb-4dd2-9689-2d77b9bd5fcc', UserPrincipalName: 'faye.lemkaddem@axxone.fr' },
      { DisplayName: 'No MRI', ExternalDirectoryObjectId: '7afa87cf-addf-4913-ba83-bbb4171f2573' },
      { DisplayName: 'Me', MRI: me },
      { DisplayName: 'Nothing' },
    ] },
    { Type: 'Topic', Suggestions: [{ DisplayName: 'A topic', MRI: '8:orgid:x' }] },
  ] };
  assert.deepEqual(people(body, me), [
    { mri: '8:orgid:e91438dc-73eb-4dd2-9689-2d77b9bd5fcc', name: 'Fairouz Lemkaddem', upn: 'faye.lemkaddem@axxone.fr' },
    { mri: '8:orgid:7afa87cf-addf-4913-ba83-bbb4171f2573', name: 'No MRI', upn: null },
  ]);
  const request = peopleRequest('Fai', 'c1') as { EntityRequests: { EntityType: string; Query: { QueryString: string } }[]; Scenario: { Name: string } };
  assert.equal(request.EntityRequests[0]?.EntityType, 'People');
  assert.equal(request.EntityRequests[0]?.Query.QueryString, 'Fai');
  assert.equal(request.Scenario.Name, 'powerbar');
});

test('a one-to-one thread names both members on a fixed roster', () => {
  const thread = oneOnOneThread('19:aa_bb@unq.gbl.spaces') as { members: { id: string }[]; properties: { uniquerosterthread: string } };
  assert.deepEqual(thread.members.map((m) => m.id), ['8:orgid:aa', '8:orgid:bb']);
  assert.equal(thread.properties.uniquerosterthread, 'true');
  assert.equal(oneOnOneThread('19:abc@thread.v2'), null);
  assert.equal(oneOnOneThread('19:_bb@unq.gbl.spaces'), null);
});

test('a one-to-one is named after both ids in order, and lists before its first message', () => {
  const me = '8:orgid:f1c9871e-4fe6-43b1-aa6f-5151f41cb073';
  const her = '8:orgid:e91438dc-73eb-4dd2-9689-2d77b9bd5fcc';
  const id = '19:e91438dc-73eb-4dd2-9689-2d77b9bd5fcc_f1c9871e-4fe6-43b1-aa6f-5151f41cb073@unq.gbl.spaces';
  assert.equal(oneOnOneId(me, her), id);
  assert.equal(oneOnOneId(her, me), id);
  assert.equal(oneOnOneId(me, her.toUpperCase().replace('8:ORGID:', '8:orgid:')), id);
  assert.equal(oneOnOneId(me, me), null);
  assert.equal(oneOnOneId(me, '28:bot'), null);
  const d = new TeamsDirectory();
  d.remember(her, 'Fairouz');
  const room = chatRoom(me, newOneOnOne(me, her, 1_700_000_000_000), d);
  assert.equal(room?.rid, id);
  assert.equal(room?.type, 'd');
  assert.equal(room?.displayName ?? room?.name, 'Fairouz');
});

test('hidden channels and flags with nothing to read are read', () => {
  const team = { id: 'team', name: 'ID Capture' };
  const flagged = { id: '19:alerts@thread.tacv2', isMessageRead: false, isFavorite: true };
  assert.equal(toSubscription('19:alerts@thread.tacv2', flagged, '8:orgid:me', team).alert, false);
  const text = { messageType: 'RichText/Html', content: '<p>yo</p>', from: '8:orgid:bbb', composeTime: '2026-10-20T23:55:21.726Z', id: '1792540521726' };
  const shown = { id: '19:hello@thread.tacv2', isMessageRead: false, isFavorite: true, lastMessage: text, consumptionHorizon: { originalArrivalTime: 1792540500000 } };
  assert.equal(toSubscription('19:hello@thread.tacv2', shown, '8:orgid:me', team).alert, true);
  assert.equal(toSubscription('19:hello@thread.tacv2', { ...shown, isFavorite: false }, '8:orgid:me', team).alert, false);
  const chat = { id: '19:x@thread.v2', isRead: false, isFavorite: false, lastMessage: text };
  assert.equal(toSubscription('19:x@thread.v2', chat, '8:orgid:me', null).alert, true);
});

test('a channel named after its team is not prefixed twice', () => {
  assert.equal(qualifiedName('Tech', 'Tech - GED'), 'Tech - GED');
  assert.equal(qualifiedName('Tech', 'Technology'), 'Tech · Technology');
  assert.equal(qualifiedName('Tech', 'General'), 'Tech · General');
});

test('a chat is named after its people, not its bots', () => {
  const d = new TeamsDirectory();
  d.remember('8:orgid:micael', 'Micael GONZALEZ');
  const chat = { id: '19:c@thread.v2', isOneOnOne: false, chatType: 'chat', members: [
    { mri: '8:orgid:me' }, { mri: '8:orgid:micael' }, { mri: '28:512b84d2-5840-45d6-8d01-5f073836d039' }] };
  const room = chatRoom('8:orgid:me', chat, d);
  assert.equal(room?.displayName, 'Micael GONZALEZ');
  assert.equal(room?.type, 'd');
  assert.equal(room?.dmOtherUid, '8:orgid:micael');
});

test('reaction keys show as standard shortcodes', () => {
  assert.equal(reactionCode('like'), '+1');
  assert.equal(reactionCode('loudlycrying'), 'sob');
  assert.equal(reactionCode('smilerobot'), 'robot');
  assert.equal(reactionCode('1f62d_loudlycrying'), 'sob');
  assert.equal(reactionCode('launch'), 'rocket');
  assert.equal(reactionCode('1f44b_wavinghand-tone1'), shortcodeOfUnicode('👋🏻'));
  assert.equal(reactionCode('yes-tone3'), shortcodeOfUnicode('👍🏽'));
  assert.equal(reactionCode('zzzunknown'), 'zzzunknown');
});

test('a reply quote is set apart and the text after it trimmed', () => {
  const html = '<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="1792500000000">'
    + '<strong itemprop="mri" itemid="8:orgid:marc">Marc-Etienne BARRUT</strong>'
    + '<span itemprop="time" itemid="1792500000000"></span>'
    + '<p itemprop="preview">Je suis outré</p></blockquote>'
    + "<p>&nbsp; Je m'en doute. J'espère que tu t'en remettras</p>";
  const converted = convert(html, []);
  assert.equal(converted.text, "Je m'en doute. J'espère que tu t'en remettras");
  assert.deepEqual(converted.quotes, [{ id: '1792500000000', author: 'Marc-Etienne BARRUT', authorMri: '8:orgid:marc', ts: 1792500000000, text: 'Je suis outré' }]);
  const m = toMessage('19:c@thread.v2', raw('1792600000000', { content: html }), new TeamsDirectory());
  const quotes = JSON.parse(m?.attachments ?? '[]') as Record<string, unknown>[];
  assert.equal(quotes[0]?.author_name, 'Marc-Etienne BARRUT');
  assert.equal(quotes[0]?.message_link, permalink('19:c@thread.v2', '1792500000000'));
});

test('a mention spelled one span per word is one mention', () => {
  const html = '<p>bien vu. <span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">Marc-Etienne</span>'
    + '&nbsp;<span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="1">BARRUT</span> pour action</p>'
    + '<p><span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="2">Olivier</span> '
    + '<span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="3">DAUMIN</span> pour info</p>';
  const marc = '8:orgid:f1c9871e-4fe6-43b1-aa6f-5151f41cb073';
  const olivier = '8:orgid:0a7c1d02-1111-2222-3333-444455556666';
  const mentions = JSON.stringify([
    { itemid: 0, mri: marc, displayName: 'Marc-Etienne' }, { itemid: 1, mri: marc, displayName: 'BARRUT' },
    { itemid: 2, mri: olivier, displayName: 'Olivier' }, { itemid: 3, mri: olivier, displayName: 'DAUMIN' },
  ]);
  const d = new TeamsDirectory();
  const m = toMessage('19:c@thread.v2', raw('1792600000001', { content: html, properties: { mentions } }), d);
  assert.equal(m?.text, 'bien vu. @f1c9871e-4fe6-43b1-aa6f-5151f41cb073 pour action\n@0a7c1d02-1111-2222-3333-444455556666 pour info');
  assert.equal(d.byToken('f1c9871e-4fe6-43b1-aa6f-5151f41cb073'), 'Marc-Etienne BARRUT');
  assert.equal(d.mentionNames().get('0a7c1d02-1111-2222-3333-444455556666'), 'Olivier DAUMIN');
  assert.equal(spellMentions(m?.text ?? '', (t) => d.byToken(t)), 'bien vu. @Marc-Etienne BARRUT pour action\n@Olivier DAUMIN pour info');
  assert.equal(htmlToMarkdown(html), 'bien vu. @Marc-Etienne BARRUT pour action\n@Olivier DAUMIN pour info');
});

test('a shared document is downloaded by its path, not its viewer page', () => {
  const base = 'https://contoso-my.sharepoint.com/personal/someone_contoso_com';
  const raw = {
    properties: {
      files: JSON.stringify([
        {
          title: '1 - Plan-v8.docx',
          objectUrl: `${base}/Documents/Microsoft Teams Chat Files/1 - Plan-v8.docx`,
          fileInfo: { fileUrl: `${base}/_layouts/15/Doc.aspx?sourcedoc=%7BC3%7D&file=1%20-%20Plan-v8.docx&action=default` },
        },
        { title: 'Viewer only.xlsx', fileInfo: { fileUrl: `${base}/_layouts/15/Doc.aspx?sourcedoc=%7BD4%7D` } },
      ]),
    },
  };
  const found = JSON.parse(fileAttachments(raw) ?? '[]') as { title_link: string; type: string }[];
  assert.equal(found.length, 2);
  assert.equal(found[0].title_link, `${base}/Documents/Microsoft Teams Chat Files/1 - Plan-v8.docx`);
  assert.equal(found[0].type, 'file');
  assert.ok(found[1].title_link.includes('/_layouts/'));
});

test('a Teams call screen stays on Microsoft\'s pages; a call link names the people', () => {
  assert.ok(callAllowed('https://teams.microsoft.com/l/call/0/0?users=a'));
  assert.ok(callAllowed('https://login.microsoftonline.com/common/oauth2'));
  assert.ok(callAllowed('blob:https://teams.microsoft.com/abc'));
  assert.ok(!callAllowed('https://evil.com/?x=teams.microsoft.com'));
  assert.ok(!callAllowed('https://user@teams.microsoft.com/'));
  assert.ok(!callAllowed('http://teams.microsoft.com/'));
  assert.ok(!callAllowed('https://notmicrosoft.com/'));
  assert.deepEqual(callPeople('8:orgid:me', { members: [{ mri: '8:orgid:ME' }, { mri: '8:orgid:aa' }, { mri: '28:bot' }] }), ['8:orgid:aa']);
  assert.equal(callLink([], null), null);
  assert.equal(callLink(['a@x.fr', 'b@x.fr'], '8:orgid:me'), 'https://teams.microsoft.com/l/call/0/0?users=a%40x.fr%2Cb%40x.fr');
});

test('the notes created event keeps its page address', () => {
  const uri = 'https://t.sharepoint.com/contentstorage/CSP_g/Document%20Library/19_c_thread_v2/loop_loopThread.loop?nav=cz0x&amp;x=1';
  const raw = (subtype: string) => ({
    id: '1793576966428', messagetype: 'ThreadActivity/FileAdd', from: 'https://x/v1/users/ME/contacts/19:c@thread.v2',
    originalarrivaltime: '2026-11-02T00:49:26.428Z',
    content: `<fileadd><initiator>8:orgid:abc</initiator><target><uri>${uri}</uri><type>loop</type><subtype>${subtype}</subtype></target></fileadd>`,
  });
  const m = toMessage('19:c@thread.v2', raw('loopthread'), new TeamsDirectory())!;
  assert.deepEqual([m.systemType, m.text], ['rv-notes-created', uri.replace('&amp;', '&')]);
  assert.equal(toMessage('19:c@thread.v2', raw('other'), new TeamsDirectory()), null);
});

test('a topic change is named after its initiator, never the conversation', () => {
  const directory = new TeamsDirectory();
  directory.remember('8:orgid:abc', 'Ada Lovelace');
  const raw = (content: string) => ({
    id: '1793576411256', messagetype: 'ThreadActivity/TopicUpdate',
    from: 'https://x/v1/users/ME/contacts/19:f1f2ff4f747c4c0da8a4a856c2abd7da@thread.v2',
    content, originalarrivaltime: '2026-11-01T23:40:11.348Z',
  });
  const named = toMessage('19:f1f2ff4f747c4c0da8a4a856c2abd7da@thread.v2', raw('<topicupdate><initiator>8:orgid:abc</initiator><value>Axeo devs</value></topicupdate>'), directory)!;
  assert.deepEqual([named.authorId, named.authorName, named.systemType, named.text], ['8:orgid:abc', 'Ada Lovelace', 'room_changed_topic', 'Axeo devs']);
  const anonymous = toMessage('19:f1f2ff4f747c4c0da8a4a856c2abd7da@thread.v2', raw('<topicupdate><value>Axeo devs</value></topicupdate>'), directory)!;
  assert.deepEqual([anonymous.authorId, anonymous.authorName], ['', 'Someone']);
  assert.equal(actor({ messagetype: 'RichText/Html', from: '8:orgid:bob' }), '8:orgid:bob');
});

test('a group chat is created as the web app does, then listed and renamable', () => {
  const me = '8:orgid:me';
  const others = ['8:orgid:a', '8:orgid:b'];
  assert.deepEqual(groupThread(me, others), {
    members: [{ id: me, role: 'Admin' }, { id: '8:orgid:a', role: 'Admin' }, { id: '8:orgid:b', role: 'Admin' }],
    properties: { threadType: 'chat' },
  });
  const chat = newGroupChat('19:g@thread.v2', me, others, 1_700_000_000_000);
  assert.equal(isGroupChat(chat), true);
  const directory = new TeamsDirectory();
  directory.remember('8:orgid:a', 'Fairouz');
  directory.remember('8:orgid:b', 'Emilie');
  assert.equal(chatRoom(me, chat, directory)?.name, 'Fairouz, Emilie');
  assert.equal(isGroupChat(newOneOnOne('8:orgid:00000000-0000-4000-8000-000000000001', '8:orgid:00000000-0000-4000-8000-000000000002', 0)), false);
  assert.equal(isGroupChat({ id: '19:m@thread.v2', chatType: 'meeting' }), false);
});

test('a reply is sent as the quote Teams reads back', () => {
  const rid = '19:c@thread.v2';
  const app = `[ ](https://teams.microsoft.com/direct/${encodeURIComponent(rid)}?msg=${encodeURIComponent(`${rid}/1792500000000`)}) bien vu`;
  assert.deepEqual(replyTarget(rid, app), { server: '1792500000000', rest: 'bien vu' });
  assert.deepEqual(replyTarget(rid, `[ ](${permalink(rid, '1792500000000')}) ok`), { server: '1792500000000', rest: 'ok' });
  assert.equal(replyTarget('19:other@thread.v2', app), null);
  assert.equal(replyTarget(rid, 'plain text'), null);
  const quote = replyQuote({ id: '1792500000000', from: 'https://x/v1/users/ME/contacts/8:orgid:marc', imdisplayname: 'Marc <B>', content: '<p>Je suis <b>outré</b></p>' }, new TeamsDirectory())!;
  const back = convert(`${quote}<p>bien vu</p>`, []);
  assert.equal(back.text, 'bien vu');
  assert.equal(back.quotes.length, 1);
  assert.deepEqual([back.quotes[0].id, back.quotes[0].author, back.quotes[0].authorMri, back.quotes[0].text], ['1792500000000', 'Marc <B>', '8:orgid:marc', 'Je suis outré']);
});

test('typed markdown becomes the HTML Teams renders, and reads back the same', async () => {
  const { toHtml } = await import('./outbox.ts');
  assert.equal(toHtml('**bold** _it_ ~~gone~~ `a<b`'), '<p><b>bold</b> <i>it</i> <s>gone</s> <code>a&lt;b</code></p>');
  assert.equal(toHtml('```\nfn x() {}\n  <y>\n```'), '<pre><code>fn x() {}\n  &lt;y&gt;</code></pre>');
  assert.equal(toHtml('# Title\n## Sub'), '<h1>Title</h1><h2>Sub</h2>');
  assert.equal(toHtml('- a\n- **b**\n1. one\n2. two'), '<ul><li>a</li><li><b>b</b></li></ul><ol><li>one</li><li>two</li></ol>');
  assert.equal(toHtml('> said\n> twice'), '<blockquote><p>said<br>twice</p></blockquote>');
  assert.equal(toHtml('see [docs](https://x.y/a_b) now'), '<p>see <a href="https://x.y/a_b">docs</a> now</p>');
  assert.equal(toHtml('snake_case_name and 2*3*4'), '<p>snake_case_name and 2<i>3</i>4</p>');
  assert.equal(toHtml('a <b> & "c"\nnext'), '<p>a &lt;b&gt; &amp; &quot;c&quot;</p><p>next</p>');
  assert.equal(toHtml(''), '<p></p>');
  for (const text of ['**bold** and _it_', '- a\n- b', '```\ncode\n```']) {
    assert.equal(convert(toHtml(text), []).text.trim(), text.trim(), text);
  }
});

test('the people a page names that the directory does not know, me left out', () => {
  const d = new TeamsDirectory();
  d.remember('8:orgid:aaa', 'Ada');
  const page = [
    { id: '1', from: 'https://x/contacts/8:orgid:me', properties: { emotions: [{ key: 'like', users: [{ mri: '8:orgid:bbb' }, { mri: '8:orgid:aaa' }, { mri: '8:orgid:me' }] }] } },
    { id: '2', messagetype: 'ThreadActivity/AddMember', from: 'https://x/contacts/19:c@thread.v2', content: '<addmember><initiator>8:orgid:ccc</initiator><target>8:orgid:ddd</target></addmember>' },
  ];
  assert.deepEqual(unknownPeople(page, d, '8:orgid:me'), ['8:orgid:bbb', '8:orgid:ccc', '8:orgid:ddd']);
});

test('a lagging list never rewinds a last message', () => {
  const held = { lastMessage: { id: '1793600000200', content: 'new' }, isRead: false };
  const listed = { lastMessage: { id: '1793600000100', content: 'old' }, isRead: true, displayName: 'x' };
  assert.equal(newerLast(held, listed), true);
  const merged = keepNewerLast(held, listed);
  assert.deepEqual([(merged.lastMessage as { content: string }).content, merged.isRead, merged.displayName], ['new', false, 'x']);
  const fresher = { lastMessage: { id: '1793600000300', content: 'newest' } };
  assert.equal((keepNewerLast(held, fresher).lastMessage as { content: string }).content, 'newest');
  assert.equal(newerLast({}, { lastMessage: { composeTime: '2026-11-06T10:00:00Z' } }), false);
});


test('HTML layout whitespace never starts a line', () => {
  assert.equal(htmlToMarkdown('<p>Réponse de Cloud Temple :<br>\n  Après vérification,&nbsp; rien</p>\n  <p>  Fin</p>'), 'Réponse de Cloud Temple :\nAprès vérification, rien\nFin');
  assert.equal(htmlToMarkdown('<p>a <b>b</b> c</p>'), 'a **b** c');
  assert.equal(htmlToMarkdown('<pre><code>  x\n    y</code></pre>'), '```\n  x\n    y\n```');
});

test('a Giphy GIF is an image with its link', () => {
  const gif = 'https://media4.giphy.com/media/abc/giphy.gif';
  const raw = { messagetype: 'RichText/Html', content: `<p><img alt="Sent a GIF" src="${gif}" itemtype="http://schema.skype.com/Giphy" width="200" height="150"></p>` };
  const found = JSON.parse(fileAttachments(raw)!) as Record<string, unknown>[];
  assert.equal(found[0]!.image_url, gif);
  assert.equal(found[0]!.title_link, gif);
  assert.deepEqual(found[0]!.image_dimensions, { width: 200, height: 150 });
  assert.ok(isGiphy('https://i.giphy.com/x.gif') && !isGiphy('https://giphy.com.evil.example/x.gif'));
});
