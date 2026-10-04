import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import {
  demanderSource,
  feuilleEstMontee,
  repondreSource,
  signalerFeuilleDemontee,
  signalerFeuilleMontee,
} from './attachmentSource.ts';

/** Le canal est un module à état : chaque test repart d'une feuille absente. */
beforeEach(() => {
  repondreSource(null);
  if (feuilleEstMontee()) signalerFeuilleDemontee();
});

describe('sourcePieceJointe', () => {
  test('la feuille répond AU TAP, sans se fermer — c’est tout l’enjeu', async () => {
    const attente = demanderSource();
    signalerFeuilleMontee();

    repondreSource('bibliotheque'); // le tap

    assert.equal(await attente, 'bibliotheque');
    assert.equal(
      feuilleEstMontee(),
      true,
      'la feuille reste montée : le sélecteur part sur un arbre de vues immobile',
    );
  });

  test('fermée sans choix (balayage, retour matériel) : la demande est soldée à null', async () => {
    const attente = demanderSource();
    signalerFeuilleMontee();

    signalerFeuilleDemontee();

    assert.equal(await attente, null);
    assert.equal(feuilleEstMontee(), false);
  });

  test('après le démontage, le composeur ne doit PLUS fermer — sinon il dépile le salon', () => {
    demanderSource();
    signalerFeuilleMontee();
    assert.equal(feuilleEstMontee(), true);

    // L’usager balaie la feuille pendant que le sélecteur s’ouvre.
    signalerFeuilleDemontee();

    assert.equal(feuilleEstMontee(), false, 'le garde de `fermerFeuilleJoindre` doit être faux');
  });

  test('le démontage qui SUIT un choix ne réécrit rien — repondreSource est idempotent', async () => {
    const attente = demanderSource();
    signalerFeuilleMontee();

    repondreSource('photo');
    signalerFeuilleDemontee(); // le back() du composeur, une fois le sélecteur revenu

    assert.equal(await attente, 'photo', 'le choix survit au démontage');
  });

  test('une nouvelle demande solde la précédente, restée en attente', async () => {
    const premiere = demanderSource();
    const seconde = demanderSource();

    repondreSource('fichier');

    assert.equal(await premiere, null);
    assert.equal(await seconde, 'fichier');
  });

  test('répondre sans demande en cours ne jette pas', () => {
    assert.doesNotThrow(() => repondreSource('video'));
  });
});
