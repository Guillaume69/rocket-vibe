import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { armUploadProbe, reportUploadEnd } from './uploadProbe.ts';

/** Stateful module: each test starts unplugged. */
beforeEach(() => {
  armUploadProbe(null);
});

describe('upload completion probe', () => {
  test('once plugged in, EVERY upload completion triggers it', () => {
    let calls = 0;
    armUploadProbe(() => calls++);

    reportUploadEnd();
    reportUploadEnd();

    assert.equal(calls, 2, 'not just the first upload');
  });

  test('unplugged, nothing goes to a closed session any more', () => {
    let calls = 0;
    armUploadProbe(() => calls++);
    reportUploadEnd();

    armUploadProbe(null);
    reportUploadEnd();

    assert.equal(calls, 1, 'the signal after unplugging is ignored');
  });

  test('with no probe plugged in, signalling does not throw', () => {
    assert.doesNotThrow(() => reportUploadEnd());
  });

  test("a new session replaces the old one's probe", () => {
    let old = 0;
    let next = 0;
    armUploadProbe(() => old++);
    armUploadProbe(() => next++);

    reportUploadEnd();

    assert.equal(old, 0, 'the old client must no longer be probed');
    assert.equal(next, 1);
  });
});
