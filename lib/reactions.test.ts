import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listeReactions } from './reactions.ts';

describe('listeReactions', () => {
  it('rend [] sur null, un JSON illisible ou une forme inattendue', () => {
    assert.deepEqual(listeReactions(null, 'alice'), []);
    assert.deepEqual(listeReactions('{pas du json', 'alice'), []);
    assert.deepEqual(listeReactions('42', 'alice'), []);
    assert.deepEqual(listeReactions('[":+1:"]', 'alice'), []);
    assert.deepEqual(listeReactions('null', 'alice'), []);
  });

  it('projette codes (sans deux-points), totaux et appartenance, dans l’ordre du serveur', () => {
    const brut = JSON.stringify({
      ':+1:': { usernames: ['alice', 'bob'] },
      ':party_parrot:': { usernames: ['bob'] },
    });
    assert.deepEqual(listeReactions(brut, 'alice'), [
      { code: '+1', total: 2, parMoi: true },
      { code: 'party_parrot', total: 1, parMoi: false },
    ]);
  });

  it('`moi` null : les pastilles s’affichent, aucune n’est marquée mienne', () => {
    const brut = JSON.stringify({ ':heart:': { usernames: ['alice'] } });
    assert.deepEqual(listeReactions(brut, null), [{ code: 'heart', total: 1, parMoi: false }]);
  });

  it('ignore une entrée sans username exploitable, sans jeter le reste', () => {
    const brut = JSON.stringify({
      ':tada:': { usernames: [] },
      ':joy:': {},
      ':pray:': null,
      ':heart:': { usernames: [42, 'bob', null] },
    });
    // Les non-chaînes sont filtrées : `heart` ne compte que bob.
    assert.deepEqual(listeReactions(brut, 'bob'), [{ code: 'heart', total: 1, parMoi: true }]);
  });

  it('tolère une clé sans deux-points (défensif : elle reste telle quelle)', () => {
    const brut = JSON.stringify({ '+1': { usernames: ['alice'] } });
    assert.deepEqual(listeReactions(brut, 'alice'), [{ code: '+1', total: 1, parMoi: true }]);
  });

  it('ne confond pas un username qui CONTIENT le mien', () => {
    const brut = JSON.stringify({ ':+1:': { usernames: ['alice-bis'] } });
    assert.equal(listeReactions(brut, 'alice')[0]?.parMoi, false);
  });
});
