import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { starredBy, starredAfter, starredIds } from './marks.ts';

describe('starredIds', () => {
  it('reduces `starred` to uids, without duplicates', () => {
    assert.equal(starredIds([{ _id: 'u1' }, { _id: 'u2' }, { _id: 'u1' }]), '["u1","u2"]');
  });

  it('returns null with no star or on an unexpected shape', () => {
    assert.equal(starredIds(undefined), null);
    assert.equal(starredIds([]), null);
    assert.equal(starredIds('u1'), null);
    assert.equal(starredIds([null, 3, { _id: '' }, { _id: 7 }]), null);
  });
});

describe('starredBy', () => {
  it('tells whether the uid starred the message', () => {
    assert.equal(starredBy('["u1","u2"]', 'u2'), true);
    assert.equal(starredBy('["u1"]', 'u2'), false);
    assert.equal(starredBy(null, 'u1'), false);
    assert.equal(starredBy('{not json', 'u1'), false);
  });
});

describe('starredAfter', () => {
  it('adds the uid only once', () => {
    assert.equal(starredAfter(null, 'u1', true), '["u1"]');
    assert.equal(starredAfter('["u2","u1"]', 'u1', true), '["u2","u1"]');
  });

  it('removes the uid and returns null when nobody is left', () => {
    assert.equal(starredAfter('["u1","u2"]', 'u1', false), '["u2"]');
    assert.equal(starredAfter('["u1"]', 'u1', false), null);
    assert.equal(starredAfter(null, 'u1', false), null);
  });
});
