import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { filChargeSous, marquerFilCharge, oublierFilsCharges } from './loadedThreads.ts';
import { jetonSession } from './sessionToken.ts';

describe('filsCharges', () => {
  beforeEach(() => oublierFilsCharges());

  test('un fil jamais ouvert n’est pas chargé', () => {
    assert.equal(filChargeSous('f1', 3), false);
  });

  test('rouvrir sous la MÊME génération : rien à recharger', () => {
    // Le gaspillage évité : `chat.getMessage` puis toute la pagination du fil,
    // rejoués à CHAQUE raccordement parce que `generation` est dans les deps.
    marquerFilCharge('f1', 3, jetonSession());
    assert.equal(filChargeSous('f1', 3), true);
  });

  test('après un raccordement, la garde tombe', () => {
    marquerFilCharge('f1', 3, jetonSession());
    assert.equal(filChargeSous('f1', 4), false);
  });

  test('les fils sont indépendants, et n’ont rien à voir avec les salons', () => {
    marquerFilCharge('f1', 3, jetonSession());
    assert.equal(filChargeSous('f2', 3), false);
  });

  test('fin de session : tout le cache est oublié', () => {
    marquerFilCharge('f1', 3, jetonSession());
    oublierFilsCharges();
    assert.equal(filChargeSous('f1', 3), false);
  });

  test('un chargement qui ABOUTIT après la fin de session ne repeuple rien', () => {
    const jeton = jetonSession();
    oublierFilsCharges();
    marquerFilCharge('f1', 3, jeton);
    assert.equal(filChargeSous('f1', 3), false);
  });
});
