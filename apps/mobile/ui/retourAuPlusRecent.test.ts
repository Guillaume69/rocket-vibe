import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ETAT_RETOUR_INITIAL,
  loinDuPlusRecent,
  surAppuiRetour,
  surDefilementRetour,
  surGlisseRetour,
} from './retourAuPlusRecent.ts';

const HAUTEUR = 700;

describe('retour au plus récent', () => {
  test('visible au-delà d’un écran de remontée, pas en deçà', () => {
    assert.equal(loinDuPlusRecent(0, HAUTEUR), false);
    assert.equal(loinDuPlusRecent(HAUTEUR, HAUTEUR), false);
    assert.equal(loinDuPlusRecent(HAUTEUR + 1, HAUTEUR), true);
  });

  test('hauteur pas encore mesurée : jamais visible', () => {
    assert.equal(loinDuPlusRecent(5_000, 0), false);
  });

  test('le défilement allume puis éteint le bouton', () => {
    const loin = surDefilementRetour(ETAT_RETOUR_INITIAL, 1_500, HAUTEUR);
    assert.deepEqual(loin, { visible: true, retourEnCours: false });
    assert.equal(surDefilementRetour(loin, 1_600, HAUTEUR), loin);
    assert.deepEqual(surDefilementRetour(loin, 100, HAUTEUR), ETAT_RETOUR_INITIAL);
  });

  test('après un appui, l’animation de retour ne rallume pas le bouton', () => {
    let etat = surAppuiRetour();
    assert.equal(etat.visible, false);
    etat = surDefilementRetour(etat, 1_200, HAUTEUR);
    assert.deepEqual(etat, { visible: false, retourEnCours: true });
    etat = surDefilementRetour(etat, 300, HAUTEUR);
    assert.deepEqual(etat, ETAT_RETOUR_INITIAL);
    assert.equal(surDefilementRetour(etat, 1_200, HAUTEUR).visible, true);
  });

  test('un glissé pendant le retour rend la main au défilement', () => {
    const etat = surGlisseRetour(surAppuiRetour());
    assert.deepEqual(etat, ETAT_RETOUR_INITIAL);
    assert.equal(surDefilementRetour(etat, 1_200, HAUTEUR).visible, true);
  });
});
