// Sans cette meta-data, une notification FCM reçue APP TUÉE est postée par le
// SDK Firebase sur `fcm_fallback_notification_channel` (importance DEFAULT,
// pas de heads-up) — le défaut relevé au spike 2.x, docs/PUSH.md. On la fait
// pointer vers le canal `default` que crée `lib/push.ts` (importance HIGH).
const { withAndroidManifest } = require('expo/config-plugins');

const NOM = 'com.google.firebase.messaging.default_notification_channel_id';

module.exports = function withCanalNotifications(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (application) {
      application['meta-data'] = application['meta-data'] ?? [];
      const deja = application['meta-data'].some((m) => m.$?.['android:name'] === NOM);
      if (!deja) {
        application['meta-data'].push({
          $: { 'android:name': NOM, 'android:value': 'default' },
        });
      }
    }
    return config;
  });
};
