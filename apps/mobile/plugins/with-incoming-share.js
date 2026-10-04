const { withMainActivity } = require('expo/config-plugins');

/**
 * Un partage ne se rejoue pas. Quand Android recrée MainActivity (processus
 * tué puis relancé, retour par les récents), il lui rend l'intent qui a créé la
 * tâche : si c'était un SEND, expo-share-intent le relit dans onCreate et
 * rouvre l'écran de partage à chaque lancement. Une activité restaurée
 * (savedInstanceState) ou lancée depuis l'historique ne porte donc plus de
 * partage : on lui substitue l'intent MAIN du lanceur, avant super.onCreate où
 * lit le listener de la bibliothèque.
 */
const MARKER = 'rocket-vibe: partage-non-rejoue';

const GUARD = `    // ${MARKER}
    if ((savedInstanceState != null || (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) &&
        (intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE)) {
      intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setComponent(componentName)
    }
`;

function neutralize(source) {
  if (source.includes(MARKER)) return source;
  const anchor = /override fun onCreate\(savedInstanceState: Bundle\?\) \{\n/;
  if (!anchor.test(source)) throw new Error('with-incoming-share: MainActivity.onCreate not found');
  let outbox = source.replace(anchor, (start) => start + GUARD);
  if (!/^import android\.content\.Intent$/m.test(outbox)) {
    outbox = outbox.replace('import android.os.Bundle', 'import android.content.Intent\nimport android.os.Bundle');
  }
  return outbox;
}

module.exports = function withIncomingShare(config) {
  return withMainActivity(config, (config) => {
    config.modResults.contents = neutralize(config.modResults.contents);
    return config;
  });
};

module.exports.neutralize = neutralize;
