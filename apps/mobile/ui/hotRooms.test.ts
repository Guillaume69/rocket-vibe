import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { sessionToken } from './sessionToken.ts';
import { keepWarm, releaseHotRooms, roomCovered } from './hotRooms.ts';

/** Un jeu de relâcheurs qui note s'il a été appelé. */
function fixture() {
  const calls: number[] = [];
  return {
    calls,
    releases: [() => calls.push(1), () => calls.push(2)],
    release: () => calls.length > 0,
  };
}

describe('salonChaud', () => {
  beforeEach(() => releaseHotRooms());

  test('un salon jamais visité n’est pas couvert', () => {
    assert.equal(roomCovered('r1', 3), false);
  });

  test('sortir puis rentrer sous la MÊME génération : couvert, donc rien à rattraper', () => {
    keepWarm('r1', 3, fixture().releases, sessionToken());
    assert.equal(roomCovered('r1', 3), true);
  });

  test('après une coupure, la couverture tombe — le trou peut être de n’importe quelle taille', () => {
    keepWarm('r1', 3, fixture().releases, sessionToken());
    assert.equal(roomCovered('r1', 4), false);
  });

  test('deux allers-retours : le premier jeu de références est RELÂCHÉ, pas accumulé', () => {
    // Sans cela, chaque aller-retour laisserait une référence de plus sur le
    // stream et le salon ne se fermerait jamais vraiment.
    const first = fixture();
    const second = fixture();
    keepWarm('r1', 3, first.releases, sessionToken());
    keepWarm('r1', 3, second.releases, sessionToken());

    assert.deepEqual(first.calls, [1, 2], 'le premier jeu doit être relâché');
    assert.deepEqual(second.calls, [], 'le jeu courant reste tenu');
    assert.equal(roomCovered('r1', 3), true);
  });

  test('au-delà de 3 salons, le plus anciennement quitté est relâché', () => {
    const a = fixture();
    keepWarm('a', 1, a.releases, sessionToken());
    keepWarm('b', 1, fixture().releases, sessionToken());
    keepWarm('c', 1, fixture().releases, sessionToken());
    assert.equal(a.release(), false, 'trois salons tiennent sans éviction');

    keepWarm('d', 1, fixture().releases, sessionToken());

    assert.deepEqual(a.calls, [1, 2], 'le plus ancien est relâché');
    assert.equal(roomCovered('a', 1), false, 'et redevient un salon à rattraper');
    assert.equal(roomCovered('b', 1), true);
    assert.equal(roomCovered('d', 1), true);
  });

  test('revisiter un salon le rajeunit dans le LRU', () => {
    const a = fixture();
    keepWarm('a', 1, a.releases, sessionToken());
    keepWarm('b', 1, fixture().releases, sessionToken());
    keepWarm('c', 1, fixture().releases, sessionToken());
    // 'a' est revisité : il ne doit plus être le prochain évincé.
    const aBis = fixture();
    keepWarm('a', 1, aBis.releases, sessionToken());
    keepWarm('d', 1, fixture().releases, sessionToken());

    assert.equal(roomCovered('a', 1), true, '`a` a été rajeuni');
    assert.equal(roomCovered('b', 1), false, 'c’est `b` qui sort');
  });

  test('fin de session : tout est relâché', () => {
    const a = fixture();
    const b = fixture();
    keepWarm('a', 1, a.releases, sessionToken());
    keepWarm('b', 1, b.releases, sessionToken());

    releaseHotRooms();

    assert.deepEqual(a.calls, [1, 2]);
    assert.deepEqual(b.calls, [1, 2]);
    assert.equal(roomCovered('a', 1), false);
  });

  describe('l’entrée FANTÔME d’une session finie', () => {
    test('un écran qui se démonte APRÈS la purge ne repeuple pas la table', () => {
      // L'ordre réel : le cleanup du provider court AVANT celui des écrans
      // qu'il portait. `<Salon>` appelle donc `garderAuChaud` avec des
      // relâcheurs dont le client DDP est déjà `reinitialiser()`.
      const token = sessionToken(); // capturé au montage de l'écran
      const late = fixture();

      releaseHotRooms(); // le provider s'en va

      keepWarm('r1', 7, late.releases, token); // puis l'écran

      assert.deepEqual(late.calls, [1, 2], 'relâché sur-le-champ, pas mémorisé');
      assert.equal(roomCovered('r1', 7), false, 'aucune entrée fantôme');
    });

    test('sans le jeton, la session SUIVANTE croirait le salon couvert', () => {
      // C'est le dégât exact, et il est différé : le compteur de génération
      // repart de 0 à la session suivante. Dès qu'il repasse par la valeur
      // mémorisée, la garde répond « rien à rattraper » pour un salon que
      // cette socket-là n'a jamais écouté — éditions et suppressions manquées
      // ne sont alors jamais rapatriées.
      const token = sessionToken();
      releaseHotRooms();
      keepWarm('r1', 2, fixture().releases, token);

      // Session suivante : son compteur monte, et atteint 2.
      assert.equal(roomCovered('r1', 2), false);
    });

    test('le jeton NEUF, lui, est bien accepté — la garde ne bloque pas tout', () => {
      releaseHotRooms();
      const alive = fixture();
      keepWarm('r1', 1, alive.releases, sessionToken());

      assert.deepEqual(alive.calls, [], 'les références restent tenues');
      assert.equal(roomCovered('r1', 1), true);
    });
  });
});
