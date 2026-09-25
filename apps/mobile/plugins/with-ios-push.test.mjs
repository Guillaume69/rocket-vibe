/**
 * La retouche du Podfile du plugin iOS, sur l'extrait du gabarit Expo 57
 * qu'elle vise. La cible de l'extension, elle, se juge sur un vrai
 * `expo prebuild --platform ios` (voir docs/PUSH.md).
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { podfileModulaire, groupeTrousseau } = require('./with-ios-push.js').chirurgie;

const GABARIT = `platform :ios, podfile_properties['ios.deploymentTarget'] || '16.4'

target 'rocketvibe' do
  use_expo_modules!

  config = use_native_modules!(config_command)
end
`;

test('les pods Firebase passent en modular_headers, dans la cible, après use_expo_modules!', () => {
  const sortie = podfileModulaire(GABARIT);
  assert.match(sortie, /use_expo_modules!\n  pod 'FirebaseCore', :modular_headers => true\n/);
  for (const pod of ['FirebaseCoreInternal', 'FirebaseMessaging', 'GoogleUtilities']) {
    assert.match(sortie, new RegExp(`^  pod '${pod}', :modular_headers => true$`, 'm'));
  }
});

test('rejouer la retouche ne duplique rien', () => {
  const une = podfileModulaire(GABARIT);
  assert.equal(podfileModulaire(une), une);
});

test('un Podfile sans use_expo_modules! arrête le prebuild', () => {
  assert.throws(() => podfileModulaire("target 'x' do\nend\n"), /use_expo_modules!/);
});

test("le groupe de trousseau est préfixé par l'équipe, résolu par Xcode", () => {
  assert.equal(groupeTrousseau('com.rocketvibe.app'), '$(AppIdentifierPrefix)com.rocketvibe.app');
});
