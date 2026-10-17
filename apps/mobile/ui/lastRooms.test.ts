import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createReopenRequest, readLastRooms, reopenDecision, writeLastRooms } from './lastRooms.ts';

describe('last rooms', () => {
  test('round-trips one room per account', () => {
    const rooms = new Map([
      ['https://a|1', 'general'],
      ['https://b|2', 'dev'],
    ]);
    assert.deepEqual(readLastRooms(writeLastRooms(rooms)), rooms);
  });

  test('a damaged or foreign value holds nothing', () => {
    assert.equal(readLastRooms(null).size, 0);
    assert.equal(readLastRooms('{not json').size, 0);
    assert.equal(readLastRooms('["general"]').size, 0);
    assert.deepEqual(readLastRooms('{"a|1":"general","b|2":3,"c|3":""}'), new Map([['a|1', 'general']]));
  });

  test('the room reopens once listed, never as a voice channel', () => {
    assert.equal(reopenDecision('general', []), 'wait');
    assert.equal(reopenDecision('general', [{ rid: 'dev' }, { rid: 'general' }]), 'open');
    assert.equal(reopenDecision('general', [{ rid: 'dev' }]), 'drop');
    assert.equal(reopenDecision('lounge', [{ rid: 'lounge', voice: true }]), 'drop');
  });

  test('the request names its account and settles once', () => {
    const rooms = new Map([
      ['a|1', 'general'],
      ['b|2', 'dev'],
    ]);
    const request = createReopenRequest();
    assert.equal(request.room('a|1', rooms), null);
    request.request('a|1');
    assert.equal(request.room('b|2', rooms), null);
    assert.equal(request.room('a|1', rooms), 'general');
    request.settle();
    assert.equal(request.room('a|1', rooms), null);
  });

  test('opening a room on the account settles its request, another account leaves it', () => {
    const rooms = new Map([['a|1', 'general']]);
    const request = createReopenRequest();
    request.request('a|1');
    request.opened('b|2');
    assert.equal(request.room('a|1', rooms), 'general');
    request.opened('a|1');
    assert.equal(request.room('a|1', rooms), null);
  });
});
