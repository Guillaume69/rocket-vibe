import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { brancherSondeUpload, signalerFinUpload } from './sondeUpload.ts';

/** Module à état : chaque test repart débranché. */
beforeEach(() => {
  brancherSondeUpload(null);
});

describe('sonde de fin de téléversement', () => {
  test('une fois branchée, CHAQUE fin d’upload la déclenche', () => {
    let appels = 0;
    brancherSondeUpload(() => appels++);

    signalerFinUpload();
    signalerFinUpload();

    assert.equal(appels, 2, 'pas seulement le premier téléversement');
  });

  test('débranchée, plus rien ne part vers une session rangée', () => {
    let appels = 0;
    brancherSondeUpload(() => appels++);
    signalerFinUpload();

    brancherSondeUpload(null);
    signalerFinUpload();

    assert.equal(appels, 1, 'le signal d’après le débranchement est ignoré');
  });

  test('sans sonde branchée, signaler ne jette pas', () => {
    assert.doesNotThrow(() => signalerFinUpload());
  });

  test('une nouvelle session remplace la sonde de l’ancienne', () => {
    let ancienne = 0;
    let nouvelle = 0;
    brancherSondeUpload(() => ancienne++);
    brancherSondeUpload(() => nouvelle++);

    signalerFinUpload();

    assert.equal(ancienne, 0, 'l’ancien client ne doit plus être sondé');
    assert.equal(nouvelle, 1);
  });
});
