import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { activityFeed, type FeedMessage, type FeedRoom, mentionsMe, othersReactions } from './activityFeed.ts';

const me = { userId: 'u-me', username: 'alice' };

function msg(id: string, over: Partial<FeedMessage> = {}): FeedMessage {
  return {
    id,
    rid: 'r1',
    text: 'hello',
    ts: Number(id.replace(/\D/g, '')) || 1,
    authorId: 'u-bob',
    authorName: 'bob',
    systemType: null,
    threadId: null,
    md: null,
    reactions: null,
    ...over,
  };
}

const mention = (name: string) => JSON.stringify([
  { type: 'PARAGRAPH', value: [{ type: 'PLAIN_TEXT', value: 'hi ' }, { type: 'MENTION_USER', value: { type: 'PLAIN_TEXT', value: name } }] },
]);

function feed(messages: FeedMessage[], extra: { roots?: { id: string; authorId: string; threadFollowers: string | null }[]; replied?: string[]; rooms?: FeedRoom[]; limit?: number } = {}) {
  return activityFeed({
    messages,
    roots: extra.roots ?? [],
    repliedThreads: extra.replied ?? [],
    rooms: extra.rooms ?? [],
    me,
    limit: extra.limit,
  });
}

describe('mentionsMe', () => {
  it('reads a MENTION_USER node of the tree: me, all, here', () => {
    assert.equal(mentionsMe(mention('alice'), 'whatever', 'alice'), true);
    assert.equal(mentionsMe(mention('all'), '', 'alice'), true);
    assert.equal(mentionsMe(mention('here'), '', 'alice'), true);
    assert.equal(mentionsMe(mention('carol'), '@alice', 'alice'), false, 'the tree wins over the text');
  });

  it('reads the text words when there is no tree (Mattermost, kChat)', () => {
    assert.equal(mentionsMe(null, 'ping @alice, please', 'alice'), true);
    assert.equal(mentionsMe(null, 'hey @all!', 'alice'), true);
    assert.equal(mentionsMe(null, '@here: standup', 'alice'), true);
    assert.equal(mentionsMe(null, 'hi @alicette', 'alice'), false);
    assert.equal(mentionsMe(null, 'mail alice@example.com', 'alice'), false);
    assert.equal(mentionsMe(null, 'hi @Alice', 'alice'), false, 'case-sensitive like notify');
    assert.equal(mentionsMe(null, null, 'alice'), false);
  });

  it('falls back to the text on an unreadable tree', () => {
    assert.equal(mentionsMe('{oops', 'hi @alice', 'alice'), true);
  });
});

describe('othersReactions', () => {
  it('keeps the other reactors, deduplicated in order, and their emojis', () => {
    const raw = JSON.stringify({ ':+1:': { usernames: ['bob', 'alice', 'carol'] }, ':tada:': { usernames: ['alice'] }, ':eyes:': { usernames: ['carol', 'dan'] } });
    assert.deepEqual(othersReactions(raw, 'alice'), { reactors: ['bob', 'carol', 'dan'], emojis: ['+1', 'eyes'] });
  });

  it('tolerates junk', () => {
    assert.deepEqual(othersReactions('nope', 'alice'), { reactors: [], emojis: [] });
    assert.deepEqual(othersReactions('[1]', 'alice'), { reactors: [], emojis: [] });
    assert.deepEqual(othersReactions(null, 'alice'), { reactors: [], emojis: [] });
  });
});

describe('activityFeed', () => {
  it('lists a mention by tree (Rocket.Chat) and by text (Mattermost)', () => {
    const { items } = feed([msg('m1', { md: mention('alice') }), msg('m2', { text: 'yo @alice' }), msg('m3', { text: 'nothing' })]);
    assert.deepEqual(items.map((i) => [i.kind, i.message.id]), [['mention', 'm2'], ['mention', 'm1']]);
  });

  it('counts @all and @here as mentions', () => {
    const { items } = feed([msg('m1', { text: '@all hi' }), msg('m2', { md: mention('here') })]);
    assert.deepEqual(items.map((i) => i.kind), ['mention', 'mention']);
  });

  it('never lists my own messages as mentions or replies, nor system, nor locked ones', () => {
    const { items } = feed([
      msg('m1', { authorId: me.userId, text: '@alice note to self', threadId: 't1' }),
      msg('m2', { systemType: 'uj', text: '@alice' }),
      msg('m3', { text: null, md: mention('alice'), systemType: 'e2e' }),
      msg('m4', { text: '@alice decrypted', systemType: 'e2e' }),
    ], { replied: ['t1'] });
    assert.deepEqual(items.map((i) => i.message.id), ['m4']);
  });

  it('lists a reply in a thread whose root I wrote', () => {
    const { items } = feed([msg('m2', { threadId: 'root' })], { roots: [{ id: 'root', authorId: me.userId, threadFollowers: null }] });
    assert.deepEqual(items.map((i) => [i.kind, i.message.id]), [['reply', 'm2']]);
  });

  it('lists a reply in a thread where I replied', () => {
    const { items } = feed([msg('m2', { threadId: 'root' })], { replied: ['root'] });
    assert.deepEqual(items.map((i) => i.kind), ['reply']);
  });

  it('lists a reply in a thread I follow (Rocket.Chat followers)', () => {
    const { items } = feed([msg('m2', { threadId: 'root' })], { roots: [{ id: 'root', authorId: 'u-bob', threadFollowers: JSON.stringify(['u-bob', me.userId]) }] });
    assert.deepEqual(items.map((i) => i.kind), ['reply']);
  });

  it('skips a reply in a thread I have nothing to do with', () => {
    const { items } = feed([msg('m2', { threadId: 'root' })], { roots: [{ id: 'root', authorId: 'u-bob', threadFollowers: JSON.stringify(['u-bob']) }], replied: ['other'] });
    assert.deepEqual(items, []);
  });

  it('a mention in my thread is a mention, not a reply (precedence)', () => {
    const { items } = feed([msg('m2', { threadId: 'root', text: 'look @alice' })], { replied: ['root'] });
    assert.deepEqual(items.map((i) => i.kind), ['mention']);
  });

  it('lists my message others reacted to, not one with only my own reaction', () => {
    const { items } = feed([
      msg('m1', { authorId: me.userId, reactions: JSON.stringify({ ':+1:': { usernames: ['alice', 'bob'] } }) }),
      msg('m2', { authorId: me.userId, reactions: JSON.stringify({ ':+1:': { usernames: ['alice'] } }) }),
      msg('m3', { authorId: 'u-bob', reactions: JSON.stringify({ ':+1:': { usernames: ['carol'] } }) }),
    ]);
    assert.equal(items.length, 1);
    const [item] = items;
    assert.equal(item.kind, 'reaction');
    assert.equal(item.message.id, 'm1');
    if (item.kind === 'reaction') {
      assert.deepEqual(item.reactors, ['bob']);
      assert.deepEqual(item.emojis, ['+1']);
    }
  });

  it('sorts newest first and keeps at most the limit', () => {
    const many = Array.from({ length: 150 }, (_, i) => msg(`m${i + 1}`, { text: '@alice' }));
    const { items } = feed(many);
    assert.equal(items.length, 100);
    assert.equal(items[0].message.id, 'm150');
    assert.equal(items[99].message.id, 'm51');
    assert.equal(feed(many, { limit: 3 }).items.length, 3);
  });

  it('lists the rooms with unread mentions but no mention item, newest activity first', () => {
    const { rooms } = feed([msg('m1', { rid: 'r1', text: '@alice' })], {
      rooms: [
        { rid: 'r1', mentions: 2, lastActivity: 50 },
        { rid: 'r2', mentions: 1, lastActivity: 10 },
        { rid: 'r3', mentions: 0, lastActivity: 99 },
        { rid: 'r4', mentions: 3, lastActivity: 40 },
        { rid: 'r5', mentions: 1, lastActivity: null },
      ],
    });
    assert.deepEqual(rooms.map((r) => r.rid), ['r4', 'r2', 'r5']);
  });

  it('a room whose only mention fell past the limit still gets its row', () => {
    const { rooms } = feed([msg('m2', { rid: 'r1', text: '@alice' }), msg('m1', { rid: 'r2', text: '@alice' })], {
      rooms: [{ rid: 'r1', mentions: 1, lastActivity: 2 }, { rid: 'r2', mentions: 1, lastActivity: 1 }],
      limit: 1,
    });
    assert.deepEqual(rooms.map((r) => r.rid), ['r2']);
  });
});
