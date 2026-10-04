/**
 * La retouche de build.gradle du plugin de signature, sur l'extrait du gabarit
 * RN 0.86 qu'elle vise.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { sign } = require('./with-signature-release.js');

const TEMPLATE = `android {
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
  const outbox = sign(TEMPLATE);
  assert.match(outbox, /release \{\s*\n\s*if \(System\.getenv\('RV_KEYSTORE'\)\)/);
  assert.match(outbox, /release \{\s*\n\s*signingConfig signingConfigs\.release/);
  assert.match(outbox, /debug \{\s*\n\s*signingConfig signingConfigs\.debug/);
  assert.match(outbox, /throw new GradleException/);
});

test('rejouer le prebuild ne double rien', () => {
  const one = sign(TEMPLATE);
  assert.equal(sign(one), one);
});

test('un gabarit qui a changé fait échouer le prebuild', () => {
  assert.throws(() => sign('android { }'), /signingConfigs\.debug introuvable/);
});
