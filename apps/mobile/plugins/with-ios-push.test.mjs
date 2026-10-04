/**
 * The iOS plugin's Podfile patch, on the Expo 57 template excerpt it targets.
 * The extension target is judged on a real `expo prebuild --platform ios`
 * (see docs/PUSH.md).
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { modularPodfile, keychainGroup } = require('./with-ios-push.js').internals;

const TEMPLATE = `platform :ios, podfile_properties['ios.deploymentTarget'] || '16.4'

target 'rocketvibe' do
  use_expo_modules!

  config = use_native_modules!(config_command)
end
`;

test('the Firebase pods switch to modular_headers, in the target, after use_expo_modules!', () => {
  const output = modularPodfile(TEMPLATE);
  assert.match(output, /use_expo_modules!\n  pod 'FirebaseCore', :modular_headers => true\n/);
  for (const pod of ['FirebaseCoreInternal', 'FirebaseMessaging', 'GoogleUtilities']) {
    assert.match(output, new RegExp(`^  pod '${pod}', :modular_headers => true$`, 'm'));
  }
});

test('replaying the patch duplicates nothing', () => {
  const one = modularPodfile(TEMPLATE);
  assert.equal(modularPodfile(one), one);
});

test('a Podfile without use_expo_modules! stops the prebuild', () => {
  assert.throws(() => modularPodfile("target 'x' do\nend\n"), /use_expo_modules!/);
});

test('the keychain group is prefixed by the team, resolved by Xcode', () => {
  assert.equal(keychainGroup('com.rocketvibe.app'), '$(AppIdentifierPrefix)com.rocketvibe.app');
});
