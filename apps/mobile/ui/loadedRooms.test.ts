import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { jetonSession } from './sessionToken.ts';
import {
  marquerSalonCharge,
  oublierSalonsCharges,
  salonChargeSous,
} from './loadedRooms.ts';

describe('salonsCharges', () => {
  beforeEach(() => oublierSalonsCharges());

  test('un salon jamais ouvert n’est pas chargé', () => {
    assert.equal(salonChargeSous('r1', 3), false);
  });

  test('sortir et rentrer sous la MÊME génération : rien à recharger', () => {
    // Le cas de l'utilisateur : on quitte le salon, on y revient tout de suite.
    marquerSalonCharge('r1', 3, jetonSession());
    assert.equal(salonChargeSous('r1', 3), true);
  });

  test('après un raccordement, la garde tombe — le trou peut être de n’importe quelle taille', () => {
    marquerSalonCharge('r1', 3, jetonSession());
    assert.equal(salonChargeSous('r1', 4), false);
  });

  test('une génération ANTÉRIEURE ne vaut pas non plus (générations non monotones)', () => {
    marquerSalonCharge('r1', 4, jetonSession());
    assert.equal(salonChargeSous('r1', 3), false);
  });

  test('les salons sont indépendants', () => {
    marquerSalonCharge('r1', 3, jetonSession());
    assert.equal(salonChargeSous('r2', 3), false);
  });

  test('fin de session : tout le cache est oublié', () => {
    marquerSalonCharge('r1', 3, jetonSession());
    marquerSalonCharge('r2', 3, jetonSession());
    oublierSalonsCharges();
    assert.equal(salonChargeSous('r1', 3), false);
    assert.equal(salonChargeSous('r2', 3), false);
  });

  test('un historique qui ABOUTIT après la fin de session ne repeuple rien', () => {
    // Le fetch est parti sous la session d'avant : sa marque vaudrait pour un
    // serveur qu'on a quitté, et ferait sauter l'historique d'ouverture à la
    // session suivante dès que son compteur atteint cette génération.
    const jeton = jetonSession();
    oublierSalonsCharges();
    marquerSalonCharge('r1', 3, jeton);
    assert.equal(salonChargeSous('r1', 3), false);
  });
});
