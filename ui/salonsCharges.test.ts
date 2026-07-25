import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import {
  marquerSalonCharge,
  oublierSalonsCharges,
  salonChargeSous,
} from './salonsCharges.ts';

describe('salonsCharges', () => {
  beforeEach(() => oublierSalonsCharges());

  test('un salon jamais ouvert n’est pas chargé', () => {
    assert.equal(salonChargeSous('r1', 3), false);
  });

  test('sortir et rentrer sous la MÊME génération : rien à recharger', () => {
    // Le cas de l'utilisateur : on quitte le salon, on y revient tout de suite.
    marquerSalonCharge('r1', 3);
    assert.equal(salonChargeSous('r1', 3), true);
  });

  test('après un raccordement, la garde tombe — le trou peut être de n’importe quelle taille', () => {
    marquerSalonCharge('r1', 3);
    assert.equal(salonChargeSous('r1', 4), false);
  });

  test('une génération ANTÉRIEURE ne vaut pas non plus (générations non monotones)', () => {
    marquerSalonCharge('r1', 4);
    assert.equal(salonChargeSous('r1', 3), false);
  });

  test('les salons sont indépendants', () => {
    marquerSalonCharge('r1', 3);
    assert.equal(salonChargeSous('r2', 3), false);
  });

  test('fin de session : tout le cache est oublié', () => {
    marquerSalonCharge('r1', 3);
    marquerSalonCharge('r2', 3);
    oublierSalonsCharges();
    assert.equal(salonChargeSous('r1', 3), false);
    assert.equal(salonChargeSous('r2', 3), false);
  });
});
