import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { armUploadProbe, reportUploadEnd } from './uploadProbe.ts';

/** Module à état : chaque test repart débranché. */
beforeEach(() => {
  armUploadProbe(null);
});

describe('sonde de fin de téléversement', () => {
  test('une fois branchée, CHAQUE fin d’upload la déclenche', () => {
    let appels = 0;
    armUploadProbe(() => appels++);

    reportUploadEnd();
    reportUploadEnd();

    assert.equal(appels, 2, 'pas seulement le premier téléversement');
  });

  test('débranchée, plus rien ne part vers une session rangée', () => {
    let appels = 0;
    armUploadProbe(() => appels++);
    reportUploadEnd();

    armUploadProbe(null);
    reportUploadEnd();

    assert.equal(appels, 1, 'le signal d’après le débranchement est ignoré');
  });

  test('sans sonde branchée, signaler ne jette pas', () => {
    assert.doesNotThrow(() => reportUploadEnd());
  });

  test('une nouvelle session remplace la sonde de l’ancienne', () => {
    let ancienne = 0;
    let nouvelle = 0;
    armUploadProbe(() => ancienne++);
    armUploadProbe(() => nouvelle++);

    reportUploadEnd();

    assert.equal(ancienne, 0, 'l’ancien client ne doit plus être sondé');
    assert.equal(nouvelle, 1);
  });
});
