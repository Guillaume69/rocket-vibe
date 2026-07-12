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
 * CONTENU PRIVÉ (réglage RC « Hide message content from Apple and Google »,
 * `Push_request_content_from_server`, plan Premium) : quand il est actif, le
 * push ne porte QUE `{ host, messageId, notificationType: 'message-id-only' }` —
 * ni contenu, ni rid, ni expéditeur (le texte ne transite donc jamais chez
 * Google/Apple). On va alors chercher le contenu NOUS-MÊMES : lecture de la
 * session stockée par expo-secure-store (déchiffrement AES/GCM via l'
 * AndroidKeyStore, sans runtime JS car l'app peut être tuée), puis
 * `GET /api/v1/push.get?id=<messageId>` authentifié, qui renvoie exactement la
 * notification complète (title/text/payload) qu'on affiche comme ci-dessus.
 * Échec (hors ligne, jeton périmé) → notification « Nouveau message ».
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
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec

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
   * Aiguille un push de message vers l'affichage. \`false\` si ce push n'est pas
   * un message de salon exploitable — l'appelant rend alors la main à expo.
   *
   * Deux régimes selon le réglage serveur « Hide message content from Apple and
   * Google » (Push_request_content_from_server, plan Premium) :
   *   - désactivé → le contenu est dans le push, on l'affiche directement ;
   *   - activé → le push ne porte qu'un messageId (notificationType ==
   *     "message-id-only"), on va chercher le contenu NOUS-MÊMES via push.get :
   *     il ne transite alors jamais par Google/Apple.
   */
  private fun posterNotifSalon(extras: Bundle): Boolean {
    try {
      val ejsonBrut = extras.getString("ejson") ?: return false
      val ejson = JSONObject(ejsonBrut)

      // Contenu masqué côté serveur : le push ne porte qu'un messageId.
      if (ejson.optString("notificationType") == "message-id-only") {
        return recupererEtPoster(ejson)
      }

      // Contenu présent dans le push (réglage désactivé, ou serveur sans plan).
      val rid = ejson.optString("rid")
      if (rid.isEmpty()) return false
      val titre = extras.getString("title") ?: return false
      val texte = extras.getString("message") ?: return false
      // (debug) Le serveur local n'active jamais le mode message-id-only
      // (réglage enterprise inerte sans licence) : on rejoue le circuit privé
      // sur un push ordinaire pour le prouver de bout en bout en local.
      if (BuildConfig.DEBUG) verifierPushGetEnDebug(ejson)
      return afficherNotifSalon(rid, titre, texte, ejson)
    } catch (e: Exception) {
      // Un push mal formé ou un refus (POST_NOTIFICATIONS révoquée) ne doit pas
      // perdre la notification : on laisse expo afficher sa version simple.
      Log.w(TAG, "posterNotifSalon: repli expo", e)
      return false
    }
  }

  /**
   * Chemin « contenu privé » : le push n'a livré qu'un messageId. On lit la
   * session stockée (expo-secure-store, sans runtime JS), on demande le contenu
   * au serveur (push.get, authentifié), puis on affiche la notification de
   * salon. Toute défaillance (hors ligne, jeton périmé, creds absentes) tombe
   * sur une notification « Nouveau message » : jamais de contenu chez le
   * transporteur, jamais de notification perdue.
   */
  private fun recupererEtPoster(ejsonPush: JSONObject): Boolean {
    val messageId = ejsonPush.optString("messageId")
    val host = ejsonPush.optString("host")
    if (messageId.isEmpty() || host.isEmpty()) return false

    val session = lireSession(host)
    val notif = session?.let { recupererContenu(host, messageId, it) }
    if (notif == null) {
      posterNotifDegradee(messageId)
      return true
    }
    val payload = notif.optJSONObject("payload")
    val rid = payload?.optString("rid") ?: ""
    if (payload == null || rid.isEmpty()) {
      posterNotifDegradee(messageId)
      return true
    }
    return afficherNotifSalon(rid, notif.optString("title"), notif.optString("text"), payload)
  }

  /**
   * Construit (ou complète) la notification MessagingStyle du salon à partir de
   * champs normalisés : titre, texte, et l'objet portant sender/type/
   * messageType (payload REST ou ejson du push, même forme). Partagé par les
   * deux régimes.
   */
  private fun afficherNotifSalon(
    rid: String,
    titre: String,
    texteInitial: String,
    ejson: JSONObject,
  ): Boolean {
    var texte = texteInitial

    // Même dégradation E2EE que côté JS : jamais de ciphertext à l'écran.
    if (ejson.optString("messageType") == "e2e") {
      texte = "Message chiffré"
    }

    val sender = ejson.optJSONObject("sender")
    val nomExpediteur = sender?.optString("name")?.takeIf { it.isNotEmpty() }
      ?: sender?.optString("username")?.takeIf { it.isNotEmpty() }
      ?: titre
    // RC préfixe souvent le texte de « username: » quand le nom est déjà porté
    // par la Person du style — on l'ôte pour ne pas l'afficher deux fois.
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
  }

  /**
   * Repli quand le contenu n'a pas pu être récupéré : sans rid on ne peut ni
   * grouper ni deep-linker, on ouvre simplement l'app au tap.
   */
  private fun posterNotifDegradee(messageId: String) {
    try {
      val notifId = if (messageId.isNotEmpty()) messageId.hashCode() else 0
      val ouvrir = packageManager.getLaunchIntentForPackage(packageName)
        ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val pending = PendingIntent.getActivity(
        this,
        notifId,
        ouvrir ?: Intent(),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val titre = try {
        applicationInfo.loadLabel(packageManager).toString()
      } catch (e: Exception) {
        "Rocket Vibe"
      }
      val icone = resources.getIdentifier("notification_icon", "drawable", packageName)
      val notification = NotificationCompat.Builder(this, "default")
        .setSmallIcon(if (icone != 0) icone else android.R.drawable.ic_dialog_email)
        .setColor(COULEUR_ACCENT)
        .setContentTitle(titre)
        .setContentText("Nouveau message")
        .setContentIntent(pending)
        .setAutoCancel(true)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .build()
      NotificationManagerCompat.from(this).notify(notifId, notification)
    } catch (e: Exception) {
      Log.w(TAG, "posterNotifDegradee", e)
    }
  }

  /**
   * Debug seulement — voir posterNotifSalon : rejoue déchiffrement de session +
   * push.get sur un push de contenu ordinaire et loggue le résultat.
   */
  private fun verifierPushGetEnDebug(ejson: JSONObject) {
    try {
      val messageId = ejson.optString("messageId")
      val host = ejson.optString("host")
      if (messageId.isEmpty() || host.isEmpty()) {
        Log.d(TAG, "shadow push.get: messageId/host absents")
        return
      }
      val session = lireSession(host)
      if (session == null) {
        Log.d(TAG, "shadow push.get: session introuvable (déchiffrement KO ?) host=" + host)
        return
      }
      Log.d(TAG, "shadow push.get: session déchiffrée uid=" + session.optString("userId"))
      val notif = recupererContenu(host, messageId, session)
      if (notif == null) {
        Log.d(TAG, "shadow push.get: fetch KO")
        return
      }
      Log.d(
        TAG,
        "shadow push.get: OK title=" + notif.optString("title") + " text=" + notif.optString("text"),
      )
    } catch (e: Exception) {
      Log.w(TAG, "shadow push.get", e)
    }
  }

  /**
   * Lit la session expo-secure-store correspondant au host, sans runtime JS.
   * Reproduit le format de stockage d'expo-secure-store 57 : SharedPreferences
   * « SecureStore », une entrée « key_v1-session-<condensé> » par serveur, dont
   * la valeur est une enveloppe AES/GCM déchiffrable par une clé de
   * l'AndroidKeyStore. On énumère les sessions et on retient celle dont le
   * baseUrl matche le host ; à défaut, l'unique session connue (mono-serveur).
   */
  private fun lireSession(host: String): JSONObject? {
    return try {
      val prefs = getSharedPreferences("SecureStore", Context.MODE_PRIVATE)
      val hote = sansSlashFinal(host)
      var repli: JSONObject? = null
      var nbCandidats = 0
      for ((cle, valeur) in prefs.all) {
        if (!cle.startsWith("key_v1-session-")) continue
        val brut = valeur as? String ?: continue
        val clair = dechiffrerSecureStore(brut) ?: continue
        val session = try {
          JSONObject(clair)
        } catch (e: Exception) {
          continue
        }
        if (session.optString("authToken").isEmpty() || session.optString("userId").isEmpty()) continue
        nbCandidats++
        repli = session
        if (sansSlashFinal(session.optString("baseUrl")) == hote) return session
      }
      // Un seul serveur : l'utiliser même si le host ne matche pas au caractère près.
      if (nbCandidats == 1) repli else null
    } catch (e: Exception) {
      Log.w(TAG, "lireSession: échec", e)
      null
    }
  }

  /**
   * Déchiffre une enveloppe expo-secure-store (schéma « aes »). L'IV, la
   * longueur du tag GCM et l'alias de clé sont dans l'enveloppe ; la clé
   * symétrique vit dans l'AndroidKeyStore, générée par expo-secure-store.
   */
  private fun dechiffrerSecureStore(enveloppe: String): String? {
    return try {
      val obj = JSONObject(enveloppe)
      // Schéma « hybrid » = API < 23, hors cible (minSdk RN 0.86 >= 24).
      if (obj.optString("scheme") != "aes") return null
      val ct = Base64.decode(obj.getString("ct"), Base64.DEFAULT)
      val iv = Base64.decode(obj.getString("iv"), Base64.DEFAULT)
      val tlen = obj.getInt("tlen")
      val base = obj.optString("keystoreAlias", "key_v1").ifEmpty { "key_v1" }
      val suffixe = if (obj.optBoolean("requireAuthentication", false)) {
        "keystoreAuthenticated"
      } else {
        "keystoreUnauthenticated"
      }
      val alias = "AES/GCM/NoPadding:" + base +
        (if (obj.optBoolean("usesKeystoreSuffix", false)) ":" + suffixe else "")
      val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      val entree = ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry ?: return null
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, entree.secretKey, GCMParameterSpec(tlen, iv))
      String(cipher.doFinal(ct), Charsets.UTF_8)
    } catch (e: Exception) {
      Log.w(TAG, "dechiffrerSecureStore: échec", e)
      null
    }
  }

  /**
   * GET <host>/api/v1/push.get?id=<messageId>, authentifié par la session lue.
   * Renvoie l'objet \`data.notification\` (title/text/payload) ou null. Timeout
   * serré : on est sur le thread de dispatch FCM, budget limité.
   */
  private fun recupererContenu(host: String, messageId: String, session: JSONObject): JSONObject? {
    var conn: HttpURLConnection? = null
    return try {
      val url = URL(
        sansSlashFinal(host) + "/api/v1/push.get?id=" + URLEncoder.encode(messageId, "UTF-8"),
      )
      conn = (url.openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        setRequestProperty("X-User-Id", session.optString("userId"))
        setRequestProperty("X-Auth-Token", session.optString("authToken"))
        setRequestProperty("Accept", "application/json")
        connectTimeout = 8000
        readTimeout = 8000
      }
      val code = conn.responseCode
      if (code != 200) {
        Log.w(TAG, "push.get HTTP " + code)
        return null
      }
      val corps = conn.inputStream.bufferedReader().use { it.readText() }
      val json = JSONObject(corps)
      if (!json.optBoolean("success", false)) return null
      json.optJSONObject("data")?.optJSONObject("notification")
    } catch (e: Exception) {
      Log.w(TAG, "recupererContenu: échec", e)
      null
    } finally {
      conn?.disconnect()
    }
  }

  /** Retire les « / » finaux, comme le sansSlashFinal côté JS (sessionStore). */
  private fun sansSlashFinal(u: String): String = u.trimEnd('/')

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
