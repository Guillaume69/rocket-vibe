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
 * Répare le deep-link au tap d'une notification push, et rend les pushes de
 * message GROUPÉS par salon (une notification « conversation » par salon, à la
 * WhatsApp, au lieu d'un empilement d'une notification par message).
 *
 * Rocket.Chat envoie un message FCM avec un bloc `notification` (title/body).
 * App tuée ou en arrière-plan, Firebase l'auto-affiche lui-même et câble le tap
 * sur son intent par défaut : expo-notifications est court-circuité, et
 * `getLastNotificationResponseAsync()` renvoie null — le tap n'ouvre donc jamais
 * la conversation (voir mémoire « deep-link du tap push cassé »).
 *
 * Le socle du correctif reste : un `FirebaseMessagingService` de priorité
 * supérieure à celui d'expo (qui est à -1), qui retire le bloc `notification`
 * pour rendre le message « data-only » (→ `handleIntent` appelé même app tuée).
 *
 * Ensuite, deux chemins :
 *   - Push de MESSAGE Rocket.Chat (un `ejson` avec `rid`) → on poste NOUS-MÊMES
 *     une notification `MessagingStyle` dont l'id dérive du `rid` : les messages
 *     successifs d'un même salon s'ACCUMULENT dans la même notification (le
 *     style précédent est ré-extrait et complété). Le tap porte un deep-link
 *     `rocketvibe://salon/<rid>` (géré par expo-router, à froid comme en
 *     marche) — plus besoin du circuit expo-notifications pour ces pushes.
 *   - Tout autre intent (autres pushes, messages sans `rid`) → route expo
 *     inchangée : title/body recopiés dans les clés `data` que lit expo
 *     (`title`, `message`), expo affiche et gère le tap comme avant.
 *
 * Salons CHIFFRÉS : `Push_show_message = true` fait transiter du ciphertext ;
 * si l'ejson porte `messageType: 'e2e'`, on substitue un texte générique —
 * même dégradation que côté JS (`ui/notifications.tsx`).
 */

const SERVICE_CLASS = 'RocketVibeMessagingService';

function kotlinSource(pkg) {
  return `package ${pkg}

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONObject

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
        val dump = extras.keySet().joinToString(", ") { k -> k + "=" + extras.get(k) }
        Log.d(TAG, "handleIntent data: " + dump)
      }
      // Push de message RC : notification « conversation » groupée par salon,
      // postée ICI. Le retour court-circuite expo, qui en posterait une seconde.
      if (posterNotifSalon(extras)) {
        return
      }
    }
    super.handleIntent(intent)
  }

  /**
   * Poste (ou complète) la notification MessagingStyle du salon. \`false\` si ce
   * push n'est pas un message de salon exploitable — l'appelant rend alors la
   * main à expo, qui affichera la notification simple d'avant.
   */
  private fun posterNotifSalon(extras: Bundle): Boolean {
    try {
      val ejsonBrut = extras.getString("ejson") ?: return false
      val ejson = JSONObject(ejsonBrut)
      val rid = ejson.optString("rid")
      if (rid.isEmpty()) return false
      val titre = extras.getString("title") ?: return false
      var texte = extras.getString("message") ?: return false

      // Même dégradation E2EE que côté JS : jamais de ciphertext à l'écran.
      if (ejson.optString("messageType") == "e2e") {
        texte = "Message chiffré"
      }

      val sender = ejson.optJSONObject("sender")
      val nomExpediteur = sender?.optString("name")?.takeIf { it.isNotEmpty() }
        ?: sender?.optString("username")?.takeIf { it.isNotEmpty() }
        ?: titre
      // RC préfixe souvent le texte de « username: » quand le nom est déjà
      // porté par la Person du style — on l'ôte pour ne pas l'afficher deux fois.
      val username = sender?.optString("username")
      if (username != null && username.isNotEmpty() && texte.startsWith(username + ": ")) {
        texte = texte.substring(username.length + 2)
      }

      val notifId = rid.hashCode()
      val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager

      // Ré-extraire le style de la notification active du même salon : les
      // messages précédents restent visibles, le nouveau s'ajoute à la suite.
      val active = manager.activeNotifications.firstOrNull { it.id == notifId }
      val style = active?.let {
        NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it.notification)
      } ?: NotificationCompat.MessagingStyle(Person.Builder().setName("Vous").build())

      // DM 1:1 : pas de titre de conversation, Android affiche le nom porté par
      // chaque message. Canal/groupe : le titre du push (« #general », …).
      if (ejson.optString("type") != "d") {
        style.setConversationTitle(titre)
      }
      style.addMessage(
        texte,
        System.currentTimeMillis(),
        Person.Builder().setName(nomExpediteur).build(),
      )

      // Le tap ouvre le salon par deep-link expo-router. CLEAR_TASK est
      // NÉCESSAIRE : process tué par le système mais task encore dans les
      // récents, la ramener délivre le VIEW en onNewIntent avant que le JS
      // n'écoute — l'URL se perd et on atterrit sur l'index (vérifié). En
      // recréant la task, le VIEW est l'intent INITIAL, chemin fiable à froid.
      val tap = Intent(
        Intent.ACTION_VIEW,
        Uri.parse("rocketvibe://salon/" + Uri.encode(rid)),
      ).setPackage(packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
      val pending = PendingIntent.getActivity(
        this,
        notifId,
        tap,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

      val icone = resources.getIdentifier("notification_icon", "drawable", packageName)
      val notification = NotificationCompat.Builder(this, "default")
        .setSmallIcon(if (icone != 0) icone else android.R.drawable.ic_dialog_email)
        .setColor(COULEUR_ACCENT)
        .setStyle(style)
        .setContentIntent(pending)
        .setAutoCancel(true)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .build()
      NotificationManagerCompat.from(this).notify(notifId, notification)
      if (BuildConfig.DEBUG) {
        Log.d(TAG, "notif salon postée (rid=" + rid + ", id=" + notifId + ")")
      }
      return true
    } catch (e: Exception) {
      // Un push mal formé ou un refus (POST_NOTIFICATIONS révoquée) ne doit pas
      // perdre la notification : on laisse expo afficher sa version simple.
      Log.w(TAG, "posterNotifSalon: repli expo", e)
      return false
    }
  }

  companion object {
    private const val TAG = "RVPush"
    private const val NOTIF_PREFIX = "gcm.notification."
    private const val KEY_NOTIF_TITLE = "gcm.notification.title"
    private const val KEY_NOTIF_BODY = "gcm.notification.body"
    private const val KEY_NOTIF_CHANNEL = "gcm.notification.android_channel_id"
    /** #FF5FA2 — la couleur d'accent déclarée pour expo-notifications (app.json). */
    private const val COULEUR_ACCENT = 0xFFFF5FA2.toInt()
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
