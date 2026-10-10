const {
  withAndroidManifest,
  withAppBuildGradle,
  withMainApplication,
} = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

/**
 * Draws every emoji with Noto Color Emoji, the font the desktop and web apps
 * carry, instead of the phone's own (Samsung, Xiaomi… each draw their own, and
 * an old Android lacks the recent ones).
 *
 * Through AndroidX EmojiCompat with its bundled font (`emoji2-bundled`): React
 * Native's `ReactTextView` and `ReactEditText` are AppCompat views, whose emoji
 * helper replaces each emoji with an `EmojiSpan` drawn from that font, in the
 * composer as in messages. `setReplaceAll(true)` makes it replace all of them,
 * not only those the system font lacks (its default).
 * `setUseAfterUpdatableSystemFonts(true)` is just as necessary: since emoji2
 * 1.6, EmojiCompat does nothing at all on Android 15+ (API 35) without it,
 * trusting the system's updatable font, which is the phone maker's.
 *
 * AppCompat already initialises EmojiCompat through androidx.startup with the
 * downloadable font config (Google Play Services, missing emoji only), BEFORE
 * `Application.onCreate`, and the first `init` wins: its initializer is removed
 * from the merged manifest so ours, in `onCreate`, is the one.
 */
const EMOJI2_BUNDLED = 'androidx.emoji2:emoji2-bundled:1.7.0';
const DEPENDENCIES_BLOCK = /^dependencies\s*\{/m;

function addDependency(contents) {
  if (contents.includes('androidx.emoji2:emoji2-bundled')) return contents;
  if (!DEPENDENCIES_BLOCK.test(contents)) {
    throw new Error('with-emoji-compat: no top-level `dependencies {` block in app/build.gradle');
  }
  return contents.replace(
    DEPENDENCIES_BLOCK,
    (m) => `${m}\n    implementation("${EMOJI2_BUNDLED}")`,
  );
}

/** Removes AppCompat's EmojiCompatInitializer from androidx.startup's provider. */
function removeDefaultInitializer(manifest) {
  const application = manifest.application?.[0];
  if (!application) throw new Error('with-emoji-compat: <application> not found in the manifest');
  application.provider = application.provider || [];
  let provider = application.provider.find(
    (p) => p.$['android:name'] === 'androidx.startup.InitializationProvider',
  );
  if (!provider) {
    provider = {
      $: {
        'android:name': 'androidx.startup.InitializationProvider',
        'android:authorities': '${applicationId}.androidx-startup',
        'android:exported': 'false',
        'tools:node': 'merge',
      },
    };
    application.provider.push(provider);
  }
  provider['meta-data'] = provider['meta-data'] || [];
  const name = 'androidx.emoji2.text.EmojiCompatInitializer';
  if (!provider['meta-data'].some((m) => m.$['android:name'] === name)) {
    provider['meta-data'].push({ $: { 'android:name': name, 'tools:node': 'remove' } });
  }
  return manifest;
}

function addInit(contents) {
  return mergeContents({
    tag: 'rocketvibe-emoji-compat',
    src: contents,
    newSrc:
      '    androidx.emoji2.text.EmojiCompat.init(\n' +
      '      androidx.emoji2.bundled.BundledEmojiCompatConfig(this)\n' +
      '        .setReplaceAll(true)\n' +
      '        .setUseAfterUpdatableSystemFonts(true)\n' +
      '    )',
    anchor: /super\.onCreate\(\)/,
    offset: 1,
    comment: '//',
  }).contents;
}

module.exports = function withEmojiCompat(config) {
  config = withAppBuildGradle(config, (config) => {
    config.modResults.contents = addDependency(config.modResults.contents);
    return config;
  });
  config = withAndroidManifest(config, (config) => {
    config.modResults.manifest = removeDefaultInitializer(config.modResults.manifest);
    return config;
  });
  config = withMainApplication(config, (config) => {
    if (config.modResults.language !== 'kt') {
      throw new Error('with-emoji-compat: MainApplication is not Kotlin');
    }
    config.modResults.contents = addInit(config.modResults.contents);
    return config;
  });
  return config;
};

// For the tests, not for the app.
module.exports.internals = { addDependency, addInit, removeDefaultInitializer };
