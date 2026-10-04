import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { normalizeProviderKind } from './provider.ts';

describe('normaliserGenre', () => {
  test('garde un genre connu', () => {
    assert.equal(normalizeProviderKind('rocketchat'), 'rocketchat');
  });

  test('les sessions d’avant le champ (undefined) retombent sur rocketchat', () => {
    assert.equal(normalizeProviderKind(undefined), 'rocketchat');
  });

  test('toute valeur inconnue ou non-chaîne retombe sur rocketchat', () => {
    assert.equal(normalizeProviderKind('slack'), 'rocketchat');
    assert.equal(normalizeProviderKind(42), 'rocketchat');
    assert.equal(normalizeProviderKind(null), 'rocketchat');
  });
});
