/**
 * The EmojiCompat plugin's three patches: the bundled font dependency, the
 * removal of AppCompat's initializer, the init in MainApplication.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { addDependency, addInit, removeDefaultInitializer } =
  require('./with-emoji-compat.js').internals;

const GRADLE = `android {
}

dependencies {
    implementation("com.facebook.react:react-android")
}
`;

const MAIN_APPLICATION = `class MainApplication : Application(), ReactApplication {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
`;

test('declares emoji2-bundled once', () => {
  const once = addDependency(GRADLE);
  assert.match(once, /implementation\("androidx\.emoji2:emoji2-bundled:[\d.]+"\)/);
  assert.equal(addDependency(once), once);
});

test('refuses a build.gradle without a dependencies block', () => {
  assert.throws(() => addDependency('android {\n}\n'), /dependencies/);
});

test('initialises EmojiCompat right after super.onCreate, replacing every emoji', () => {
  const out = addInit(MAIN_APPLICATION);
  const init = out.indexOf('EmojiCompat.init(');
  assert.ok(init > out.indexOf('super.onCreate()'));
  assert.ok(init < out.indexOf('loadReactNative(this)'));
  assert.match(out, /BundledEmojiCompatConfig\(this\)\s*\.setReplaceAll\(true\)/);
  assert.match(out, /\.setUseAfterUpdatableSystemFonts\(true\)/);
  assert.equal(addInit(out), out);
});

test("removes AppCompat's initializer from androidx.startup's provider", () => {
  const manifest = { application: [{ $: {} }] };
  removeDefaultInitializer(manifest);
  removeDefaultInitializer(manifest);
  const [provider] = manifest.application[0].provider;
  assert.equal(provider.$['android:name'], 'androidx.startup.InitializationProvider');
  assert.equal(provider.$['tools:node'], 'merge');
  assert.deepEqual(provider['meta-data'], [
    { $: { 'android:name': 'androidx.emoji2.text.EmojiCompatInitializer', 'tools:node': 'remove' } },
  ]);
});

test('reuses a provider already declared', () => {
  const existing = { $: { 'android:name': 'androidx.startup.InitializationProvider' } };
  const manifest = { application: [{ $: {}, provider: [existing] }] };
  removeDefaultInitializer(manifest);
  assert.equal(manifest.application[0].provider.length, 1);
  assert.equal(existing['meta-data'].length, 1);
});
