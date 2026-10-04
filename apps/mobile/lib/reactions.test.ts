import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reactionList } from './reactions.ts';

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
