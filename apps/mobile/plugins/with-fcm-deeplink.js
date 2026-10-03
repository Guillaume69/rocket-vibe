const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withStringsXml,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');
const nativePushSource = require('./native-push-source.js');

// Aligné sur la version qu'expo-notifications embarque (transitive, non exposée
// au module app — d'où cette déclaration directe pour compiler la sous-classe).
const FIREBASE_MESSAGING = 'com.google.firebase:firebase-messaging:25.0.1';
// Rattrapage différé des push.get ratés (voir RattrapagePushWorker ci-dessous).
const ANDROIDX_WORK = 'androidx.work:work-runtime:2.10.1';
// Operation.result expose ListenableFuture. Firebase amène déjà Guava au
// runtime, mais son artefact listenablefuture vide masque la classe à compile.
const GUAVA = 'com.google.guava:guava:33.3.1-android';

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
 *     `rocketvibe://salon/<rid>?host=<serveur>` (géré par expo-router, à froid
 *     comme en marche) — plus besoin du circuit expo-notifications pour ceux-là.
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
 *
 * ÉCHEC DU FETCH (vécu sur le terrain : appareil en Doze, radio pas encore
 * levée à la réception — l'autre appareil du même salon affichait le contenu,
 * celui en veille restait sur la version dégradée ; autres causes : timeout,
 * rate-limit REST ~10 req/min sur un salon en rafale, jeton périmé) :
 *   1. on poste immédiatement la notification « Nouveau message » (jamais de
 *      notification perdue) ;
 *   2. on programme un RATTRAPAGE différé via WorkManager (contrainte réseau,
 *      backoff linéaire 30 s, 8 tentatives, unicité par messageId) qui rejoue
 *      push.get et, dès qu'il aboutit, REMPLACE la notification dégradée par la
 *      notification de conversation complète — SILENCIEUSEMENT (la dégradée a
 *      déjà alerté). Le contenu ne transite toujours jamais par Google/Apple.
 *   Sauf REFUS DÉFINITIF (401/403) : retenter ne fera que rejouer huit fois la
 *   même session morte. On garde la dégradée et on s'arrête là.
 *
 * ANTI-DOUBLON (constaté sur le terrain, nuit du 2026-07-17 ~04:52) : FCM
 * relivre un push non acquitté au retour du réseau, et le worker de rattrapage
 * est réveillé par le MÊME événement — le retour du réseau. Les deux voies
 * peuvent donc aboutir à quelques secondes d'intervalle et ajouter DEUX FOIS le
 * même message au MessagingStyle du salon. Deux gardes, dans les deux sens :
 *   - le succès direct annule la dégradée du même messageId ET son rattrapage ;
 *   - un test-et-pose atomique (`dejaAffiche`) porte la mémoire qui manquait :
 *     un messageId qui a DÉJÀ produit une notification de conversation n'en
 *     produit pas une seconde, quelle que soit la voie. `cancelUniqueWork`
 *     n'arrête pas un worker EN VOL : c'est ce test (et `isStopped`) qui le
 *     rattrape. La dégradée, elle, ne pose pas le marqueur — elle doit rester
 *     remplaçable par le contenu réel.
 *
 * JOURNAL DE BORD : chaque événement du circuit (réception, échec avec code ou
 * exception, rattrapage, remplacement, abandon) s'écrit dans
 * files/rvpush-journal.log (stockage externe de l'app, `adb pull`) — le buffer
 * logcat du Pixel (256 KiB) s'était avéré trop court pour les occurrences
 * nocturnes. Identifiants techniques seulement, jamais de contenu.
 *
 * Salons CHIFFRÉS : `Push_show_message = true` fait transiter du ciphertext ;
 * si l'ejson porte `messageType: 'e2e'`, on substitue un texte générique —
 * même dégradation que côté JS (`ui/notifications.tsx`).
 *
 * LANGUE : les trois chaînes que l'utilisateur voit de cette voie sortent de
 * `res/values[-fr]/strings.xml` (posés par ce plugin), en honorant d'abord la
 * langue EXPLICITEMENT choisie dans l'app (`langue-preferee`, même SecureStore
 * que la session) et à défaut celle du téléphone.
 */

const SERVICE_CLASS = 'RocketVibeMessagingService';
const RECEPTEUR_CLASS = 'ReponseNotifReceiver';

/**
 * Les trois chaînes vues par l'utilisateur sur la voie native. `en` est la
 * ressource par DÉFAUT (`values/`), `fr` la traduction (`values-fr/`) — même
 * couple que le catalogue JS de `ui/messages.ts`, dont elles reprennent le ton.
 */
const CHAINES = {
  rv_push_message_chiffre: { en: 'Encrypted message', fr: 'Message chiffré' },
  rv_push_moi: { en: 'You', fr: 'Vous' },
  rv_push_nouveau_message: { en: 'New message', fr: 'Nouveau message' },
  rv_push_repondre: { en: 'Reply', fr: 'Répondre' },
  rv_push_reponse_echec: { en: 'Reply not sent', fr: 'Réponse non envoyée' },
};

function kotlinSource(pkg) {
  return `package ${pkg}

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.content.res.Resources
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.KeyStore
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec

/**
 * Généré par plugins/with-fcm-deeplink.js — ne pas éditer à la main.
 * android/ est gitignoré (CNG) et régénéré par \`expo prebuild\`.
 */
class ${SERVICE_CLASS} : ExpoFirebaseMessagingService() {
  override fun onNewToken(token: String) {
    super.onNewToken(token)
    enregistrerRotationNative(this, token)
  }
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
      if (extras.getString("product") == "rocketvibe") {
        recevoirPushNatif(this, extras)
        return
      }
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

      journal(
        this,
        "push reçu type=" + ejson.optString("notificationType").ifEmpty { "contenu" } +
          " messageId=" + ejson.optString("messageId"),
      )

      // Contenu masqué côté serveur : le push ne porte qu'un messageId.
      if (ejson.optString("notificationType") == "message-id-only") {
        return recupererEtPoster(ejson)
      }

      // Contenu présent dans le push (réglage désactivé, ou serveur sans plan).
      val rid = ejson.optString("rid")
      if (rid.isEmpty()) return false
      // Plus de session pour ce serveur = l'utilisateur s'est déconnecté, et
      // le serveur ne le sait pas encore (dé-enregistrement du jeton échoué
      // hors ligne). Ce chemin-ci ne consultait AUCUNE session : il affichait
      // le CONTENU COMPLET d'un message sur un appareil sans compte. On avale
      // le push — \`true\` pour qu'expo ne poste pas sa version non plus.
      val hoteContenu = ejson.optString("host")
      if (hoteContenu.isNotEmpty() && lireSession(this, hoteContenu) == null) {
        journal(this, "contenu " + rid + " : aucune session pour " + hoteContenu + " -> ignoré")
        return true
      }
      val titre = extras.getString("title") ?: return false
      val texte = extras.getString("message") ?: return false
      // (debug, et seulement si la sonde est armée — voir sondeArmee) Le serveur
      // local n'active jamais le mode message-id-only (réglage enterprise inerte
      // sans licence) : on rejoue le circuit privé sur un push ordinaire pour le
      // prouver de bout en bout en local.
      if (BuildConfig.DEBUG && sondeArmee(this)) verifierPushGetEnDebug(ejson)
      return afficherNotifSalon(this, rid, titre, texte, ejson, hoteContenu)
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
   * salon. Toute défaillance PASSAGÈRE (hors ligne, radio pas levée en Doze,
   * rate-limit) tombe sur une notification « Nouveau message » — jamais de
   * contenu chez le transporteur, jamais de notification perdue — PUIS un
   * rattrapage WorkManager retente et la remplace par le contenu réel dès que le
   * serveur redevient joignable. Un refus DÉFINITIF (401/403) s'arrête à la
   * dégradée : huit tentatives sur une session morte ne rendraient que de la
   * batterie en moins.
   */
  private fun recupererEtPoster(ejsonPush: JSONObject): Boolean {
    val messageId = ejsonPush.optString("messageId")
    val host = ejsonPush.optString("host")
    if (messageId.isEmpty() || host.isEmpty()) return false

    val session = lireSession(this, host)
    // Pas de session pour cet hôte = compte déconnecté sur cet appareil. Le
    // serveur, lui, continue de pousser : le dé-enregistrement du jeton peut
    // avoir échoué hors ligne (voir \`lib/deconnexionDifferee.ts\`, qui le
    // rejoue au démarrage suivant). Sans cette garde, chaque push produisait un
    // « Nouveau message » fantôme, non annulable depuis l'app puisqu'il n'y a
    // plus de compte — et PLUS un rattrapage WorkManager mort-né, dont la
    // première exécution fait \`lireSession(...) ?: return Result.failure()\`
    // sans jamais retirer la dégradée déjà posée. Elle restait donc à l'écran
    // pour toujours. On avale : \`true\` empêche aussi expo d'en poster une.
    if (session == null) {
      journal(this, "id-only " + messageId + " : aucune session pour " + host + " -> ignoré")
      return true
    }
    val resultat = recupererContenu(this, messageId, session)
    val notif = resultat.notification
    if (notif == null) {
      posterNotifDegradee(this, messageId)
      if (resultat.definitif) {
        journal(this, "id-only " + messageId + " : refus " + resultat.code + ", pas de rattrapage")
      } else {
        journal(this, "id-only " + messageId + " : fetch KO (" + resultat.code + ") -> dégradée + rattrapage")
        planifierRattrapage(this, host, messageId, false, resultat.attenteMs)
      }
      return true
    }
    val payload = notif.optJSONObject("payload")
    val rid = payload?.optString("rid") ?: ""
    if (payload == null || rid.isEmpty()) {
      // Le serveur a répondu mais la forme est inattendue : retenter n'y
      // changera rien, pas de rattrapage.
      journal(this, "id-only " + messageId + " : payload inattendu, dégradée sans rattrapage")
      posterNotifDegradee(this, messageId)
      return true
    }
    // Succès direct : si une TENTATIVE PRÉCÉDENTE du même push avait posé la
    // notification dégradée et programmé un rattrapage (FCM relivre un push
    // non acquitté au retour du réseau — le process peut avoir été tué pendant
    // le fetch bloquant), on annule les deux. L'annulation vient AVANT le test
    // anti-doublon : la dégradée doit disparaître dans TOUS les cas, y compris
    // celui où le worker a déjà posté la vraie notification et où l'on va
    // renoncer à l'afficher.
    NotificationManagerCompat.from(this).cancel(messageId.hashCode())
    annulerRattrapage(this, messageId)
    if (dejaAffiche(this, messageId)) {
      journal(this, "id-only " + messageId + " : déjà affiché ailleurs -> pas de second ajout")
      return true
    }
    journal(this, "id-only " + messageId + " : fetch OK direct (rid=" + rid + ")")
    return afficherNotifSalon(
      this,
      rid,
      notif.optString("title"),
      notif.optString("text"),
      payload,
      host,
    )
  }

  /**
   * Debug seulement, et seulement sonde armée — voir posterNotifSalon : rejoue
   * déchiffrement de session + push.get sur un push de contenu ordinaire et
   * loggue le résultat. Un fetch KO programme aussi le rattrapage en mode
   * « ombre » (log sans notification) : c'est le SEUL moyen d'exercer
   * RattrapagePushWorker en local, la branche message-id-only n'étant émise que
   * par un serveur licencié.
   */
  private fun verifierPushGetEnDebug(ejson: JSONObject) {
    try {
      val messageId = ejson.optString("messageId")
      val host = ejson.optString("host")
      if (messageId.isEmpty() || host.isEmpty()) {
        Log.d(TAG, "shadow push.get: messageId/host absents")
        return
      }
      val session = lireSession(this, host)
      if (session == null) {
        Log.d(TAG, "shadow push.get: session introuvable (déchiffrement KO ?) host=" + host)
        return
      }
      Log.d(TAG, "shadow push.get: session déchiffrée uid=" + session.optString("userId"))
      val resultat = recupererContenu(this, messageId, session)
      val notif = resultat.notification
      if (notif == null) {
        Log.d(TAG, "shadow push.get: fetch KO (" + resultat.code + "), rattrapage ombre programmé")
        planifierRattrapage(this, host, messageId, true, resultat.attenteMs)
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

  companion object {
    private const val NOTIF_PREFIX = "gcm.notification."
    private const val KEY_NOTIF_TITLE = "gcm.notification.title"
    private const val KEY_NOTIF_BODY = "gcm.notification.body"
    private const val KEY_NOTIF_CHANNEL = "gcm.notification.android_channel_id"
  }
}

/**
 * Rattrapage d'un push.get raté : rejoue le fetch dès que le réseau est
 * disponible (contrainte CONNECTED), avec backoff linéaire, et remplace la
 * notification « Nouveau message » par la notification de conversation
 * complète. Unicité par messageId (voir planifierRattrapage) : une relivraison
 * FCM ne crée pas de second worker. En mode « ombre » (debug), loggue au lieu de
 * poster — voir verifierPushGetEnDebug.
 */
class RattrapagePushWorker(contexte: Context, params: WorkerParameters) : Worker(contexte, params) {
  override fun doWork(): Result {
    val host = inputData.getString("host") ?: return Result.failure()
    val messageId = inputData.getString("messageId") ?: return Result.failure()
    val ombre = inputData.getBoolean("ombre", false)
    // \`cancelUniqueWork\` n'interrompt pas un worker EN VOL : il lève seulement
    // \`isStopped\`. Sans ce test, une annulation décidée par la voie directe
    // (relivraison FCM traitée avec succès) arrivait trop tard et le message
    // était ajouté deux fois à la conversation.
    if (isStopped) {
      journal(applicationContext, "worker arrêté avant fetch (" + messageId + ")")
      return Result.success()
    }
    journal(
      applicationContext,
      "worker tentative " + (runAttemptCount + 1) + "/" + MAX_TENTATIVES + " (" + messageId + ")" +
        (if (ombre) " [ombre]" else ""),
    )

    val session = lireSession(applicationContext, host) ?: return Result.failure()
    val resultat = recupererContenu(applicationContext, messageId, session)
    val notif = resultat.notification
    if (notif == null) {
      // Un refus définitif (401/403) ne s'améliorera pas au bout de huit essais.
      if (resultat.definitif) {
        journal(applicationContext, "worker abandon : refus " + resultat.code + " (" + messageId + ")")
        return Result.failure()
      }
      // runAttemptCount démarre à 0 : MAX_TENTATIVES exécutions au plus.
      if (runAttemptCount >= MAX_TENTATIVES - 1) {
        journal(applicationContext, "worker abandon après " + MAX_TENTATIVES + " tentatives (" + messageId + ")")
        return Result.failure()
      }
      return Result.retry()
    }
    val payload = notif.optJSONObject("payload")
    val rid = payload?.optString("rid") ?: ""
    if (payload == null || rid.isEmpty()) return Result.failure()

    if (ombre) {
      Log.d(
        TAG,
        "shadow rattrapage: OK title=" + notif.optString("title") + " text=" + notif.optString("text"),
      )
      journal(applicationContext, "worker OK [ombre] (" + messageId + ")")
      return Result.success()
    }
    // Second point de contrôle, APRÈS le fetch : il a pu durer, et la voie
    // directe a pu poster entre-temps. Test-et-pose atomique — celui des deux
    // qui arrive le premier affiche, l'autre s'efface.
    if (isStopped || dejaAffiche(applicationContext, messageId)) {
      journal(applicationContext, "worker : déjà affiché ailleurs (" + messageId + ")")
      return Result.success()
    }
    // La vraie notification de salon remplace la dégradée (ids différents :
    // la dégradée dérive du messageId, celle de salon du rid). SILENCIEUSE :
    // la dégradée a déjà alerté pour ce message, on ne sonne pas deux fois.
    NotificationManagerCompat.from(applicationContext).cancel(messageId.hashCode())
    afficherNotifSalon(
      applicationContext,
      rid,
      notif.optString("title"),
      notif.optString("text"),
      payload,
      host,
      silencieux = true,
    )
    journal(applicationContext, "worker OK : dégradée remplacée (" + messageId + ", rid=" + rid + ")")
    return Result.success()
  }

  companion object {
    private const val MAX_TENTATIVES = 8
  }
}

// ---------------------------------------------------------------------------
// Helpers partagés entre le service FCM et le worker de rattrapage (privés au
// fichier : les deux classes vivent ici, rien n'est exposé au reste de l'app).
// ---------------------------------------------------------------------------

private const val TAG = "RVPush"

/** #FF5FA2 — la couleur d'accent déclarée pour expo-notifications (app.json). */
private const val COULEUR_ACCENT = 0xFFFF5FA2.toInt()

/** Préfixe des noms de work uniques — partagé entre planification et annulation. */
private const val NOM_RATTRAPAGE = "rattrapage-push-"

/** Mémoire des messageId déjà affichés en notification de conversation. */
private const val PREFS_AFFICHES = "rvpush-affiches"

/**
 * Au-delà, un marqueur est oublié. Une heure couvre très largement la fenêtre
 * de relivraison FCM d'un push non acquitté ; au-delà, un même messageId qui
 * reviendrait mérite d'être réaffiché plutôt que silencieusement avalé.
 */
private const val RETENTION_AFFICHES_MS = 60L * 60L * 1000L

private val VERROU_JOURNAL = Any()

private val VERROU_AFFICHES = Any()

/**
 * Journal de bord du circuit push, dans le dossier externe de l'app :
 * \`/sdcard/Android/data/<pkg>/files/rvpush-journal.log\` — lisible par
 * \`adb pull\`, il SURVIT à la rotation logcat (256 KiB sur Pixel, quelques
 * heures : les occurrences nocturnes du terrain étaient systématiquement
 * perdues). Identifiants techniques seulement (messageId, rid, codes) —
 * JAMAIS le contenu des messages. Best-effort : ne casse jamais le chemin
 * de notification. Repart à neuf au-delà de 256 Ko.
 */
private fun journal(ctx: Context, ligne: String) {
  try {
    synchronized(VERROU_JOURNAL) {
      val dossier = ctx.getExternalFilesDir(null) ?: return
      val fichier = File(dossier, "rvpush-journal.log")
      if (fichier.length() > 256 * 1024) fichier.writeText("")
      val horodatage = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
      fichier.appendText(horodatage + " " + ligne + "\\n")
    }
  } catch (e: Exception) {
    // Best-effort assumé.
  }
}

/**
 * Drapeau EXPLICITE de la sonde de debug : le fichier
 * \`/sdcard/Android/data/<pkg>/files/rvpush-sonde\`, posé à la main
 * (\`adb shell touch …\`). Elle enchaînait auparavant un SECOND push.get complet
 * derrière chaque push de contenu, sur le thread de dispatch FCM — soit le
 * double du budget de temps, et une chance de plus de se faire tuer en plein
 * fetch, ce qui ALIMENTE la relivraison qu'on cherche justement à ne pas
 * dédoubler. \`BuildConfig.DEBUG\` n'est pas un drapeau : c'est le régime
 * ordinaire de tout développement.
 */
private fun sondeArmee(ctx: Context): Boolean {
  return try {
    val dossier = ctx.getExternalFilesDir(null) ?: return false
    File(dossier, "rvpush-sonde").exists()
  } catch (e: Exception) {
    false
  }
}

/**
 * Test-et-pose ATOMIQUE : « ce messageId a-t-il déjà produit une notification de
 * conversation ? » — et sinon, il en produira une, c'est noté tout de suite.
 *
 * Les deux voies id-only (relivraison FCM traitée directement, et worker de
 * rattrapage) sont réveillées par le MÊME événement, le retour du réseau. Rien
 * ne mémorisait qu'un messageId avait déjà été affiché : \`afficherNotifSalon\`
 * ré-extrait le MessagingStyle actif et y AJOUTE le message, si bien que le
 * même texte apparaissait deux fois avec « 2 nouveaux messages ».
 *
 * \`commit()\` et non \`apply()\` : le process de dispatch FCM peut être tué
 * juste après ; une écriture encore en vol ne protégerait rien.
 *
 * Best-effort dans le bon sens : toute exception rend \`false\`, donc AFFICHE.
 * Un doublon est un désagrément, une notification perdue est un message manqué.
 */
private fun dejaAffiche(ctx: Context, messageId: String): Boolean {
  if (messageId.isEmpty()) return false
  try {
    synchronized(VERROU_AFFICHES) {
      val prefs = ctx.getSharedPreferences(PREFS_AFFICHES, Context.MODE_PRIVATE)
      val maintenant = System.currentTimeMillis()
      val pose = prefs.getLong(messageId, 0L)
      if (pose != 0L && maintenant - pose <= RETENTION_AFFICHES_MS) return true
      val edit = prefs.edit()
      for ((cle, valeur) in prefs.all) {
        val quand = valeur as? Long ?: 0L
        if (maintenant - quand > RETENTION_AFFICHES_MS) edit.remove(cle)
      }
      edit.putLong(messageId, maintenant)
      edit.commit()
    }
  } catch (e: Exception) {
    Log.w(TAG, "dejaAffiche", e)
  }
  return false
}

/**
 * Les ressources dans la langue de l'utilisateur. La préférence EXPLICITE de
 * l'app (\`langue-preferee\`, écrite par \`ui/i18n.ts\` dans le même SecureStore
 * que la session) l'emporte sur la locale du téléphone — sans quoi un
 * utilisateur ayant choisi « Français » sur un téléphone en anglais verrait
 * l'app en français et ses notifications en anglais. « Automatique » EFFACE la
 * clé côté JS : son absence signifie donc « suivre le téléphone », et on rend
 * les ressources telles quelles.
 */
private fun ressourcesLocalisees(ctx: Context): Resources {
  return try {
    val pref = lireLanguePreferee(ctx) ?: return ctx.resources
    val config = Configuration(ctx.resources.configuration)
    config.setLocale(Locale.forLanguageTag(pref))
    ctx.createConfigurationContext(config).resources
  } catch (e: Exception) {
    ctx.resources
  }
}

private fun lireLanguePreferee(ctx: Context): String? {
  return try {
    val prefs = ctx.getSharedPreferences("SecureStore", Context.MODE_PRIVATE)
    val brut = prefs.getString("key_v1-langue-preferee", null) ?: return null
    val clair = dechiffrerSecureStore(brut) ?: return null
    if (clair == "fr" || clair == "en") clair else null
  } catch (e: Exception) {
    null
  }
}

/**
 * Une chaîne de \`strings.xml\` dans la langue de l'utilisateur.
 *
 * Référence DIRECTE à \`R.string\`, et non \`resources.getIdentifier(nom, …)\`
 * comme pour l'icône juste en dessous : une constante fait échouer la
 * COMPILATION si \`withChainesNatives\` n'a pas posé les ressources, là où
 * \`getIdentifier\` rendrait 0 en silence — et la survivrait à un
 * \`shrinkResources\`, qui ne voit pas les lookups par nom. Le repli en dur ne
 * sert donc que le cas invraisemblable d'un \`getString\` qui lève.
 */
private fun chaine(ctx: Context, id: Int, repli: String): String {
  return try {
    ressourcesLocalisees(ctx).getString(id)
  } catch (e: Exception) {
    repli
  }
}

/**
 * Construit (ou complète) la notification MessagingStyle du salon à partir de
 * champs normalisés : titre, texte, et l'objet portant sender/type/
 * messageType (payload REST ou ejson du push, même forme). Partagé par les
 * deux régimes, et par le rattrapage différé.
 *
 * \`host\` vient de l'APPELANT (l'ejson du push, ou l'entrée du worker), jamais
 * du payload de \`push.get\` dont la forme n'est pas garantie : c'est le serveur
 * dont la notification parle, et le tap doit y ramener.
 */
private fun afficherNotifSalon(
  ctx: Context,
  rid: String,
  titre: String,
  texteInitial: String,
  ejson: JSONObject,
  host: String,
  silencieux: Boolean = false,
): Boolean {
  var texte = texteInitial

  // Même dégradation E2EE que côté JS : jamais de ciphertext à l'écran.
  if (ejson.optString("messageType") == "e2e") {
    texte = chaine(ctx, R.string.rv_push_message_chiffre, "Encrypted message")
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

  val nativeScope = ejson.optJSONObject("nativeScope")
  val notifId = (nativeScope?.let { cleNotifNative(it, rid) } ?: rid).hashCode()
  val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  // Ré-extraire le style de la notification active du même salon : les
  // messages précédents restent visibles, le nouveau s'ajoute à la suite.
  val active = manager.activeNotifications.firstOrNull { it.id == notifId }
  val style = active?.let {
    NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it.notification)
  } ?: NotificationCompat.MessagingStyle(
    Person.Builder().setName(chaine(ctx, R.string.rv_push_moi, "You")).build(),
  )

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

  // Pas de réponse depuis la notification sur un message chiffré : le serveur
  // refuserait le clair (\`error-not-allowed\`). Un message de fil y répond
  // dans le fil.
  publierNotifSalon(
    ctx,
    rid,
    host,
    style,
    silencieux,
    reponse = ejson.optString("messageType") != "e2e",
    tmid = ejson.optString("tmid").ifEmpty { null },
    nativeScope = nativeScope,
  )
  if (BuildConfig.DEBUG) {
    Log.d(TAG, "notif salon postée (rid=" + rid + ", id=" + notifId + ")")
  }
  return true
}

/**
 * Poste la notification de conversation d'un salon à partir d'un style déjà
 * garni. Partagé par l'affichage d'un push et par la mise à jour qui suit une
 * réponse tapée dans la notification.
 */
private fun publierNotifSalon(
  ctx: Context,
  rid: String,
  host: String,
  style: NotificationCompat.MessagingStyle,
  silencieux: Boolean,
  reponse: Boolean,
  tmid: String?,
  sousTexte: String? = null,
  nativeScope: JSONObject? = null,
) {
  val notifId = (nativeScope?.let { cleNotifNative(it, rid) } ?: rid).hashCode()
  // Le tap ouvre le salon par deep-link expo-router. MainActivity est
  // \`singleTask\` : avec le SEUL flag NEW_TASK, un VIEW est délivré à l'Activity
  // vivante par onNewIntent (app en marche/fond, PAS de recréation), et démarre
  // une Activity FRAÎCHE si le process est mort — dans les deux cas l'URL est
  // portée par l'intent.
  //
  // Le \`host\` voyage AVEC le rid : l'app supporte plusieurs sessions
  // simultanées (\`changerDeServeur\` n'en efface aucune) et le jeton push est
  // enregistré sur chacune, donc les deux serveurs poussent. Sans lui, un rid
  // d'un AUTRE serveur atterrissait sur un écran salon qui n'a aucune ligne
  // pour ce rid : l'effet de chargement se court-circuitait et l'écran gardait
  // son indicateur d'activité à vie. L'écran sait maintenant proposer la
  // bascule (\`app/salon/[rid].tsx\`).
  //
  // PAS de CLEAR_TASK : il RECRÉAIT la MainActivity même process vivant, ce qui
  // DÉSENREGISTRE les ActivityResultLauncher d'expo-image-picker. Expo ne les
  // réenregistre qu'en voyant \`hostWasDestroyed\` à l'onHostResume, or l'ordre
  // des callbacks de CLEAR_TASK (nouvelle Activity resumée AVANT destruction de
  // l'ancienne) contourne ce test : joindre une pièce échouait ensuite en
  // « unregistered ActivityResultLauncher » jusqu'au redémarrage complet.
  // PAS de SINGLE_TOP non plus : combiné à NEW_TASK sur une Activity déjà au
  // premier plan, il empêchait la navigation vers le salon (constaté sur l'AVD).
  val lien = StringBuilder("rocketvibe://salon/").append(Uri.encode(rid))
  if (host.isNotEmpty()) lien.append("?host=").append(Uri.encode(host))
  if (nativeScope != null) lien.append("&nativeScope=").append(Uri.encode(JSONObject()
    .put("instanceId", nativeScope.optString("instanceId")).put("dataEpoch", nativeScope.optString("dataEpoch"))
    .put("userId", nativeScope.optString("userId")).toString()))
  val tap = Intent(Intent.ACTION_VIEW, Uri.parse(lien.toString()))
    .setPackage(ctx.packageName)
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  val pending = PendingIntent.getActivity(
    ctx,
    notifId,
    tap,
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  val icone = ctx.resources.getIdentifier("notification_icon", "drawable", ctx.packageName)
  val constructeur = NotificationCompat.Builder(ctx, "default")
    .setSmallIcon(if (icone != 0) icone else android.R.drawable.ic_dialog_email)
    .setColor(COULEUR_ACCENT)
    .setStyle(style)
    .setContentIntent(pending)
    .setAutoCancel(true)
    .setPriority(NotificationCompat.PRIORITY_HIGH)
    .setCategory(NotificationCompat.CATEGORY_MESSAGE)
    .setSilent(silencieux)
  if (sousTexte != null) constructeur.setSubText(sousTexte)
  if (reponse && host.isNotEmpty()) constructeur.addAction(actionRepondre(ctx, rid, host, tmid, nativeScope))
  NotificationManagerCompat.from(ctx).notify(notifId, constructeur.build())
}

/**
 * L'action « Répondre » : un champ de saisie dans la notification, livré à
 * \`ReponseNotifReceiver\`. Le PendingIntent est MUTABLE, c'est obligatoire :
 * le système y dépose le texte saisi. Il est explicite (classe nommée), ce qui
 * empêche toute autre application de le détourner.
 */
private fun actionRepondre(
  ctx: Context,
  rid: String,
  host: String,
  tmid: String?,
  nativeScope: JSONObject? = null,
): NotificationCompat.Action {
  val libelle = chaine(ctx, R.string.rv_push_repondre, "Reply")
  val intent = Intent(ctx, ${RECEPTEUR_CLASS}::class.java)
    .putExtra(EXTRA_RID, rid)
    .putExtra(EXTRA_HOST, host)
  if (tmid != null) intent.putExtra(EXTRA_TMID, tmid)
  if (nativeScope != null) intent.putExtra("nativeScope", nativeScope.toString())
  val pending = PendingIntent.getBroadcast(
    ctx,
    (nativeScope?.let { cleNotifNative(it, rid) } ?: rid).hashCode(),
    intent,
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
  )
  val saisie = RemoteInput.Builder(CLE_REPONSE).setLabel(libelle).build()
  return NotificationCompat.Action.Builder(0, libelle, pending)
    .addRemoteInput(saisie)
    .setAllowGeneratedReplies(true)
    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
    .setShowsUserInterface(false)
    .build()
}


/**
 * Repli quand le contenu n'a pas pu être récupéré : sans rid on ne peut ni
 * grouper ni deep-linker, on ouvre simplement l'app au tap.
 */
private fun posterNotifDegradee(ctx: Context, messageId: String) {
  try {
    val notifId = if (messageId.isNotEmpty()) messageId.hashCode() else 0
    val ouvrir = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val pending = PendingIntent.getActivity(
      ctx,
      notifId,
      ouvrir ?: Intent(),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val titre = try {
      ctx.applicationInfo.loadLabel(ctx.packageManager).toString()
    } catch (e: Exception) {
      "Rocket Vibe"
    }
    val icone = ctx.resources.getIdentifier("notification_icon", "drawable", ctx.packageName)
    val notification = NotificationCompat.Builder(ctx, "default")
      .setSmallIcon(if (icone != 0) icone else android.R.drawable.ic_dialog_email)
      .setColor(COULEUR_ACCENT)
      .setContentTitle(titre)
      .setContentText(chaine(ctx, R.string.rv_push_nouveau_message, "New message"))
      .setContentIntent(pending)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .build()
    NotificationManagerCompat.from(ctx).notify(notifId, notification)
  } catch (e: Exception) {
    Log.w(TAG, "posterNotifDegradee", e)
  }
}

/**
 * Programme le rattrapage différé d'un push.get raté. Contrainte réseau : en
 * Doze radio coupée, la tentative attend la fenêtre de maintenance ou le
 * réveil de l'appareil — c'est précisément le cas vécu. Unicité KEEP par
 * messageId : une relivraison FCM du même push ne crée pas de second worker.
 *
 * \`attenteMs\` sert le cas du 429 : le serveur a dit QUAND il rouvrira
 * (\`x-ratelimit-reset\`), inutile de brûler une tentative avant. Une rafale
 * dans un salon animé dépasse vite les 10 req/min de \`push.get\`.
 */
private fun planifierRattrapage(
  ctx: Context,
  host: String,
  messageId: String,
  ombre: Boolean,
  attenteMs: Long,
) {
  try {
    val donnees = Data.Builder()
      .putString("host", host)
      .putString("messageId", messageId)
      .putBoolean("ombre", ombre)
      .build()
    val constructeur = OneTimeWorkRequest.Builder(RattrapagePushWorker::class.java)
      .setInputData(donnees)
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.SECONDS)
    if (attenteMs > 0) constructeur.setInitialDelay(attenteMs, TimeUnit.MILLISECONDS)
    WorkManager.getInstance(ctx)
      .enqueueUniqueWork(NOM_RATTRAPAGE + messageId, ExistingWorkPolicy.KEEP, constructeur.build())
    // Log.w assumé (visible en release) : c'est la trace de diagnostic du
    // terrain — un messageId n'expose aucun contenu.
    Log.w(TAG, "push.get KO, rattrapage programmé (" + messageId + ")")
    journal(ctx, "rattrapage programmé dans " + attenteMs + " ms (" + messageId + ")")
  } catch (e: Exception) {
    Log.w(TAG, "planifierRattrapage: échec", e)
    journal(ctx, "planifierRattrapage ÉCHEC: " + e.javaClass.simpleName + " (" + messageId + ")")
  }
}

/**
 * Annule le rattrapage en attente d'un message dont le contenu vient d'être
 * obtenu par une autre voie (relivraison FCM traitée avec succès) : sans ça,
 * le worker rajouterait le même message une seconde fois dans la conversation.
 * N'interrompt PAS un worker déjà en train de tourner — c'est \`isStopped\` et
 * \`dejaAffiche\` qui couvrent ce cas-là.
 */
private fun annulerRattrapage(ctx: Context, messageId: String) {
  try {
    WorkManager.getInstance(ctx).cancelUniqueWork(NOM_RATTRAPAGE + messageId)
  } catch (e: Exception) {
    Log.w(TAG, "annulerRattrapage: échec", e)
  }
}

/**
 * Scheme + authority d'une URL web, en minuscules ; null si ce n'en est pas une.
 * Pendant Kotlin de \`lib/origine.ts\` — même règle, écrite deux fois faute de
 * langage commun entre le service natif et l'app. L'autorité est prise TELLE
 * QUELLE, userinfo compris : « https://serveur@evil » ne doit surtout pas se
 * réduire à « https://serveur ».
 */
private fun origineDe(url: String): String? {
  val m = Regex("^(https?://[^/?#]+)", RegexOption.IGNORE_CASE).find(url) ?: return null
  return m.groupValues[1].lowercase()
}

/**
 * Lit la session expo-secure-store correspondant au host, sans runtime JS.
 * Reproduit le format de stockage d'expo-secure-store 57 : SharedPreferences
 * « SecureStore », une entrée « key_v1-session-<condensé> » par serveur, dont
 * la valeur est une enveloppe AES/GCM déchiffrable par une clé de
 * l'AndroidKeyStore.
 *
 * On ne retient que la session dont le baseUrl a la MÊME ORIGINE que le host
 * demandé. Il y avait ici un repli « une seule session connue, on la prend même
 * si le host ne matche pas » : \`host\` vient intégralement du payload FCM et
 * n'est validé nulle part, si bien que quiconque pouvait émettre vers le jeton
 * FCM de l'appareil faisait partir X-User-Id et X-Auth-Token vers le domaine de
 * son choix — hors de tout runtime JS, sans trace. La tolérance que ce repli
 * visait (barre finale, sous-chemin) est couverte par la comparaison d'origine ;
 * la tolérance de DOMAINE ne l'a jamais été volontairement.
 */
private fun lireSession(ctx: Context, host: String): JSONObject? {
  return try {
    val attendue = origineDe(host)
    if (attendue == null) {
      Log.w(TAG, "lireSession: host non web, rejeté")
      journal(ctx, "push: host rejeté (" + host + ")")
      return null
    }
    val prefs = ctx.getSharedPreferences("SecureStore", Context.MODE_PRIVATE)
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
      if (session.optString("genre") == "rocketvibe") continue
      if (origineDe(session.optString("baseUrl")) == attendue) return session
    }
    journal(ctx, "push: aucune session pour " + attendue)
    null
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

/** Clé du texte saisi dans la notification (RemoteInput). */
private const val CLE_REPONSE = "rv_reponse"
private const val EXTRA_RID = "rid"
private const val EXTRA_HOST = "host"
private const val EXTRA_TMID = "tmid"

/**
 * Budget d'une réponse envoyée depuis la notification. \`goAsync\` laisse une
 * dizaine de secondes au récepteur : 4 + 4 tient dedans, marge comprise.
 */
private const val TIMEOUT_REPONSE_MS = 4000

/**
 * Reçoit le texte tapé dans l'action « Répondre » et le poste par
 * \`chat.sendMessage\`, avec la session du serveur lue comme pour push.get
 * (même garde d'origine). La notification est toujours reposée ensuite : tant
 * qu'on ne le fait pas, Android laisse tourner l'indicateur d'envoi.
 */
class ${RECEPTEUR_CLASS} : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    val texte = RemoteInput.getResultsFromIntent(intent)
      ?.getCharSequence(CLE_REPONSE)
      ?.toString()
      ?.trim()
      .orEmpty()
    val rid = intent.getStringExtra(EXTRA_RID).orEmpty()
    val host = intent.getStringExtra(EXTRA_HOST).orEmpty()
    val tmid = intent.getStringExtra(EXTRA_TMID)
    if (rid.isEmpty() || host.isEmpty()) return
    val appContext = ctx.applicationContext
    val native = intent.getStringExtra("nativeScope")
    if (native != null) {
      val finNative = goAsync()
      Thread {
        try {
          val scope = JSONObject(native)
          val queued = try { planifierReponseNative(appContext, scope, texte) } catch (_: Exception) { false }
          val sessionNative = lireSessionNative(appContext, scope)
          if (!queued && sessionNative != null) reposerApresReponse(appContext, rid, sessionNative.optString("baseUrl"), tmid, texte, false, scope)
          if (sessionNative == null) NotificationManagerCompat.from(appContext).cancel(cleNotifNative(scope, rid).hashCode())
        } catch (_: Exception) {
          journal(appContext, "native reply scheduling failed")
        } finally { finNative.finish() }
      }.start()
      return
    }
    val fin = goAsync()
    Thread {
      try {
        val envoye = texte.isNotEmpty() && lireSession(appContext, host)?.let {
          envoyerReponse(appContext, it, rid, tmid, texte)
        } == true
        journal(appContext, "réponse depuis la notif (rid=" + rid + ") : " + (if (envoye) "OK" else "ÉCHEC"))
        reposerApresReponse(appContext, rid, host, tmid, texte, envoye)
      } catch (e: Exception) {
        Log.w(TAG, "${RECEPTEUR_CLASS}", e)
      } finally {
        fin.finish()
      }
    }.start()
  }
}

/** POST <baseUrl>/api/v1/chat.sendMessage — \`true\` si le serveur l'a accepté. */
private fun envoyerReponse(
  ctx: Context,
  session: JSONObject,
  rid: String,
  tmid: String?,
  texte: String,
): Boolean {
  var conn: HttpURLConnection? = null
  return try {
    val message = JSONObject().put("rid", rid).put("msg", texte)
    if (tmid != null) message.put("tmid", tmid)
    val corps = JSONObject().put("message", message).toString().toByteArray(Charsets.UTF_8)
    val url = URL(sansSlashFinal(session.optString("baseUrl")) + "/api/v1/chat.sendMessage")
    conn = (url.openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      doOutput = true
      setRequestProperty("X-User-Id", session.optString("userId"))
      setRequestProperty("X-Auth-Token", session.optString("authToken"))
      setRequestProperty("Content-Type", "application/json; charset=utf-8")
      setRequestProperty("Accept", "application/json")
      connectTimeout = TIMEOUT_REPONSE_MS
      readTimeout = TIMEOUT_REPONSE_MS
    }
    conn.outputStream.use { it.write(corps) }
    val code = conn.responseCode
    if (code != 200) {
      journal(ctx, "chat.sendMessage HTTP " + code + " (rid=" + rid + ")")
      return false
    }
    val reponse = conn.inputStream.bufferedReader().use { it.readText() }
    JSONObject(reponse).optBoolean("success", false)
  } catch (e: Exception) {
    Log.w(TAG, "envoyerReponse: échec", e)
    journal(ctx, "chat.sendMessage " + e.javaClass.simpleName + " (rid=" + rid + ")")
    false
  } finally {
    conn?.disconnect()
  }
}

/**
 * Repose la notification du salon après une réponse : la réponse s'ajoute à la
 * conversation (au nom de « Vous ») si elle est partie, sinon un sous-titre dit
 * qu'elle n'est pas partie et le champ reste là pour réessayer.
 */
private fun reposerApresReponse(
  ctx: Context,
  rid: String,
  host: String,
  tmid: String?,
  texte: String,
  envoye: Boolean,
  nativeScope: JSONObject? = null,
) {
  val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
  val nativeId = (nativeScope?.let { cleNotifNative(it, rid) } ?: rid).hashCode()
  val active = manager.activeNotifications.firstOrNull { it.id == nativeId }
  val style = active?.let {
    NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it.notification)
  } ?: NotificationCompat.MessagingStyle(
    Person.Builder().setName(chaine(ctx, R.string.rv_push_moi, "You")).build(),
  )
  if (envoye) style.addMessage(texte, System.currentTimeMillis(), null as Person?)
  publierNotifSalon(
    ctx,
    rid,
    host,
    style,
    silencieux = true,
    reponse = true,
    tmid = tmid,
    sousTexte = if (envoye) null else chaine(ctx, R.string.rv_push_reponse_echec, "Reply not sent"),
    nativeScope = nativeScope,
  )
}

/**
 * L'issue d'un push.get. \`null\` disait seulement « ça n'a pas marché » : le
 * chemin d'échec programmait donc huit tentatives WorkManager sur un jeton
 * révoqué exactement comme sur une radio endormie.
 */
private class ResultatPush(
  val notification: JSONObject?,
  /** Code HTTP, ou 0 si la requête n'a pas abouti (réseau, timeout, corps illisible). */
  val code: Int,
  /** Délai avant un rejeu utile (429 : \`x-ratelimit-reset\`), 0 si immédiat. */
  val attenteMs: Long = 0L,
) {
  /** Un refus que le temps ne changera pas : ne pas programmer de rattrapage. */
  val definitif: Boolean get() = code == 401 || code == 403
}

/**
 * Budget de temps du fetch, en millisecondes. On est sur le thread de dispatch
 * FCM : le commentaire annonçait un « timeout serré » mais posait 8 s de connect
 * ET 8 s de read, soit 16 s en Doze radio non levée — assez pour se faire tuer
 * en plein fetch, ce qui provoque justement la relivraison FCM et la famille de
 * doublons qu'on combat par ailleurs. 3 + 3 laisse le rattrapage WorkManager
 * faire son travail, qui est précisément d'avoir le temps.
 */
private const val TIMEOUT_PUSH_GET_MS = 3000

/** Plafond de l'attente déduite d'un 429 : au-delà, le backoff ordinaire suffit. */
private const val ATTENTE_429_MAX_MS = 60_000L

/**
 * GET <baseUrl>/api/v1/push.get?id=<messageId>, authentifié par la session lue.
 * Rend la notification (title/text/payload) ET le code HTTP, pour que l'appelant
 * puisse distinguer une panne passagère d'un refus définitif.
 *
 * L'URL est bâtie sur le \`baseUrl\` de la SESSION, jamais sur le \`host\` du
 * payload : c'est nous qui choisissons où part le jeton. \`lireSession\` a déjà
 * vérifié que les deux ont la même origine, mais le baseUrl porte en plus le
 * sous-chemin d'une instance montée ailleurs qu'à la racine.
 */
private fun recupererContenu(
  ctx: Context,
  messageId: String,
  session: JSONObject,
): ResultatPush {
  var conn: HttpURLConnection? = null
  return try {
    val url = URL(
      sansSlashFinal(session.optString("baseUrl")) +
        "/api/v1/push.get?id=" + URLEncoder.encode(messageId, "UTF-8"),
    )
    conn = (url.openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      setRequestProperty("X-User-Id", session.optString("userId"))
      setRequestProperty("X-Auth-Token", session.optString("authToken"))
      setRequestProperty("Accept", "application/json")
      connectTimeout = TIMEOUT_PUSH_GET_MS
      readTimeout = TIMEOUT_PUSH_GET_MS
    }
    val code = conn.responseCode
    if (code != 200) {
      Log.w(TAG, "push.get HTTP " + code)
      journal(ctx, "push.get HTTP " + code + " (" + messageId + ")")
      return ResultatPush(null, code, if (code == 429) attenteApres429(conn) else 0L)
    }
    val corps = conn.inputStream.bufferedReader().use { it.readText() }
    val json = JSONObject(corps)
    if (!json.optBoolean("success", false)) return ResultatPush(null, code)
    ResultatPush(json.optJSONObject("data")?.optJSONObject("notification"), code)
  } catch (e: Exception) {
    Log.w(TAG, "recupererContenu: échec", e)
    journal(
      ctx,
      "push.get " + e.javaClass.simpleName + ": " + (e.message ?: "") + " (" + messageId + ")",
    )
    ResultatPush(null, 0)
  } finally {
    conn?.disconnect()
  }
}

/**
 * Le serveur donne la date de réouverture en epoch ms dans \`x-ratelimit-reset\`
 * (même en-tête que celui lu par \`lib/rest.ts\`). En-tête absent ou aberrant :
 * 0, et le rattrapage part dès que le réseau est là.
 */
private fun attenteApres429(conn: HttpURLConnection): Long {
  return try {
    val brut = conn.getHeaderField("x-ratelimit-reset")?.toLongOrNull() ?: return 0L
    val delai = brut - System.currentTimeMillis()
    if (delai <= 0L) 0L else minOf(delai, ATTENTE_429_MAX_MS)
  } catch (e: Exception) {
    0L
  }
}

/** Retire les « / » finaux, comme le sansSlashFinal côté JS (sessionStore). */
private fun sansSlashFinal(u: String): String = u.trimEnd('/')
${nativePushSource()}
`;
}

// ---------------------------------------------------------------------------
// Chirurgie de configuration — la partie PURE du plugin, celle qui n'a besoin
// ni d'Expo ni d'un build pour être jugée. Exportée (`chirurgie`) et couverte
// par `plugins/with-fcm-deeplink.test.mjs` : le Kotlin ci-dessus ne se vérifie
// qu'en compilant, mais ceci est du JS ordinaire, et deux de ses propriétés
// sont porteuses — la priorité `1` du service (sans elle, FCM route vers le
// service d'expo et tout le fichier devient mort) et l'endroit exact où
// atterrissent les `implementation`.
// ---------------------------------------------------------------------------

/**
 * Le bloc `dependencies` de PLUS HAUT NIVEAU d'un `build.gradle` Groovy : celui
 * qui commence en colonne 0. `/dependencies\s*\{/` visait la PREMIÈRE occurrence
 * du fichier, quelle que soit sa profondeur — correct aujourd'hui par propriété
 * du gabarit RN 0.86 (il n'en a qu'un), pas par propriété du plugin. Un bloc
 * imbriqué (`buildscript { dependencies { … } }`, un `subprojects`) aurait reçu
 * nos artefacts, où ils ne compilent pas le module app.
 */
const BLOC_DEPENDANCES = /^dependencies\s*\{/m;

/**
 * Ajoute les artefacts manquants au bloc `dependencies` racine.
 *
 * La garde est `includes(artefact)` SANS la version : si une autre dépendance
 * amène déjà `com.google.firebase:firebase-messaging` dans une version voisine,
 * en déclarer une seconde ferait diverger la résolution. Idempotent, donc — un
 * `expo prebuild` sans `--clean` repasse sur un fichier déjà traité.
 *
 * L'absence de bloc racine LÈVE, au lieu de rendre le fichier intact : la
 * compilation échouerait bien plus loin, sur une classe Kotlin introuvable, et
 * la cause serait à retrouver.
 */
function ajouterDependances(contents, deps) {
  if (!BLOC_DEPENDANCES.test(contents)) {
    throw new Error(
      "with-fcm-deeplink : aucun bloc `dependencies {` racine dans app/build.gradle — " +
        'firebase-messaging et work-runtime ne peuvent pas être déclarés.',
    );
  }
  let sortie = contents;
  for (const dep of deps) {
    const artefact = dep.substring(0, dep.lastIndexOf(':'));
    if (sortie.includes(artefact)) continue;
    sortie = sortie.replace(BLOC_DEPENDANCES, (m) => `${m}\n    implementation("${dep}")`);
  }
  return sortie;
}

/**
 * Déclare notre `FirebaseMessagingService` dans le `<application>` du manifeste.
 *
 * `android:priority="1"` n'est pas décoratif : celui d'expo-notifications est à
 * `-1`, et FCM route l'intent vers le service de plus haute priorité. Une valeur
 * plus basse rendrait tout le Kotlin de ce fichier inatteignable, sans erreur
 * de build ni message — juste des notifications qui redeviennent celles d'expo.
 */
function ajouterService(application, nomService = `.${SERVICE_CLASS}`) {
  application.service = application.service || [];
  const deja = application.service.some((s) => s.$?.['android:name'] === nomService);
  if (!deja) {
    application.service.push({
      $: { 'android:name': nomService, 'android:exported': 'false' },
      'intent-filter': [
        {
          $: { 'android:priority': '1' },
          action: [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }],
        },
      ],
    });
  }
  return application;
}

/**
 * Déclare le récepteur de l'action « Répondre ». Non exporté : seul notre
 * PendingIntent, explicite, peut l'atteindre.
 */
function ajouterRecepteur(application, nom = `.${RECEPTEUR_CLASS}`) {
  application.receiver = application.receiver || [];
  const deja = application.receiver.some((r) => r.$?.['android:name'] === nom);
  if (!deja) {
    application.receiver.push({ $: { 'android:name': nom, 'android:exported': 'false' } });
  }
  return application;
}

/** Le `strings.xml` d'une langue donnée, tel qu'écrit dans `res/values-<lg>/`. */
function stringsXml(langue) {
  const lignes = Object.entries(CHAINES).map(
    ([nom, formes]) => `    <string name="${nom}">${echapperXml(formes[langue])}</string>`,
  );
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${lignes.join('\n')}\n</resources>\n`;
}

/**
 * Échappement Android : les entités XML, plus l'apostrophe, que le compilateur
 * de ressources traite comme un délimiteur et refuse non échappée.
 */
function echapperXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, "\\'");
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
    ajouterService(application);
    ajouterRecepteur(application);
    return config;
  });
}

function withNativeDeps(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = ajouterDependances(config.modResults.contents, [
      FIREBASE_MESSAGING,
      ANDROIDX_WORK,
      GUAVA,
    ]);
    return config;
  });
}

/**
 * Les chaînes de la voie native. `values/` (défaut, anglais) passe par le
 * helper d'Expo, qui FUSIONNE avec ce que le gabarit y met déjà (`app_name`…) ;
 * `values-fr/` est un dossier que nous sommes seuls à peupler, donc écrit tel
 * quel.
 */
function withChainesNatives(config) {
  config = withStringsXml(config, (config) => {
    for (const [nom, formes] of Object.entries(CHAINES)) {
      config.modResults = AndroidConfig.Strings.setStringItem(
        [AndroidConfig.Resources.buildResourceItem({ name: nom, value: formes.en })],
        config.modResults,
      );
    }
    return config;
  });
  return withDangerousMod(config, [
    'android',
    (config) => {
      const dir = path.join(
        config.modRequest.platformProjectRoot,
        'app/src/main/res/values-fr',
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'strings.xml'), stringsXml('fr'));
      return config;
    },
  ]);
}

module.exports = function withFcmDeeplink(config) {
  config = withServiceFile(config);
  config = withServiceManifest(config);
  config = withNativeDeps(config);
  config = withChainesNatives(config);
  return config;
};

// Pour les tests (`plugins/with-fcm-deeplink.test.mjs`) — pas pour l'app.
module.exports.chirurgie = {
  SERVICE_CLASS,
  RECEPTEUR_CLASS,
  ajouterDependances,
  ajouterRecepteur,
  ajouterService,
  echapperXml,
  stringsXml,
  CHAINES,
  kotlinSource,
};
