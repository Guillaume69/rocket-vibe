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
const MARQUEUR = 'rocket-vibe: partage-non-rejoue';

const GARDE = `    // ${MARQUEUR}
    if ((savedInstanceState != null || (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) &&
        (intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE)) {
      intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setComponent(componentName)
    }
`;

function neutraliser(source) {
  if (source.includes(MARQUEUR)) return source;
  const ancre = /override fun onCreate\(savedInstanceState: Bundle\?\) \{\n/;
  if (!ancre.test(source)) throw new Error('with-partage-entrant : MainActivity.onCreate introuvable');
  let sortie = source.replace(ancre, (debut) => debut + GARDE);
  if (!/^import android\.content\.Intent$/m.test(sortie)) {
    sortie = sortie.replace('import android.os.Bundle', 'import android.content.Intent\nimport android.os.Bundle');
  }
  return sortie;
}

module.exports = function withPartageEntrant(config) {
  return withMainActivity(config, (config) => {
    config.modResults.contents = neutraliser(config.modResults.contents);
    return config;
  });
};

module.exports.neutraliser = neutraliser;
