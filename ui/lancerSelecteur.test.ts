import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { lancerSelecteurAvecReprise } from './lancerSelecteur.ts';

const npeTransitoire = new Error(
  "Call to function 'ExponentImagePicker.launchImageLibraryAsync' has been rejected.\n" +
    "→ Caused by: java.lang.NullPointerException: Attempt to invoke virtual method 'void " +
    "android.view.View.dispatchCancelPendingInputEvents()' on a null object reference",
);

describe('lancerSelecteurAvecReprise', () => {
  test('le NPE transitoire de la formSheet est repris UNE fois, après la pause', async () => {
    let appels = 0;
    let pause = 0;
    const resultat = await lancerSelecteurAvecReprise(
      () => (++appels === 1 ? Promise.reject(npeTransitoire) : Promise.resolve('ok')),
      (ms) => {
        pause = ms;
        return Promise.resolve();
      },
    );
    assert.equal(resultat, 'ok');
    assert.equal(appels, 2);
    assert.ok(pause > 0, 'la reprise attend la fin de l’animation de la sheet');
  });

  test('un échec qui persiste à la reprise ressort — pas de boucle', async () => {
    let appels = 0;
    await assert.rejects(
      lancerSelecteurAvecReprise(
        () => (++appels, Promise.reject(npeTransitoire)),
        () => Promise.resolve(),
      ),
      /dispatchCancelPendingInputEvents/,
    );
    assert.equal(appels, 2);
  });

  test('tout autre rejet (permission, refus réel) ressort SANS reprise', async () => {
    let appels = 0;
    await assert.rejects(
      lancerSelecteurAvecReprise(() => (++appels, Promise.reject(new Error('User rejected permissions')))),
      /User rejected permissions/,
    );
    assert.equal(appels, 1);
  });

  test('le premier essai qui réussit passe tel quel', async () => {
    assert.equal(await lancerSelecteurAvecReprise(() => Promise.resolve(42)), 42);
  });
});
