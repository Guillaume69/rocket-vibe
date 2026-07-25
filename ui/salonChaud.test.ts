import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { garderAuChaud, libererSalonsChauds, salonCouvert } from './salonChaud.ts';

/** Un jeu de relâcheurs qui note s'il a été appelé. */
function jeu() {
  const appels: number[] = [];
  return {
    appels,
    relachers: [() => appels.push(1), () => appels.push(2)],
    relache: () => appels.length > 0,
  };
}

describe('salonChaud', () => {
  beforeEach(() => libererSalonsChauds());

  test('un salon jamais visité n’est pas couvert', () => {
    assert.equal(salonCouvert('r1', 3), false);
  });

  test('sortir puis rentrer sous la MÊME génération : couvert, donc rien à rattraper', () => {
    garderAuChaud('r1', 3, jeu().relachers);
    assert.equal(salonCouvert('r1', 3), true);
  });

  test('après une coupure, la couverture tombe — le trou peut être de n’importe quelle taille', () => {
    garderAuChaud('r1', 3, jeu().relachers);
    assert.equal(salonCouvert('r1', 4), false);
  });

  test('deux allers-retours : le premier jeu de références est RELÂCHÉ, pas accumulé', () => {
    // Sans cela, chaque aller-retour laisserait une référence de plus sur le
    // stream et le salon ne se fermerait jamais vraiment.
    const premier = jeu();
    const second = jeu();
    garderAuChaud('r1', 3, premier.relachers);
    garderAuChaud('r1', 3, second.relachers);

    assert.deepEqual(premier.appels, [1, 2], 'le premier jeu doit être relâché');
    assert.deepEqual(second.appels, [], 'le jeu courant reste tenu');
    assert.equal(salonCouvert('r1', 3), true);
  });

  test('au-delà de 3 salons, le plus anciennement quitté est relâché', () => {
    const a = jeu();
    garderAuChaud('a', 1, a.relachers);
    garderAuChaud('b', 1, jeu().relachers);
    garderAuChaud('c', 1, jeu().relachers);
    assert.equal(a.relache(), false, 'trois salons tiennent sans éviction');

    garderAuChaud('d', 1, jeu().relachers);

    assert.deepEqual(a.appels, [1, 2], 'le plus ancien est relâché');
    assert.equal(salonCouvert('a', 1), false, 'et redevient un salon à rattraper');
    assert.equal(salonCouvert('b', 1), true);
    assert.equal(salonCouvert('d', 1), true);
  });

  test('revisiter un salon le rajeunit dans le LRU', () => {
    const a = jeu();
    garderAuChaud('a', 1, a.relachers);
    garderAuChaud('b', 1, jeu().relachers);
    garderAuChaud('c', 1, jeu().relachers);
    // 'a' est revisité : il ne doit plus être le prochain évincé.
    const aBis = jeu();
    garderAuChaud('a', 1, aBis.relachers);
    garderAuChaud('d', 1, jeu().relachers);

    assert.equal(salonCouvert('a', 1), true, '`a` a été rajeuni');
    assert.equal(salonCouvert('b', 1), false, 'c’est `b` qui sort');
  });

  test('fin de session : tout est relâché', () => {
    const a = jeu();
    const b = jeu();
    garderAuChaud('a', 1, a.relachers);
    garderAuChaud('b', 1, b.relachers);

    libererSalonsChauds();

    assert.deepEqual(a.appels, [1, 2]);
    assert.deepEqual(b.appels, [1, 2]);
    assert.equal(salonCouvert('a', 1), false);
  });
});
