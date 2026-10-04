import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isViewTreeRejection, launchPickerWithRetry } from './launchPicker.ts';

const npeArbreDeVues = new Error(
  "Call to function 'ExponentImagePicker.launchImageLibraryAsync' has been rejected.\n" +
    "→ Caused by: java.lang.NullPointerException: Attempt to invoke virtual method 'void " +
    "android.view.View.dispatchCancelPendingInputEvents()' on a null object reference",
);

describe('lancerSelecteurAvecReprise', () => {
  test('le NPE d’arbre de vues est repris, après la pause', async () => {
    let appels = 0;
    let pause = 0;
    const resultat = await launchPickerWithRetry(
      () => (++appels === 1 ? Promise.reject(npeArbreDeVues) : Promise.resolve('ok')),
      (ms) => {
        pause = ms;
        return Promise.resolve();
      },
    );
    assert.equal(resultat, 'ok');
    assert.equal(appels, 2);
    assert.ok(pause > 0, 'la reprise attend la fin de l’animation de la sheet');
  });

  test('PLUSIEURS reprises : une seule ne suffisait pas en usage réel', async () => {
    let appels = 0;
    const resultat = await launchPickerWithRetry(
      () => (++appels < 4 ? Promise.reject(npeArbreDeVues) : Promise.resolve('ok')),
      () => Promise.resolve(),
    );
    assert.equal(resultat, 'ok');
    assert.equal(appels, 4, 'trois reprises après le premier essai');
  });

  test('les pauses vont CROISSANT — laisser plus de temps à chaque échec', async () => {
    const pauses: number[] = [];
    await assert.rejects(
      launchPickerWithRetry(
        () => Promise.reject(npeArbreDeVues),
        (ms) => {
          pauses.push(ms);
          return Promise.resolve();
        },
      ),
    );
    assert.ok(pauses.length >= 3, `au moins trois reprises, vu ${pauses.length}`);
    for (let i = 1; i < pauses.length; i++) {
      assert.ok(pauses[i] > pauses[i - 1], `pause ${i} (${pauses[i]}) > ${pauses[i - 1]}`);
    }
  });

  test('un échec qui persiste finit par ressortir — pas de boucle infinie', async () => {
    let appels = 0;
    await assert.rejects(
      launchPickerWithRetry(
        () => (++appels, Promise.reject(npeArbreDeVues)),
        () => Promise.resolve(),
      ),
      /dispatchCancelPendingInputEvents/,
    );
    assert.equal(appels, 4, 'un essai puis trois reprises, et on rend les armes');
  });

  test('tout autre rejet (permission, refus réel) ressort SANS reprise', async () => {
    let appels = 0;
    await assert.rejects(
      launchPickerWithRetry(() => (++appels, Promise.reject(new Error('User rejected permissions')))),
      /User rejected permissions/,
    );
    assert.equal(appels, 1);
  });

  test('le premier essai qui réussit passe tel quel', async () => {
    assert.equal(await launchPickerWithRetry(() => Promise.resolve(42)), 42);
  });
});

describe('estRejetArbreDeVues', () => {
  test('reconnaît le NPE d’Android, et lui seul', () => {
    assert.equal(isViewTreeRejection(npeArbreDeVues), true);
    assert.equal(isViewTreeRejection(new Error('User rejected permissions')), false);
    assert.equal(isViewTreeRejection('dispatchCancelPendingInputEvents'), false);
    assert.equal(isViewTreeRejection(null), false);
    assert.equal(isViewTreeRejection(undefined), false);
  });
});
