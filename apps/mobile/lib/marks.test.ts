import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { starredBy, starredAfter, starredIds } from './marks.ts';

describe('idsEtoiles', () => {
  it('réduit `starred` aux uids, sans doublon', () => {
    assert.equal(starredIds([{ _id: 'u1' }, { _id: 'u2' }, { _id: 'u1' }]), '["u1","u2"]');
  });

  it('rend null sans étoile ou sur une forme inattendue', () => {
    assert.equal(starredIds(undefined), null);
    assert.equal(starredIds([]), null);
    assert.equal(starredIds('u1'), null);
    assert.equal(starredIds([null, 3, { _id: '' }, { _id: 7 }]), null);
  });
});

describe('etoilePar', () => {
  it('dit si l’uid a étoilé le message', () => {
    assert.equal(starredBy('["u1","u2"]', 'u2'), true);
    assert.equal(starredBy('["u1"]', 'u2'), false);
    assert.equal(starredBy(null, 'u1'), false);
    assert.equal(starredBy('{pas du json', 'u1'), false);
  });
});

describe('etoilesApres', () => {
  it('ajoute l’uid une seule fois', () => {
    assert.equal(starredAfter(null, 'u1', true), '["u1"]');
    assert.equal(starredAfter('["u2","u1"]', 'u1', true), '["u2","u1"]');
  });

  it('retire l’uid et rend null quand il ne reste personne', () => {
    assert.equal(starredAfter('["u1","u2"]', 'u1', false), '["u2"]');
    assert.equal(starredAfter('["u1"]', 'u1', false), null);
    assert.equal(starredAfter(null, 'u1', false), null);
  });
});
