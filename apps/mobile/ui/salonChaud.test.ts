import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { jetonSession } from './jetonSession.ts';
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
    garderAuChaud('r1', 3, jeu().relachers, jetonSession());
    assert.equal(salonCouvert('r1', 3), true);
  });

  test('après une coupure, la couverture tombe — le trou peut être de n’importe quelle taille', () => {
    garderAuChaud('r1', 3, jeu().relachers, jetonSession());
    assert.equal(salonCouvert('r1', 4), false);
  });

  test('deux allers-retours : le premier jeu de références est RELÂCHÉ, pas accumulé', () => {
    // Sans cela, chaque aller-retour laisserait une référence de plus sur le
    // stream et le salon ne se fermerait jamais vraiment.
    const premier = jeu();
    const second = jeu();
    garderAuChaud('r1', 3, premier.relachers, jetonSession());
    garderAuChaud('r1', 3, second.relachers, jetonSession());

    assert.deepEqual(premier.appels, [1, 2], 'le premier jeu doit être relâché');
    assert.deepEqual(second.appels, [], 'le jeu courant reste tenu');
    assert.equal(salonCouvert('r1', 3), true);
  });

  test('au-delà de 3 salons, le plus anciennement quitté est relâché', () => {
    const a = jeu();
    garderAuChaud('a', 1, a.relachers, jetonSession());
    garderAuChaud('b', 1, jeu().relachers, jetonSession());
    garderAuChaud('c', 1, jeu().relachers, jetonSession());
    assert.equal(a.relache(), false, 'trois salons tiennent sans éviction');

    garderAuChaud('d', 1, jeu().relachers, jetonSession());

    assert.deepEqual(a.appels, [1, 2], 'le plus ancien est relâché');
    assert.equal(salonCouvert('a', 1), false, 'et redevient un salon à rattraper');
    assert.equal(salonCouvert('b', 1), true);
    assert.equal(salonCouvert('d', 1), true);
  });

  test('revisiter un salon le rajeunit dans le LRU', () => {
    const a = jeu();
    garderAuChaud('a', 1, a.relachers, jetonSession());
    garderAuChaud('b', 1, jeu().relachers, jetonSession());
    garderAuChaud('c', 1, jeu().relachers, jetonSession());
    // 'a' est revisité : il ne doit plus être le prochain évincé.
    const aBis = jeu();
    garderAuChaud('a', 1, aBis.relachers, jetonSession());
    garderAuChaud('d', 1, jeu().relachers, jetonSession());

    assert.equal(salonCouvert('a', 1), true, '`a` a été rajeuni');
    assert.equal(salonCouvert('b', 1), false, 'c’est `b` qui sort');
  });

  test('fin de session : tout est relâché', () => {
    const a = jeu();
    const b = jeu();
    garderAuChaud('a', 1, a.relachers, jetonSession());
    garderAuChaud('b', 1, b.relachers, jetonSession());

    libererSalonsChauds();

    assert.deepEqual(a.appels, [1, 2]);
    assert.deepEqual(b.appels, [1, 2]);
    assert.equal(salonCouvert('a', 1), false);
  });

  describe('l’entrée FANTÔME d’une session finie', () => {
    test('un écran qui se démonte APRÈS la purge ne repeuple pas la table', () => {
      // L'ordre réel : le cleanup du provider court AVANT celui des écrans
      // qu'il portait. `<Salon>` appelle donc `garderAuChaud` avec des
      // relâcheurs dont le client DDP est déjà `reinitialiser()`.
      const jeton = jetonSession(); // capturé au montage de l'écran
      const tardif = jeu();

      libererSalonsChauds(); // le provider s'en va

      garderAuChaud('r1', 7, tardif.relachers, jeton); // puis l'écran

      assert.deepEqual(tardif.appels, [1, 2], 'relâché sur-le-champ, pas mémorisé');
      assert.equal(salonCouvert('r1', 7), false, 'aucune entrée fantôme');
    });

    test('sans le jeton, la session SUIVANTE croirait le salon couvert', () => {
      // C'est le dégât exact, et il est différé : le compteur de génération
      // repart de 0 à la session suivante. Dès qu'il repasse par la valeur
      // mémorisée, la garde répond « rien à rattraper » pour un salon que
      // cette socket-là n'a jamais écouté — éditions et suppressions manquées
      // ne sont alors jamais rapatriées.
      const jeton = jetonSession();
      libererSalonsChauds();
      garderAuChaud('r1', 2, jeu().relachers, jeton);

      // Session suivante : son compteur monte, et atteint 2.
      assert.equal(salonCouvert('r1', 2), false);
    });

    test('le jeton NEUF, lui, est bien accepté — la garde ne bloque pas tout', () => {
      libererSalonsChauds();
      const vivant = jeu();
      garderAuChaud('r1', 1, vivant.relachers, jetonSession());

      assert.deepEqual(vivant.appels, [], 'les références restent tenues');
      assert.equal(salonCouvert('r1', 1), true);
    });
  });
});
