import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { etoilePar, etoilesApres, idsEtoiles } from './marques.ts';

describe('idsEtoiles', () => {
  it('réduit `starred` aux uids, sans doublon', () => {
    assert.equal(idsEtoiles([{ _id: 'u1' }, { _id: 'u2' }, { _id: 'u1' }]), '["u1","u2"]');
  });

  it('rend null sans étoile ou sur une forme inattendue', () => {
    assert.equal(idsEtoiles(undefined), null);
    assert.equal(idsEtoiles([]), null);
    assert.equal(idsEtoiles('u1'), null);
    assert.equal(idsEtoiles([null, 3, { _id: '' }, { _id: 7 }]), null);
  });
});

describe('etoilePar', () => {
  it('dit si l’uid a étoilé le message', () => {
    assert.equal(etoilePar('["u1","u2"]', 'u2'), true);
    assert.equal(etoilePar('["u1"]', 'u2'), false);
    assert.equal(etoilePar(null, 'u1'), false);
    assert.equal(etoilePar('{pas du json', 'u1'), false);
  });
});

describe('etoilesApres', () => {
  it('ajoute l’uid une seule fois', () => {
    assert.equal(etoilesApres(null, 'u1', true), '["u1"]');
    assert.equal(etoilesApres('["u2","u1"]', 'u1', true), '["u2","u1"]');
  });

  it('retire l’uid et rend null quand il ne reste personne', () => {
    assert.equal(etoilesApres('["u1","u2"]', 'u1', false), '["u2"]');
    assert.equal(etoilesApres('["u1"]', 'u1', false), null);
    assert.equal(etoilesApres(null, 'u1', false), null);
  });
});
