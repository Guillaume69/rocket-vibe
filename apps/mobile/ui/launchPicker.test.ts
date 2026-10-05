import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isViewTreeRejection, launchPickerWithRetry } from './launchPicker.ts';

const viewTreeNpe = new Error(
  "Call to function 'ExponentImagePicker.launchImageLibraryAsync' has been rejected.\n" +
    "→ Caused by: java.lang.NullPointerException: Attempt to invoke virtual method 'void " +
    "android.view.View.dispatchCancelPendingInputEvents()' on a null object reference",
);

describe('launchPickerWithRetry', () => {
  test('the view-tree NPE is retried, after the pause', async () => {
    let calls = 0;
    let pause = 0;
    const result = await launchPickerWithRetry(
      () => (++calls === 1 ? Promise.reject(viewTreeNpe) : Promise.resolve('ok')),
      (ms) => {
        pause = ms;
        return Promise.resolve();
      },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
    assert.ok(pause > 0, 'the retry waits for the end of the sheet animation');
  });

  test('SEVERAL retries: a single one was not enough in real use', async () => {
    let calls = 0;
    const result = await launchPickerWithRetry(
      () => (++calls < 4 ? Promise.reject(viewTreeNpe) : Promise.resolve('ok')),
      () => Promise.resolve(),
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 4, 'three retries after the first attempt');
  });

  test('pauses GROW: more time after each failure', async () => {
    const pauses: number[] = [];
    await assert.rejects(
      launchPickerWithRetry(
        () => Promise.reject(viewTreeNpe),
        (ms) => {
          pauses.push(ms);
          return Promise.resolve();
        },
      ),
    );
    assert.ok(pauses.length >= 3, `at least three retries, got ${pauses.length}`);
    for (let i = 1; i < pauses.length; i++) {
      assert.ok(pauses[i] > pauses[i - 1], `pause ${i} (${pauses[i]}) > ${pauses[i - 1]}`);
    }
  });

  test('a persistent failure eventually surfaces: no infinite loop', async () => {
    let calls = 0;
    await assert.rejects(
      launchPickerWithRetry(
        () => (++calls, Promise.reject(viewTreeNpe)),
        () => Promise.resolve(),
      ),
      /dispatchCancelPendingInputEvents/,
    );
    assert.equal(calls, 4, 'one attempt then three retries, then we give up');
  });

  test('any other rejection (permission, real refusal) surfaces WITHOUT retry', async () => {
    let calls = 0;
    await assert.rejects(
      launchPickerWithRetry(() => (++calls, Promise.reject(new Error('User rejected permissions')))),
      /User rejected permissions/,
    );
    assert.equal(calls, 1);
  });

  test('the first successful attempt passes through', async () => {
    assert.equal(await launchPickerWithRetry(() => Promise.resolve(42)), 42);
  });
});

describe('isViewTreeRejection', () => {
  test('recognises the Android NPE, and only it', () => {
    assert.equal(isViewTreeRejection(viewTreeNpe), true);
    assert.equal(isViewTreeRejection(new Error('User rejected permissions')), false);
    assert.equal(isViewTreeRejection('dispatchCancelPendingInputEvents'), false);
    assert.equal(isViewTreeRejection(null), false);
    assert.equal(isViewTreeRejection(undefined), false);
  });
});
