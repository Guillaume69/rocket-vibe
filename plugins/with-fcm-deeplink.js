const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Aligné sur la version qu'expo-notifications embarque (transitive, non exposée
// au module app — d'où cette déclaration directe pour compiler la sous-classe).
const FIREBASE_MESSAGING = 'com.google.firebase:firebase-messaging:25.0.1';

/**
 * Répare le deep-link au tap d'une notification push.
 *
 * Rocket.Chat envoie un message FCM avec un bloc `notification` (title/body).
 * App tuée ou en arrière-plan, Firebase l'auto-affiche lui-même et câble le tap
 * sur son intent par défaut : expo-notifications est court-circuité, et
 * `getLastNotificationResponseAsync()` renvoie null — le tap n'ouvre donc jamais
 * la conversation (voir mémoire « deep-link du tap push cassé »).
 *
 * Le correctif : un `FirebaseMessagingService` de priorité supérieure à celui
 * d'expo (qui est à -1). Il retire le bloc `notification` avant de laisser
 * Firebase traiter le message → celui-ci devient « data-only » →
 * `onMessageReceived` est appelé même app tuée → expo affiche la notif lui-même
 * (avec notre icône fusée) ET pose son PendingIntent vers
 * `NotificationForwarderActivity` → le tap repasse par expo → deep-link OK.
 *
 * On recopie d'abord title/body du bloc `notification` dans les clés `data` que
 * lit expo (`title`, `message`), pour ne pas dépendre de ce que RC met
 * exactement dans son `data`.
 */

const SERVICE_CLASS = 'RocketVibeMessagingService';

function kotlinSource(pkg) {
  return `package ${pkg}

import android.content.Intent
import android.util.Log
import expo.modules.notifications.service.ExpoFirebaseMessagingService

/**
 * Généré par plugins/with-fcm-deeplink.js — ne pas éditer à la main.
 * android/ est gitignoré (CNG) et régénéré par \`expo prebuild\`.
 */
class ${SERVICE_CLASS} : ExpoFirebaseMessagingService() {
  override fun handleIntent(intent: Intent) {
    val extras = intent.extras
    if (extras != null) {
      val title = extras.getString(KEY_NOTIF_TITLE)
      val body = extras.getString(KEY_NOTIF_BODY)
      // Recopier dans les clés data lues par expo, sans écraser ce que RC fournit.
      if (title != null && extras.getString("title") == null) {
        extras.putString("title", title)
      }
      if (body != null && extras.getString("message") == null) {
        extras.putString("message", body)
      }
      // Sans bloc notification, expo lit le canal dans data["channelId"] : viser
      // notre canal "default" (créé par lib/push.ts) plutôt que son canal de repli.
      if (extras.getString("channelId") == null) {
        extras.putString("channelId", extras.getString(KEY_NOTIF_CHANNEL) ?: "default")
      }
      // Retirer tout le bloc notification → Firebase traite le message en data-only.
      for (key in ArrayList(extras.keySet())) {
        if (key.startsWith(NOTIF_PREFIX)) {
          extras.remove(key)
        }
      }
      intent.replaceExtras(extras)
      if (BuildConfig.DEBUG) {
        Log.d(TAG, "handleIntent: notif→data-only (title=" + title + ")")
      }
    }
    super.handleIntent(intent)
  }

  companion object {
    private const val TAG = "RVPush"
    private const val NOTIF_PREFIX = "gcm.notification."
    private const val KEY_NOTIF_TITLE = "gcm.notification.title"
    private const val KEY_NOTIF_BODY = "gcm.notification.body"
    private const val KEY_NOTIF_CHANNEL = "gcm.notification.android_channel_id"
  }
}
`;
}

function withServiceFile(config) {
  return withDangerousMod(config, [
    'android',
    (config) => {
      const pkg = config.android?.package;
      if (!pkg) {
        throw new Error('with-fcm-deeplink : android.package manquant dans app.json');
      }
      const dir = path.join(
        config.modRequest.platformProjectRoot,
        'app/src/main/java',
        pkg.replace(/\./g, '/'),
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${SERVICE_CLASS}.kt`), kotlinSource(pkg));
      return config;
    },
  ]);
}

function withServiceManifest(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('with-fcm-deeplink : <application> introuvable dans le manifeste');
    }
    application.service = application.service || [];
    const name = `.${SERVICE_CLASS}`;
    const deja = application.service.some((s) => s.$?.['android:name'] === name);
    if (!deja) {
      application.service.push({
        $: { 'android:name': name, 'android:exported': 'false' },
        'intent-filter': [
          {
            // Priorité > -1 (celle d'expo) : FCM route vers notre service.
            $: { 'android:priority': '1' },
            action: [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }],
          },
        ],
      });
    }
    return config;
  });
}

function withFirebaseMessagingDep(config) {
  return withAppBuildGradle(config, (config) => {
    const contents = config.modResults.contents;
    if (contents.includes('com.google.firebase:firebase-messaging')) {
      return config;
    }
    config.modResults.contents = contents.replace(
      /dependencies\s*\{/,
      (m) => `${m}\n    implementation("${FIREBASE_MESSAGING}")`,
    );
    return config;
  });
}

module.exports = function withFcmDeeplink(config) {
  config = withServiceFile(config);
  config = withServiceManifest(config);
  config = withFirebaseMessagingDep(config);
  return config;
};
