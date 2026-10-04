const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Signs release builds with THE app's key, never with the template's debug key:
 * Android refuses an update signed with another key, so a CI APK would not
 * install over an APK built here, nor the reverse. The key comes from the
 * environment (RV_KEYSTORE, a file; RV_KEYSTORE_PASSWORD, RV_KEY_ALIAS,
 * RV_KEY_PASSWORD): set by scripts/env.sh locally, by secrets in CI. Without it,
 * a release task fails instead of silently falling back to the debug key.
 */
const CONFIG_RELEASE = `
        release {
            if (System.getenv('RV_KEYSTORE')) {
                storeFile file(System.getenv('RV_KEYSTORE'))
                storePassword System.getenv('RV_KEYSTORE_PASSWORD')
                keyAlias System.getenv('RV_KEY_ALIAS')
                keyPassword System.getenv('RV_KEY_PASSWORD')
            }
        }`;

const GUARD = `
gradle.taskGraph.whenReady { graph ->
    if (graph.allTasks.any { it.name.contains('Release') } && !System.getenv('RV_KEYSTORE')) {
        throw new GradleException(
            "Release build without the app's key (RV_KEYSTORE empty): source scripts/env.sh, which reads it from ~/.config/rocket-vibe/signature.env.")
    }
}
`;

function sign(gradle) {
  if (gradle.includes("System.getenv('RV_KEYSTORE')")) return gradle;
  const debug = /(signingConfigs \{\s*\n\s*debug \{[^}]*\})/;
  if (!debug.test(gradle)) throw new Error('with-signature-release: signingConfigs.debug block not found');
  let output = gradle.replace(debug, `$1${CONFIG_RELEASE}`);
  const release = /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!release.test(output)) throw new Error('with-signature-release: signingConfig of the release buildType not found');
  output = output.replace(release, '$1signingConfig signingConfigs.release');
  return output + GUARD;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = sign(config.modResults.contents);
    return config;
  });
};

module.exports.sign = sign;
