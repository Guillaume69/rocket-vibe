import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { armUploadProbe, reportUploadEnd } from './uploadProbe.ts';

/** Module à état : chaque test repart débranché. */
beforeEach(() => {
  armUploadProbe(null);
});

describe('sonde de fin de téléversement', () => {
  test('une fois branchée, CHAQUE fin d’upload la déclenche', () => {
    let calls = 0;
    armUploadProbe(() => calls++);

    reportUploadEnd();
    reportUploadEnd();

    assert.equal(calls, 2, 'pas seulement le premier téléversement');
  });

  test('débranchée, plus rien ne part vers une session rangée', () => {
    let calls = 0;
    armUploadProbe(() => calls++);
    reportUploadEnd();

    armUploadProbe(null);
    reportUploadEnd();

    assert.equal(calls, 1, 'le signal d’après le débranchement est ignoré');
  });

  test('sans sonde branchée, signaler ne jette pas', () => {
    assert.doesNotThrow(() => reportUploadEnd());
  });

  test('une nouvelle session remplace la sonde de l’ancienne', () => {
    let old = 0;
    let next = 0;
    armUploadProbe(() => old++);
    armUploadProbe(() => next++);

    reportUploadEnd();

    assert.equal(old, 0, 'l’ancien client ne doit plus être sondé');
    assert.equal(next, 1);
  });
});
