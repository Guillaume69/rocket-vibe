/**
 * La retouche de build.gradle du plugin de signature, sur l'extrait du gabarit
 * RN 0.86 qu'elle vise.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { signer } = require('./with-signature-release.js');

const GABARIT = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

test('le release signe avec la clé de l’app, le debug garde la sienne', () => {
  const sortie = signer(GABARIT);
  assert.match(sortie, /release \{\s*\n\s*if \(System\.getenv\('RV_KEYSTORE'\)\)/);
  assert.match(sortie, /release \{\s*\n\s*signingConfig signingConfigs\.release/);
  assert.match(sortie, /debug \{\s*\n\s*signingConfig signingConfigs\.debug/);
  assert.match(sortie, /throw new GradleException/);
});

test('rejouer le prebuild ne double rien', () => {
  const une = signer(GABARIT);
  assert.equal(signer(une), une);
});

test('un gabarit qui a changé fait échouer le prebuild', () => {
  assert.throws(() => signer('android { }'), /signingConfigs\.debug introuvable/);
});
