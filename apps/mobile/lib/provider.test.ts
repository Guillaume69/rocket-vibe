import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { normaliserGenre } from './provider.ts';

describe('normaliserGenre', () => {
  test('garde un genre connu', () => {
    assert.equal(normaliserGenre('rocketchat'), 'rocketchat');
  });

  test('les sessions d’avant le champ (undefined) retombent sur rocketchat', () => {
    assert.equal(normaliserGenre(undefined), 'rocketchat');
  });

  test('toute valeur inconnue ou non-chaîne retombe sur rocketchat', () => {
    assert.equal(normaliserGenre('slack'), 'rocketchat');
    assert.equal(normaliserGenre(42), 'rocketchat');
    assert.equal(normaliserGenre(null), 'rocketchat');
  });
});
