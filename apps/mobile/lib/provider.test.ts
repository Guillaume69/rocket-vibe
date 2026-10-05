import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { normalizeProviderKind } from './provider.ts';

describe('normalizeProviderKind', () => {
  test('keeps a known kind', () => {
    assert.equal(normalizeProviderKind('rocketchat'), 'rocketchat');
  });

  test('sessions from before the field (undefined) fall back on rocketchat', () => {
    assert.equal(normalizeProviderKind(undefined), 'rocketchat');
  });

  test('any unknown or non-string value falls back on rocketchat', () => {
    assert.equal(normalizeProviderKind('slack'), 'rocketchat');
    assert.equal(normalizeProviderKind(42), 'rocketchat');
    assert.equal(normalizeProviderKind(null), 'rocketchat');
  });
});
