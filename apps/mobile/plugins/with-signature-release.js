const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Signe les builds release avec LA clé de l'app, jamais avec la clé de debug
 * du template : Android refuse une mise à jour signée d'une autre clé, donc un
 * APK de la CI ne s'installerait pas par-dessus un APK construit ici, ni
 * l'inverse. La clé vient de l'environnement (RV_KEYSTORE, fichier ;
 * RV_KEYSTORE_PASSWORD, RV_KEY_ALIAS, RV_KEY_PASSWORD) : posée par
 * scripts/env.sh en local, par les secrets en CI. Sans elle, une tâche release
 * échoue au lieu de retomber en silence sur la clé de debug.
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
            "Build release sans la clé de l'app (RV_KEYSTORE vide) : source scripts/env.sh, qui la lit dans ~/.config/rocket-vibe/signature.env.")
    }
}
`;

function sign(gradle) {
  if (gradle.includes("System.getenv('RV_KEYSTORE')")) return gradle;
  const debug = /(signingConfigs \{\s*\n\s*debug \{[^}]*\})/;
  if (!debug.test(gradle)) throw new Error('with-signature-release : bloc signingConfigs.debug introuvable');
  let outbox = gradle.replace(debug, `$1${CONFIG_RELEASE}`);
  const release = /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!release.test(outbox)) throw new Error('with-signature-release : signingConfig du buildType release introuvable');
  outbox = outbox.replace(release, '$1signingConfig signingConfigs.release');
  return outbox + GUARD;
}

module.exports = function withSignatureRelease(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = sign(config.modResults.contents);
    return config;
  });
};

module.exports.sign = sign;
