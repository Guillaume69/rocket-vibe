const { withMainActivity } = require('expo/config-plugins');

/**
 * A share is never replayed. When Android recreates MainActivity (process
 * killed then relaunched, return through recents), it hands back the intent that
 * created the task: if it was a SEND, expo-share-intent reads it again in onCreate
 * and reopens the share screen on every launch. An activity that is restored
 * (savedInstanceState) or launched from history therefore carries no share: we
 * swap in the launcher's MAIN intent, before super.onCreate where the library's
 * listener reads it.
 */
const MARKER = 'rocket-vibe: share-not-replayed';

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
