import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { sessionToken } from './sessionToken.ts';
import {
  markRoomLoaded,
  forgetLoadedRooms,
  roomLoadedUnder,
} from './loadedRooms.ts';

describe('salonsCharges', () => {
  beforeEach(() => forgetLoadedRooms());

  test('un salon jamais ouvert n’est pas chargé', () => {
    assert.equal(roomLoadedUnder('r1', 3), false);
  });

  test('sortir et rentrer sous la MÊME génération : rien à recharger', () => {
    // Le cas de l'utilisateur : on quitte le salon, on y revient tout de suite.
    markRoomLoaded('r1', 3, sessionToken());
    assert.equal(roomLoadedUnder('r1', 3), true);
  });

  test('après un raccordement, la garde tombe — le trou peut être de n’importe quelle taille', () => {
    markRoomLoaded('r1', 3, sessionToken());
    assert.equal(roomLoadedUnder('r1', 4), false);
  });

  test('une génération ANTÉRIEURE ne vaut pas non plus (générations non monotones)', () => {
    markRoomLoaded('r1', 4, sessionToken());
    assert.equal(roomLoadedUnder('r1', 3), false);
  });

  test('les salons sont indépendants', () => {
    markRoomLoaded('r1', 3, sessionToken());
    assert.equal(roomLoadedUnder('r2', 3), false);
  });

  test('fin de session : tout le cache est oublié', () => {
    markRoomLoaded('r1', 3, sessionToken());
    markRoomLoaded('r2', 3, sessionToken());
    forgetLoadedRooms();
    assert.equal(roomLoadedUnder('r1', 3), false);
    assert.equal(roomLoadedUnder('r2', 3), false);
  });

  test('un historique qui ABOUTIT après la fin de session ne repeuple rien', () => {
    // Le fetch est parti sous la session d'avant : sa marque vaudrait pour un
    // serveur qu'on a quitté, et ferait sauter l'historique d'ouverture à la
    // session suivante dès que son compteur atteint cette génération.
    const jeton = sessionToken();
    forgetLoadedRooms();
    markRoomLoaded('r1', 3, jeton);
    assert.equal(roomLoadedUnder('r1', 3), false);
  });
});
