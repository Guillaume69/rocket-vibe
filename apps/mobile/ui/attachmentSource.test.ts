import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import {
  requestSource,
  isSheetMounted,
  answerSource,
  reportSheetUnmounted,
  reportSheetMounted,
} from './attachmentSource.ts';

/** Le canal est un module à état : chaque test repart d'une feuille absente. */
beforeEach(() => {
  answerSource(null);
  if (isSheetMounted()) reportSheetUnmounted();
});

describe('sourcePieceJointe', () => {
  test('la feuille répond AU TAP, sans se fermer — c’est tout l’enjeu', async () => {
    const wait = requestSource();
    reportSheetMounted();

    answerSource('library'); // le tap

    assert.equal(await wait, 'library');
    assert.equal(
      isSheetMounted(),
      true,
      'la feuille reste montée : le sélecteur part sur un arbre de vues immobile',
    );
  });

  test('fermée sans choix (balayage, retour matériel) : la demande est soldée à null', async () => {
    const wait = requestSource();
    reportSheetMounted();

    reportSheetUnmounted();

    assert.equal(await wait, null);
    assert.equal(isSheetMounted(), false);
  });

  test('après le démontage, le composeur ne doit PLUS fermer — sinon il dépile le salon', () => {
    requestSource();
    reportSheetMounted();
    assert.equal(isSheetMounted(), true);

    // L’usager balaie la feuille pendant que le sélecteur s’ouvre.
    reportSheetUnmounted();

    assert.equal(isSheetMounted(), false, 'le garde de `fermerFeuilleJoindre` doit être faux');
  });

  test('le démontage qui SUIT un choix ne réécrit rien — repondreSource est idempotent', async () => {
    const wait = requestSource();
    reportSheetMounted();

    answerSource('photo');
    reportSheetUnmounted(); // le back() du composeur, une fois le sélecteur revenu

    assert.equal(await wait, 'photo', 'le choix survit au démontage');
  });

  test('une nouvelle demande solde la précédente, restée en attente', async () => {
    const first = requestSource();
    const second = requestSource();

    answerSource('file');

    assert.equal(await first, null);
    assert.equal(await second, 'file');
  });

  test('répondre sans demande en cours ne jette pas', () => {
    assert.doesNotThrow(() => answerSource('video'));
  });
});
