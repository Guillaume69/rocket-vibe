import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { settingsCategory, visibleCategories, type SettingsContent } from './settingsCategories.ts';

const nothing: SettingsContent = {
  native: false,
  push: false,
  e2ee: false,
  encryptedIdentity: false,
  security: false,
  devices: false,
  bots: false,
  workflows: false,
};
const keys = (content: SettingsContent) => visibleCategories(content).map((c) => c.key);

describe('visibleCategories', () => {
  test('Rocket.Chat: notifications and encryption, never the native blocks', () => {
    assert.deepEqual(keys({ ...nothing, push: true, e2ee: true, security: true, devices: true, bots: true, workflows: true }), [
      'account', 'notifications', 'language', 'encryption', 'accounts', 'app',
    ]);
  });

  test('a native server offering nothing more keeps only what is always there', () => {
    assert.deepEqual(keys({ ...nothing, native: true }), ['account', 'language', 'accounts', 'app']);
  });

  test('a native server shows each block it offers, in the fixed order', () => {
    assert.deepEqual(
      keys({ native: true, push: true, e2ee: false, encryptedIdentity: true, security: true, devices: true, bots: true, workflows: true }),
      ['account', 'notifications', 'language', 'encryption', 'security', 'devices', 'bots', 'workflows', 'accounts', 'app'],
    );
  });
});

test('Mattermost and kChat: no push and no end-to-end encryption, so neither page', () => {
  assert.deepEqual(keys(nothing), ['account', 'language', 'accounts', 'app']);
});

test('bots: only a native server announcing them', () => {
  assert.ok(keys({ ...nothing, native: true, bots: true }).includes('bots'));
  assert.ok(!keys({ ...nothing, native: true }).includes('bots'));
  assert.ok(!keys({ ...nothing, bots: true }).includes('bots'));
});

test('workflows: only a native server announcing them, after the bots', () => {
  assert.ok(keys({ ...nothing, native: true, workflows: true }).includes('workflows'));
  assert.ok(!keys({ ...nothing, native: true }).includes('workflows'));
  assert.ok(!keys({ ...nothing, workflows: true }).includes('workflows'));
  assert.equal(settingsCategory('workflows'), 'workflows');
});

describe('settingsCategory', () => {
  test('reads a known category, refuses anything else', () => {
    assert.equal(settingsCategory('devices'), 'devices');
    assert.equal(settingsCategory('bots'), 'bots');
    assert.equal(settingsCategory('admin'), null);
    assert.equal(settingsCategory(['devices']), null);
    assert.equal(settingsCategory(undefined), null);
  });
});
