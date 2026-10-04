/**
 * The FCM plugin's config surgery, the only part that can be judged without
 * compiling.
 *
 * The Kotlin this plugin injects can only be checked by an `assembleRelease`
 * followed by a try on the device, that is accepted. But two LOAD-BEARING
 * properties are plain JavaScript, and until now they held by virtue of the
 * RN 0.86 template rather than of the plugin:
 *   - `android:priority="1"` on the service's intent-filter. Expo's is `-1`; a
 *     lower value would route FCM to expo and make the WHOLE Kotlin file
 *     unreachable, with no build error and no message;
 *   - where the `implementation` lines land. The substitution targeted the
 *     first occurrence of `dependencies {` at any depth.
 *
 * Tested as `.mjs`, not `.ts`: the subject IS CommonJS JavaScript loaded by
 * Expo at prebuild time. Transcribing it to TypeScript would test a copy, not
 * the file the tool runs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import plugin from './with-fcm-deeplink.js';

const {
  addDependencies,
  addReceiver,
  addService,
  declareComponents,
  escapeXml,
  kotlinSource,
  stringsXml,
  NATIVE_STRINGS,
  RECEIVER_CLASS,
  LEGACY_RECEIVER_CLASS,
  SERVICE_CLASS,
} = plugin.internals;

const DEPS = ['com.google.firebase:firebase-messaging:25.0.1', 'androidx.work:work-runtime:2.10.1'];

/** An app/build.gradle cut down to what matters: one root block, one nested. */
const GRADLE = `apply plugin: "com.android.application"

android {
    defaultConfig {
        applicationId "com.rocketvibe.app"
    }
    buildTypes {
        release {
            // An INDENTED block containing the word, to trap a lax regex.
            dependencies {
                nothing "here"
            }
        }
    }
}

dependencies {
    implementation("com.facebook.react:react-android")
}

apply plugin: 'com.google.gms.google-services'
`;

describe('addDependencies', () => {
  it('injects into the ROOT `dependencies` block, not a nested one', () => {
    const output = addDependencies(GRADLE, DEPS);
    const rootPos = output.search(/^dependencies \{/m);
    const nestedPos = output.indexOf('nothing "here"');
    for (const dep of DEPS) {
      const pos = output.indexOf(`implementation("${dep}")`);
      assert.ok(pos > rootPos, `${dep} should follow the root block`);
      assert.ok(pos > nestedPos, `${dep} must not have landed in the nested block`);
    }
  });

  it('declares each of the two artifacts exactly once', () => {
    const output = addDependencies(GRADLE, DEPS);
    for (const dep of DEPS) {
      assert.equal(output.split(`implementation("${dep}")`).length - 1, 1);
    }
  });

  it('adds nothing on a second pass (prebuild without --clean)', () => {
    const one = addDependencies(GRADLE, DEPS);
    assert.equal(addDependencies(one, DEPS), one);
  });

  it('leaves alone an artifact already present in ANOTHER version', () => {
    // Declaring a second one would split version resolution.
    const withValue = GRADLE.replace(
      /^dependencies \{/m,
      'dependencies {\n    implementation("androidx.work:work-runtime:2.9.0")',
    );
    const output = addDependencies(withValue, DEPS);
    assert.ok(output.includes('androidx.work:work-runtime:2.9.0'));
    assert.ok(!output.includes('androidx.work:work-runtime:2.10.1'));
  });

  it('THROWS if the gradle file has no root `dependencies` block', () => {
    // Leaving it untouched pushed the diagnosis much further: a Kotlin
    // compile error on a Firebase class not found.
    const withoutBlock = GRADLE.replace(/^dependencies \{[\s\S]*?^\}$/m, '');
    assert.ok(!/^dependencies \{/m.test(withoutBlock), 'the fixture must really lack the block');
    assert.throws(() => addDependencies(withoutBlock, DEPS), /dependencies/);
  });
});

describe('addService', () => {
  it('declares the service with priority 1 and the FCM action', () => {
    const application = {};
    addService(application);
    assert.equal(application.service.length, 1);
    const service = application.service[0];
    assert.equal(service.$['android:name'], `.${SERVICE_CLASS}`);
    assert.equal(service.$['android:exported'], 'false');
    // The exact value FCM routing depends on: expo's is -1.
    assert.equal(service['intent-filter'][0].$['android:priority'], '1');
    assert.equal(
      service['intent-filter'][0].action[0].$['android:name'],
      'com.google.firebase.MESSAGING_EVENT',
    );
  });

  it('does not declare it twice', () => {
    const application = {};
    addService(application);
    addService(application);
    assert.equal(application.service.length, 1);
  });

  it('keeps services already declared (expo\'s)', () => {
    const expo = { $: { 'android:name': 'expo.modules.notifications.service.NotificationsService' } };
    const application = { service: [expo] };
    addService(application);
    assert.equal(application.service.length, 2);
    assert.equal(application.service[0], expo);
  });
});

describe('addReceiver', () => {
  it('declares the "Reply" receiver, not exported, only once', () => {
    const other = { $: { 'android:name': 'expo.Other' } };
    const application = { receiver: [other] };
    addReceiver(application);
    addReceiver(application);
    assert.equal(application.receiver.length, 2);
    assert.equal(application.receiver[0], other);
    assert.equal(application.receiver[1].$['android:name'], `.${RECEIVER_CLASS}`);
    assert.equal(application.receiver[1].$['android:exported'], 'false');
  });

  it('the manifest also declares the receiver under its old name, which posted notifications still target', () => {
    const application = declareComponents({});
    assert.deepEqual(
      application.receiver.map((r) => r.$['android:name']),
      [`.${RECEIVER_CLASS}`, `.${LEGACY_RECEIVER_CLASS}`],
    );
    assert.equal(application.service[0].$['android:name'], `.${SERVICE_CLASS}`);
  });
});

describe('stringsXml', () => {
  it('renders the three native-path strings in both languages', () => {
    for (const language of ['fr', 'en']) {
      const xml = stringsXml(language);
      for (const [name, forms] of Object.entries(NATIVE_STRINGS)) {
        assert.ok(
          xml.includes(`<string name="${name}">`),
          `${name} missing in ${language}`,
        );
        assert.ok(xml.includes(forms[language]), `the ${language} form of ${name} is missing`);
      }
    }
  });

  it('escapes the apostrophe, which the resource compiler rejects bare', () => {
    // Tested on `escapeXml` and not on the rendering of the three strings: none
    // has an apostrophe today, so the assertion on `stringsXml` would pass even
    // without escaping, an empty test. The rule is for the NEXT string
    // ("Nouveau message d'Alice" would make aapt2 fail the build).
    assert.equal(escapeXml("Message d'Alice"), "Message d\\'Alice");
  });

  it('escapes XML entities', () => {
    assert.equal(escapeXml('Alice & <b>Bob</b>'), 'Alice &amp; &lt;b&gt;Bob&lt;/b&gt;');
    assert.equal(escapeXml('says "yes"'), 'says &quot;yes&quot;');
  });

  it('leaves no bare apostrophe in the output', () => {
    assert.ok(!/[^\\]'/.test(stringsXml('fr')), 'unescaped apostrophe in strings.xml');
  });

  it('produces a document the compiler can read', () => {
    const xml = stringsXml('en');
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
    assert.equal(xml.split('<resources>').length - 1, 1);
    assert.equal(xml.split('</resources>').length - 1, 1);
  });
});

describe('kotlinSource: the names of the previous build still resolve', () => {
  const source = kotlinSource('com.rocketvibe.app');

  it('the old receiver and worker classes exist, as subclasses of the new ones', () => {
    assert.match(source, new RegExp(`^class ${LEGACY_RECEIVER_CLASS} : ${RECEIVER_CLASS}\\(\\)$`, 'm'));
    assert.match(source, /^class RattrapagePushWorker\(context: Context, params: WorkerParameters\) : PushCatchUpWorker\(context, params\)$/m);
    assert.match(source, new RegExp(`^open class ${RECEIVER_CLASS} : BroadcastReceiver\\(\\)`, 'm'));
    assert.match(source, /^open class PushCatchUpWorker\(/m);
  });

  it('the old reply key, worker input, work prefix, shown memory and language key are still read', () => {
    assert.match(source, /getCharSequence\(LEGACY_REPLY_KEY\)/);
    assert.match(source, /LEGACY_REPLY_KEY = "rv_reponse"/);
    assert.match(source, /inputData\.getBoolean\("ombre", false\)/);
    assert.match(source, /cancelUniqueWork\(LEGACY_CATCH_UP_WORK_PREFIX \+ messageId\)/);
    assert.match(source, /LEGACY_CATCH_UP_WORK_PREFIX = "rattrapage-push-"/);
    assert.match(source, /getSharedPreferences\(LEGACY_PREFS_SHOWN, /);
    assert.match(source, /LEGACY_PREFS_SHOWN = "rvpush-affiches"/);
    assert.match(source, /"key_v1-preferred-language"[\s\S]{0,80}"key_v1-langue-preferee"/);
  });

  it('notifications link to the room/ route', () => {
    assert.match(source, /StringBuilder\("rocketvibe:\/\/room\/"\)/);
    assert.doesNotMatch(source, /rocketvibe:\/\/salon\//);
  });
});
