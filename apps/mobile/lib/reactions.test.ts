import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reactionList, reactionPeople, reactsWithAnyEmoji } from './reactions.ts';

describe('reactionList', () => {
  it('returns [] on null, unreadable JSON or an unexpected shape', () => {
    assert.deepEqual(reactionList(null, 'alice'), []);
    assert.deepEqual(reactionList('{not json', 'alice'), []);
    assert.deepEqual(reactionList('42', 'alice'), []);
    assert.deepEqual(reactionList('[":+1:"]', 'alice'), []);
    assert.deepEqual(reactionList('null', 'alice'), []);
  });

  it('projects codes (without colons), totals and membership, in server order', () => {
    const raw = JSON.stringify({
      ':+1:': { usernames: ['alice', 'bob'] },
      ':party_parrot:': { usernames: ['bob'] },
    });
    assert.deepEqual(reactionList(raw, 'alice'), [
      { code: '+1', total: 2, byMe: true },
      { code: 'party_parrot', total: 1, byMe: false },
    ]);
  });

  it('null `me`: the chips show, none is marked as mine', () => {
    const raw = JSON.stringify({ ':heart:': { usernames: ['alice'] } });
    assert.deepEqual(reactionList(raw, null), [{ code: 'heart', total: 1, byMe: false }]);
  });

  it('ignores an entry without a usable username, without dropping the rest', () => {
    const raw = JSON.stringify({
      ':tada:': { usernames: [] },
      ':joy:': {},
      ':pray:': null,
      ':heart:': { usernames: [42, 'bob', null] },
    });
    // Non-strings are filtered out: `heart` only counts bob.
    assert.deepEqual(reactionList(raw, 'bob'), [{ code: 'heart', total: 1, byMe: true }]);
  });

  it('tolerates a key without colons (defensive: it stays as is)', () => {
    const raw = JSON.stringify({ '+1': { usernames: ['alice'] } });
    assert.deepEqual(reactionList(raw, 'alice'), [{ code: '+1', total: 1, byMe: true }]);
  });

  it('does not mistake a username that CONTAINS mine', () => {
    const raw = JSON.stringify({ ':+1:': { usernames: ['alice-bis'] } });
    assert.equal(reactionList(raw, 'alice')[0]?.byMe, false);
  });
});

describe('reactionPeople', () => {
  it('lists who reacted per emoji, me first, with the names the row stored', () => {
    const raw = JSON.stringify({
      ':+1:': { usernames: ['bob', 'alice', 'carol'], names: ['Bob B', 'Alice A', ''] },
      ':tada:': { usernames: ['bob', 7] },
      ':x:': { usernames: [] },
    });
    assert.deepEqual(reactionPeople(raw, 'alice'), [
      {
        code: '+1',
        people: [
          { username: 'alice', name: 'Alice A' },
          { username: 'bob', name: 'Bob B' },
          { username: 'carol', name: null },
        ],
      },
      { code: 'tada', people: [{ username: 'bob', name: null }] },
    ]);
  });

  it('pairs names by position, an odd entry shifting nothing', () => {
    const raw = JSON.stringify({ ':+1:': { usernames: ['bob', 7, 'carol'], names: ['B', null, 'C'] } });
    assert.deepEqual(reactionPeople(raw, null)[0]?.people, [
      { username: 'bob', name: 'B' },
      { username: 'carol', name: 'C' },
    ]);
  });

  it('returns [] on null or unreadable JSON', () => {
    assert.deepEqual(reactionPeople(null, 'alice'), []);
    assert.deepEqual(reactionPeople('{', 'alice'), []);
  });
});

describe('reactsWithAnyEmoji', () => {
  it('lets Vibez and WhatsApp react with any standard emoji, not Rocket.Chat nor Slack', () => {
    assert.equal(reactsWithAnyEmoji('vibez'), true);
    assert.equal(reactsWithAnyEmoji('whatsapp'), true);
    assert.equal(reactsWithAnyEmoji('rocketchat'), false);
    assert.equal(reactsWithAnyEmoji('slack'), false);
    assert.equal(reactsWithAnyEmoji(undefined), false);
  });
});
