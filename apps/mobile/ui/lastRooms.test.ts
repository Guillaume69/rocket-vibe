import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readLastRooms, reopenDecision, writeLastRooms } from './lastRooms.ts';

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
});
