/**
 * The signing plugin's build.gradle patch, on the RN 0.86 template excerpt it
 * targets.
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

test('release signs with the app key, debug keeps its own', () => {
  const output = sign(TEMPLATE);
  assert.match(output, /release \{\s*\n\s*if \(System\.getenv\('RV_KEYSTORE'\)\)/);
  assert.match(output, /release \{\s*\n\s*signingConfig signingConfigs\.release/);
  assert.match(output, /debug \{\s*\n\s*signingConfig signingConfigs\.debug/);
  assert.match(output, /throw new GradleException/);
});

test('replaying prebuild duplicates nothing', () => {
  const one = sign(TEMPLATE);
  assert.equal(sign(one), one);
});

test('a changed template fails the prebuild', () => {
  assert.throws(() => sign('android { }'), /signingConfigs\.debug block not found/);
});
