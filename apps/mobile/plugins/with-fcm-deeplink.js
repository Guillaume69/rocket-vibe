const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withStringsXml,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Matches the version expo-notifications bundles (transitive, not exposed to the
// app module, hence this direct declaration to compile the subclass).
const FIREBASE_MESSAGING = 'com.google.firebase:firebase-messaging:25.0.1';
// Deferred catch-up of failed push.get calls (see RattrapagePushWorker below).
const ANDROIDX_WORK = 'androidx.work:work-runtime:2.10.1';

/**
 * Fixes the deep link on a push notification tap, and GROUPS message pushes by
 * room (one "conversation" notification per room, WhatsApp style, instead of a
 * stack of one notification per message).
 *
 * Rocket.Chat sends an FCM message with a `notification` block (title/body).
 * With the app killed or in the background, Firebase auto-displays it itself and
 * wires the tap to its default intent: expo-notifications is bypassed, and
 * `getLastNotificationResponseAsync()` returns null, so the tap never opens the
 * conversation (see memory "push tap deep link broken").
 *
 * The core of the fix: a `FirebaseMessagingService` with a higher priority than
 * expo's (which is -1), that strips the `notification` block to make the
 * message "data-only" (→ `handleIntent` called even with the app killed).
 *
 * Then, two paths:
 *   - Rocket.Chat MESSAGE push (an `ejson` with `rid`) → WE post a
 *     `MessagingStyle` notification whose id derives from the `rid`: successive
 *     messages of one room ACCUMULATE in the same notification (the previous
 *     style is re-extracted and extended). The tap carries a deep link
 *     `rocketvibe://salon/<rid>?host=<server>` (handled by expo-router, cold or
 *     warm), so those no longer need the expo-notifications circuit.
 *   - Any other intent (other pushes, messages without `rid`) → expo route
 *     unchanged: title/body copied into the `data` keys expo reads (`title`,
 *     `message`), expo displays and handles the tap as before.
 *
 * PRIVATE CONTENT (RC setting "Hide message content from Apple and Google",
 * `Push_request_content_from_server`, Premium plan): when active, the push
 * carries ONLY `{ host, messageId, notificationType: 'message-id-only' }`, no
 * content, no rid, no sender (so the text never passes through Google/Apple).
 * WE then fetch the content: read the session stored by expo-secure-store
 * (AES/GCM decryption through the AndroidKeyStore, without a JS runtime since
 * the app may be killed), then an authenticated
 * `GET /api/v1/push.get?id=<messageId>`, which returns exactly the full
 * notification (title/text/payload) that we display as above.
 *
 * FETCH FAILURE (seen in the field: device in Doze, radio not yet up on
 * receipt; the other device in the same room showed the content, the sleeping
 * one stayed on the degraded version; other causes: timeout, REST rate limit
 * ~10 req/min on a bursting room, stale token):
 *   1. we immediately post the "New message" notification (no notification is
 *      ever lost);
 *   2. we schedule a deferred CATCH-UP through WorkManager (network constraint,
 *      30 s linear backoff, 8 attempts, unique per messageId) that replays
 *      push.get and, as soon as it succeeds, REPLACES the degraded notification
 *      with the full conversation notification, SILENTLY (the degraded one has
 *      already alerted). The content still never passes through Google/Apple.
 *   Except on a PERMANENT REFUSAL (401/403): retrying would only replay the same
 *   dead session eight times. We keep the degraded one and stop there.
 *
 * ANTI-DUPLICATE (seen in the field, night of 2026-07-17 ~04:52): FCM
 * redelivers an unacknowledged push when the network comes back, and the
 * catch-up worker is woken by the SAME event, the network coming back. Both
 * paths can therefore succeed a few seconds apart and add the same message
 * TWICE to the room's MessagingStyle. Two guards, one each way:
 *   - the direct success cancels the degraded notification for the same
 *     messageId AND its catch-up;
 *   - an atomic test-and-set (`alreadyShown`) carries the missing memory: a
 *     messageId that has ALREADY produced a conversation notification does not
 *     produce a second one, whichever the path. `cancelUniqueWork` does not stop
 *     an IN-FLIGHT worker: this test (and `isStopped`) is what catches it. The
 *     degraded notification does not set the marker: it must stay replaceable
 *     by the real content.
 *
 * LOGBOOK: every event of the circuit (receipt, failure with code or exception,
 * catch-up, replacement, giving up) is written to files/rvpush-journal.log (the
 * app's external storage, `adb pull`); the Pixel's logcat buffer (256 KiB)
 * proved too short for the overnight occurrences. Technical identifiers only,
 * never content.
 *
 * ENCRYPTED rooms: `Push_show_message = true` carries ciphertext; if the ejson
 * has `messageType: 'e2e'`, we substitute a generic text, the same degradation
 * as on the JS side (`ui/notifications.tsx`).
 *
 * LANGUAGE: the user-visible strings of this path come from
 * `res/values[-fr]/strings.xml` (written by this plugin), honouring first the
 * language EXPLICITLY chosen in the app (`langue-preferee`, same SecureStore as
 * the session) and otherwise the phone's.
 */

const SERVICE_CLASS = 'RocketVibeMessagingService';
const RECEIVER_CLASS = 'ReponseNotifReceiver';

/**
 * The user-visible strings of the native path. `en` is the DEFAULT resource
 * (`values/`), `fr` the translation (`values-fr/`), the same pair as the JS
 * catalogue in `ui/messages.ts`, whose tone they follow.
 */
const NATIVE_STRINGS = {
  rv_push_encrypted_message: { en: 'Encrypted message', fr: 'Message chiffré' },
  rv_push_me: { en: 'You', fr: 'Vous' },
  rv_push_new_message: { en: 'New message', fr: 'Nouveau message' },
  rv_push_reply: { en: 'Reply', fr: 'Répondre' },
  rv_push_reply_failed: { en: 'Reply not sent', fr: 'Réponse non envoyée' },
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
 * Generated by plugins/with-fcm-deeplink.js, do not edit by hand.
 * android/ is gitignored (CNG) and regenerated by \`expo prebuild\`.
 */
class ${SERVICE_CLASS} : ExpoFirebaseMessagingService() {
  override fun handleIntent(intent: Intent) {
    val extras = intent.extras
    if (extras != null) {
      val title = extras.getString(KEY_NOTIF_TITLE)
      val body = extras.getString(KEY_NOTIF_BODY)
      // Copy into the data keys expo reads, without overwriting what RC provides.
      if (title != null && extras.getString("title") == null) {
        extras.putString("title", title)
      }
      if (body != null && extras.getString("message") == null) {
        extras.putString("message", body)
      }
      // Without a notification block, expo reads the channel from data["channelId"]:
      // target our "default" channel (created by lib/push.ts) rather than its fallback.
      if (extras.getString("channelId") == null) {
        extras.putString("channelId", extras.getString(KEY_NOTIF_CHANNEL) ?: "default")
      }
      // Strip the whole notification block → Firebase treats the message as data-only.
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
      // RC message push: "conversation" notification grouped by room, posted
      // HERE. Returning bypasses expo, which would post a second one.
      if (postRoomNotification(extras)) {
        return
      }
    }
    super.handleIntent(intent)
  }

  /**
   * Routes a message push to display. \`false\` if this push is not a usable
   * room message; the caller then hands over to expo.
   *
   * Two regimes depending on the server setting "Hide message content from Apple
   * and Google" (Push_request_content_from_server, Premium plan):
   *   - off → the content is in the push, we display it directly;
   *   - on → the push carries only a messageId (notificationType ==
   *     "message-id-only"), WE fetch the content through push.get: it then
   *     never passes through Google/Apple.
   */
  private fun postRoomNotification(extras: Bundle): Boolean {
    try {
      val rawEjson = extras.getString("ejson") ?: return false
      val ejson = JSONObject(rawEjson)

      debugLog(
        this,
        "push received type=" + ejson.optString("notificationType").ifEmpty { "content" } +
          " messageId=" + ejson.optString("messageId"),
      )

      // Content hidden server-side: the push carries only a messageId.
      if (ejson.optString("notificationType") == "message-id-only") {
        return fetchAndPost(ejson)
      }

      // Content present in the push (setting off, or server without the plan).
      val rid = ejson.optString("rid")
      if (rid.isEmpty()) return false
      // No session left for this server = the user logged out, and the server
      // does not know yet (token unregistration failed offline). This path
      // checked NO session: it showed a message's FULL CONTENT on a device
      // with no account. We swallow the push, \`true\` so expo does not post
      // its version either.
      val contentHost = ejson.optString("host")
      if (contentHost.isNotEmpty() && readSession(this, contentHost) == null) {
        debugLog(this, "content " + rid + ": no session for " + contentHost + " -> ignored")
        return true
      }
      val title = extras.getString("title") ?: return false
      val text = extras.getString("message") ?: return false
      // (debug, and only when the probe is armed, see probeArmed) The local
      // server never enables message-id-only mode (enterprise setting inert
      // without a licence): we replay the private circuit on an ordinary push
      // to prove it end to end locally.
      if (BuildConfig.DEBUG && probeArmed(this)) verifyPushGetInDebug(ejson)
      return showRoomNotification(this, rid, title, text, ejson, contentHost)
    } catch (e: Exception) {
      // A malformed push or a refusal (POST_NOTIFICATIONS revoked) must not
      // lose the notification: we let expo show its plain version.
      Log.w(TAG, "postRoomNotification: expo fallback", e)
      return false
    }
  }

  /**
   * "Private content" path: the push delivered only a messageId. We read the
   * stored session (expo-secure-store, without a JS runtime), ask the server for
   * the content (push.get, authenticated), then show the room notification. Any
   * TRANSIENT failure (offline, radio not up in Doze, rate limit) falls back to
   * a "New message" notification (never content at the carrier, never a lost
   * notification), THEN a WorkManager catch-up retries and replaces it with the
   * real content as soon as the server is reachable again. A PERMANENT refusal
   * (401/403) stops at the degraded one: eight attempts on a dead session would
   * only cost battery.
   */
  private fun fetchAndPost(pushEjson: JSONObject): Boolean {
    val messageId = pushEjson.optString("messageId")
    val host = pushEjson.optString("host")
    if (messageId.isEmpty() || host.isEmpty()) return false

    val session = readSession(this, host)
    // No session for this host = account logged out on this device. The server
    // keeps pushing: the token unregistration may have failed offline (see
    // \`lib/deferredLogout.ts\`, which replays it on the next startup). Without
    // this guard, every push produced a ghost "New message", impossible to
    // dismiss from the app since there is no account any more, PLUS a stillborn
    // WorkManager catch-up whose first run does
    // \`readSession(...) ?: return Result.failure()\` without ever removing the
    // degraded one already posted. It stayed on screen forever. We swallow:
    // \`true\` also stops expo from posting one.
    if (session == null) {
      debugLog(this, "id-only " + messageId + ": no session for " + host + " -> ignored")
      return true
    }
    val result = fetchContent(this, messageId, session)
    val notif = result.notification
    if (notif == null) {
      postFallbackNotification(this, messageId)
      if (result.permanent) {
        debugLog(this, "id-only " + messageId + ": refused " + result.code + ", no catch-up")
      } else {
        debugLog(this, "id-only " + messageId + ": fetch failed (" + result.code + ") -> degraded + catch-up")
        scheduleCatchUp(this, host, messageId, false, result.retryDelayMs)
      }
      return true
    }
    val payload = notif.optJSONObject("payload")
    val rid = payload?.optString("rid") ?: ""
    if (payload == null || rid.isEmpty()) {
      // The server answered but the shape is unexpected: retrying will not
      // change anything, no catch-up.
      debugLog(this, "id-only " + messageId + ": unexpected payload, degraded without catch-up")
      postFallbackNotification(this, messageId)
      return true
    }
    // Direct success: if a PREVIOUS ATTEMPT of the same push had posted the
    // degraded notification and scheduled a catch-up (FCM redelivers an
    // unacknowledged push when the network comes back; the process may have
    // been killed during the blocking fetch), we cancel both. The cancellation
    // comes BEFORE the anti-duplicate test: the degraded one must go in EVERY
    // case, including when the worker already posted the real notification and
    // we are about to skip showing it.
    NotificationManagerCompat.from(this).cancel(messageId.hashCode())
    cancelCatchUp(this, messageId)
    if (alreadyShown(this, messageId)) {
      debugLog(this, "id-only " + messageId + ": already shown elsewhere -> no second add")
      return true
    }
    debugLog(this, "id-only " + messageId + ": direct fetch OK (rid=" + rid + ")")
    return showRoomNotification(
      this,
      rid,
      notif.optString("title"),
      notif.optString("text"),
      payload,
      host,
    )
  }

  /**
   * Debug only, and only with the probe armed, see postRoomNotification: replays
   * session decryption + push.get on an ordinary content push and logs the
   * result. A failed fetch also schedules the catch-up in "shadow" mode (log
   * without notification): it is the ONLY way to exercise RattrapagePushWorker
   * locally, since only a licensed server emits the message-id-only branch.
   */
  private fun verifyPushGetInDebug(ejson: JSONObject) {
    try {
      val messageId = ejson.optString("messageId")
      val host = ejson.optString("host")
      if (messageId.isEmpty() || host.isEmpty()) {
        Log.d(TAG, "shadow push.get: messageId/host missing")
        return
      }
      val session = readSession(this, host)
      if (session == null) {
        Log.d(TAG, "shadow push.get: session not found (decryption failed?) host=" + host)
        return
      }
      Log.d(TAG, "shadow push.get: session decrypted uid=" + session.optString("userId"))
      val result = fetchContent(this, messageId, session)
      val notif = result.notification
      if (notif == null) {
        Log.d(TAG, "shadow push.get: fetch failed (" + result.code + "), shadow catch-up scheduled")
        scheduleCatchUp(this, host, messageId, true, result.retryDelayMs)
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
 * Catch-up of a failed push.get: replays the fetch as soon as the network is
 * available (CONNECTED constraint), with linear backoff, and replaces the
 * "New message" notification with the full conversation notification. Unique
 * per messageId (see scheduleCatchUp): an FCM redelivery does not create a
 * second worker. In "shadow" mode (debug), logs instead of posting, see
 * verifyPushGetInDebug.
 */
class RattrapagePushWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val host = inputData.getString("host") ?: return Result.failure()
    val messageId = inputData.getString("messageId") ?: return Result.failure()
    val shadow = inputData.getBoolean("ombre", false)
    // \`cancelUniqueWork\` does not interrupt an IN-FLIGHT worker: it only sets
    // \`isStopped\`. Without this test, a cancellation decided by the direct path
    // (FCM redelivery handled successfully) came too late and the message was
    // added twice to the conversation.
    if (isStopped) {
      debugLog(applicationContext, "worker stopped before fetch (" + messageId + ")")
      return Result.success()
    }
    debugLog(
      applicationContext,
      "worker attempt " + (runAttemptCount + 1) + "/" + MAX_ATTEMPTS + " (" + messageId + ")" +
        (if (shadow) " [shadow]" else ""),
    )

    val session = readSession(applicationContext, host) ?: return Result.failure()
    val result = fetchContent(applicationContext, messageId, session)
    val notif = result.notification
    if (notif == null) {
      // A permanent refusal (401/403) will not improve after eight tries.
      if (result.permanent) {
        debugLog(applicationContext, "worker giving up: refused " + result.code + " (" + messageId + ")")
        return Result.failure()
      }
      // runAttemptCount starts at 0: MAX_ATTEMPTS runs at most.
      if (runAttemptCount >= MAX_ATTEMPTS - 1) {
        debugLog(applicationContext, "worker giving up after " + MAX_ATTEMPTS + " attempts (" + messageId + ")")
        return Result.failure()
      }
      return Result.retry()
    }
    val payload = notif.optJSONObject("payload")
    val rid = payload?.optString("rid") ?: ""
    if (payload == null || rid.isEmpty()) return Result.failure()

    if (shadow) {
      Log.d(
        TAG,
        "shadow catch-up: OK title=" + notif.optString("title") + " text=" + notif.optString("text"),
      )
      debugLog(applicationContext, "worker OK [shadow] (" + messageId + ")")
      return Result.success()
    }
    // Second checkpoint, AFTER the fetch: it may have taken a while, and the
    // direct path may have posted in the meantime. Atomic test-and-set: whichever
    // arrives first shows it, the other steps aside.
    if (isStopped || alreadyShown(applicationContext, messageId)) {
      debugLog(applicationContext, "worker: already shown elsewhere (" + messageId + ")")
      return Result.success()
    }
    // The real room notification replaces the degraded one (different ids: the
    // degraded one derives from the messageId, the room one from the rid).
    // SILENT: the degraded one already alerted for this message, no second ring.
    NotificationManagerCompat.from(applicationContext).cancel(messageId.hashCode())
    showRoomNotification(
      applicationContext,
      rid,
      notif.optString("title"),
      notif.optString("text"),
      payload,
      host,
      silent = true,
    )
    debugLog(applicationContext, "worker OK: degraded replaced (" + messageId + ", rid=" + rid + ")")
    return Result.success()
  }

  companion object {
    private const val MAX_ATTEMPTS = 8
  }
}

// ---------------------------------------------------------------------------
// Helpers shared by the FCM service and the catch-up worker (file-private: both
// classes live here, nothing is exposed to the rest of the app).
// ---------------------------------------------------------------------------

private const val TAG = "RVPush"

/** #FF5FA2, the accent colour declared for expo-notifications (app.json). */
private const val ACCENT_COLOR = 0xFFFF5FA2.toInt()

/** Prefix of the unique work names, shared by scheduling and cancellation. */
private const val CATCH_UP_WORK_PREFIX = "rattrapage-push-"

/** Memory of the messageIds already shown as a conversation notification. */
private const val PREFS_SHOWN = "rvpush-affiches"

/**
 * Beyond this, a marker is forgotten. One hour amply covers FCM's redelivery
 * window for an unacknowledged push; beyond it, the same messageId coming back
 * deserves to be shown again rather than silently swallowed.
 */
private const val SHOWN_RETENTION_MS = 60L * 60L * 1000L

private val LOG_LOCK = Any()

private val SHOWN_LOCK = Any()

/**
 * Logbook of the push circuit, in the app's external folder:
 * \`/sdcard/Android/data/<pkg>/files/rvpush-journal.log\`. Readable with
 * \`adb pull\`, it SURVIVES logcat rotation (256 KiB on a Pixel, a few hours:
 * the overnight occurrences in the field were always lost). Technical
 * identifiers only (messageId, rid, codes), NEVER message content.
 * Best-effort: never breaks the notification path. Starts over past 256 KB.
 */
private fun debugLog(ctx: Context, line: String) {
  try {
    synchronized(LOG_LOCK) {
      val dir = ctx.getExternalFilesDir(null) ?: return
      val file = File(dir, "rvpush-journal.log")
      if (file.length() > 256 * 1024) file.writeText("")
      val timestamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
      file.appendText(timestamp + " " + line + "\\n")
    }
  } catch (e: Exception) {
    // Best-effort by design.
  }
}

/**
 * EXPLICIT flag for the debug probe: the file
 * \`/sdcard/Android/data/<pkg>/files/rvpush-sonde\`, created by hand
 * (\`adb shell touch …\`). It used to chain a SECOND full push.get after every
 * content push, on the FCM dispatch thread: twice the time budget, and one more
 * chance of being killed mid-fetch, which FEEDS the very redelivery we are
 * trying not to duplicate. \`BuildConfig.DEBUG\` is not a flag: it is the
 * ordinary state of all development.
 */
private fun probeArmed(ctx: Context): Boolean {
  return try {
    val dir = ctx.getExternalFilesDir(null) ?: return false
    File(dir, "rvpush-sonde").exists()
  } catch (e: Exception) {
    false
  }
}

/**
 * ATOMIC test-and-set: "has this messageId already produced a conversation
 * notification?", and if not, it is about to, recorded right away.
 *
 * Both id-only paths (FCM redelivery handled directly, and the catch-up worker)
 * are woken by the SAME event, the network coming back. Nothing remembered that
 * a messageId had already been shown: \`showRoomNotification\` re-extracts the
 * active MessagingStyle and ADDS the message to it, so the same text appeared
 * twice with "2 new messages".
 *
 * \`commit()\` and not \`apply()\`: the FCM dispatch process may be killed right
 * after; a write still in flight would protect nothing.
 *
 * Best-effort in the right direction: any exception returns \`false\`, so it
 * SHOWS. A duplicate is a nuisance, a lost notification is a missed message.
 */
private fun alreadyShown(ctx: Context, messageId: String): Boolean {
  if (messageId.isEmpty()) return false
  try {
    synchronized(SHOWN_LOCK) {
      val prefs = ctx.getSharedPreferences(PREFS_SHOWN, Context.MODE_PRIVATE)
      val now = System.currentTimeMillis()
      val markedAt = prefs.getLong(messageId, 0L)
      if (markedAt != 0L && now - markedAt <= SHOWN_RETENTION_MS) return true
      val edit = prefs.edit()
      for ((key, value) in prefs.all) {
        val entryAt = value as? Long ?: 0L
        if (now - entryAt > SHOWN_RETENTION_MS) edit.remove(key)
      }
      edit.putLong(messageId, now)
      edit.commit()
    }
  } catch (e: Exception) {
    Log.w(TAG, "alreadyShown", e)
  }
  return false
}

/**
 * The resources in the user's language. The app's EXPLICIT preference
 * (\`langue-preferee\`, written by \`ui/i18n.ts\` in the same SecureStore as
 * the session) wins over the phone's locale; otherwise a user who chose
 * "Français" on an English phone would see the app in French and its
 * notifications in English. "Automatic" DELETES the key on the JS side: its
 * absence therefore means "follow the phone", and we return the resources as
 * they are.
 */
private fun localizedResources(ctx: Context): Resources {
  return try {
    val pref = readPreferredLanguage(ctx) ?: return ctx.resources
    val config = Configuration(ctx.resources.configuration)
    config.setLocale(Locale.forLanguageTag(pref))
    ctx.createConfigurationContext(config).resources
  } catch (e: Exception) {
    ctx.resources
  }
}

private fun readPreferredLanguage(ctx: Context): String? {
  return try {
    val prefs = ctx.getSharedPreferences("SecureStore", Context.MODE_PRIVATE)
    val raw = prefs.getString("key_v1-langue-preferee", null) ?: return null
    val plain = decryptSecureStore(raw) ?: return null
    if (plain == "fr" || plain == "en") plain else null
  } catch (e: Exception) {
    null
  }
}

/**
 * A \`strings.xml\` string in the user's language.
 *
 * DIRECT reference to \`R.string\`, not \`resources.getIdentifier(name, …)\` as
 * for the icon just below: a constant fails the BUILD if \`withNativeStrings\`
 * did not write the resources, where \`getIdentifier\` would silently return 0,
 * and it survives a \`shrinkResources\`, which does not see lookups by name.
 * The hard-coded fallback therefore only covers the unlikely case of a
 * \`getString\` that throws.
 */
private fun localizedString(ctx: Context, id: Int, fallback: String): String {
  return try {
    localizedResources(ctx).getString(id)
  } catch (e: Exception) {
    fallback
  }
}

/**
 * Builds (or extends) the room's MessagingStyle notification from normalized
 * fields: title, text, and the object carrying sender/type/messageType (REST
 * payload or push ejson, same shape). Shared by both regimes, and by the
 * deferred catch-up.
 *
 * \`host\` comes from the CALLER (the push ejson, or the worker input), never
 * from the \`push.get\` payload whose shape is not guaranteed: it is the server
 * the notification is about, and the tap must lead back to it.
 */
private fun showRoomNotification(
  ctx: Context,
  rid: String,
  title: String,
  initialText: String,
  ejson: JSONObject,
  host: String,
  silent: Boolean = false,
): Boolean {
  var text = initialText

  // Same E2EE degradation as on the JS side: never ciphertext on screen.
  if (ejson.optString("messageType") == "e2e") {
    text = localizedString(ctx, R.string.rv_push_encrypted_message, "Encrypted message")
  }

  val sender = ejson.optJSONObject("sender")
  val senderName = sender?.optString("name")?.takeIf { it.isNotEmpty() }
    ?: sender?.optString("username")?.takeIf { it.isNotEmpty() }
    ?: title
  // RC often prefixes the text with "username: " when the style's Person
  // already carries the name; we strip it so it is not shown twice.
  val username = sender?.optString("username")
  if (username != null && username.isNotEmpty() && text.startsWith(username + ": ")) {
    text = text.substring(username.length + 2)
  }

  val notifId = rid.hashCode()
  val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  // Re-extract the style of the same room's active notification: earlier
  // messages stay visible, the new one is appended.
  val active = manager.activeNotifications.firstOrNull { it.id == notifId }
  val style = active?.let {
    NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it.notification)
  } ?: NotificationCompat.MessagingStyle(
    Person.Builder().setName(localizedString(ctx, R.string.rv_push_me, "You")).build(),
  )

  // 1:1 DM: no conversation title, Android shows the name carried by each
  // message. Channel/group: the push title ("#general", …).
  if (ejson.optString("type") != "d") {
    style.setConversationTitle(title)
  }
  style.addMessage(
    text,
    System.currentTimeMillis(),
    Person.Builder().setName(senderName).build(),
  )

  // No reply from the notification on an encrypted message: the server would
  // reject plaintext (\`error-not-allowed\`). A thread message gets its reply
  // in the thread.
  publishRoomNotification(
    ctx,
    rid,
    host,
    style,
    silent,
    allowReply = ejson.optString("messageType") != "e2e",
    tmid = ejson.optString("tmid").ifEmpty { null },
  )
  if (BuildConfig.DEBUG) {
    Log.d(TAG, "room notification posted (rid=" + rid + ", id=" + notifId + ")")
  }
  return true
}

/**
 * Posts a room's conversation notification from an already filled style.
 * Shared by the display of a push and by the update that follows a reply typed
 * in the notification.
 */
private fun publishRoomNotification(
  ctx: Context,
  rid: String,
  host: String,
  style: NotificationCompat.MessagingStyle,
  silent: Boolean,
  allowReply: Boolean,
  tmid: String?,
  subText: String? = null,
) {
  val notifId = rid.hashCode()
  // The tap opens the room through an expo-router deep link. MainActivity is
  // \`singleTask\`: with ONLY the NEW_TASK flag, a VIEW is delivered to the live
  // Activity through onNewIntent (app running/in background, NO recreation),
  // and starts a FRESH Activity if the process is dead; either way the intent
  // carries the URL.
  //
  // The \`host\` travels WITH the rid: the app supports several simultaneous
  // sessions (\`switchServer\` clears none) and the push token is registered on
  // each, so both servers push. Without it, a rid from ANOTHER server landed on
  // a room screen with no row for that rid: the loading effect short-circuited
  // and the screen kept its activity indicator forever. The screen can now offer
  // the switch (\`app/salon/[rid].tsx\`).
  //
  // NO CLEAR_TASK: it RECREATED MainActivity even with the process alive, which
  // UNREGISTERS expo-image-picker's ActivityResultLaunchers. Expo only
  // re-registers them when it sees \`hostWasDestroyed\` in onHostResume, and the
  // order of CLEAR_TASK's callbacks (new Activity resumed BEFORE the old one is
  // destroyed) bypasses that test: attaching a file then failed with
  // "unregistered ActivityResultLauncher" until a full restart.
  // NO SINGLE_TOP either: combined with NEW_TASK on an Activity already in the
  // foreground, it prevented navigating to the room (seen on the AVD).
  val link = StringBuilder("rocketvibe://salon/").append(Uri.encode(rid))
  if (host.isNotEmpty()) link.append("?host=").append(Uri.encode(host))
  val tap = Intent(Intent.ACTION_VIEW, Uri.parse(link.toString()))
    .setPackage(ctx.packageName)
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  val pending = PendingIntent.getActivity(
    ctx,
    notifId,
    tap,
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  val icon = ctx.resources.getIdentifier("notification_icon", "drawable", ctx.packageName)
  val builder = NotificationCompat.Builder(ctx, "default")
    .setSmallIcon(if (icon != 0) icon else android.R.drawable.ic_dialog_email)
    .setColor(ACCENT_COLOR)
    .setStyle(style)
    .setContentIntent(pending)
    .setAutoCancel(true)
    .setPriority(NotificationCompat.PRIORITY_HIGH)
    .setCategory(NotificationCompat.CATEGORY_MESSAGE)
    .setSilent(silent)
  if (subText != null) builder.setSubText(subText)
  if (allowReply && host.isNotEmpty()) builder.addAction(replyAction(ctx, rid, host, tmid))
  NotificationManagerCompat.from(ctx).notify(notifId, builder.build())
}

/**
 * The "Reply" action: a text field in the notification, delivered to
 * \`ReponseNotifReceiver\`. The PendingIntent must be MUTABLE: the system puts
 * the typed text into it. It is explicit (named class), which stops any other
 * app from hijacking it.
 */
private fun replyAction(
  ctx: Context,
  rid: String,
  host: String,
  tmid: String?,
): NotificationCompat.Action {
  val label = localizedString(ctx, R.string.rv_push_reply, "Reply")
  val intent = Intent(ctx, ${RECEIVER_CLASS}::class.java)
    .putExtra(EXTRA_RID, rid)
    .putExtra(EXTRA_HOST, host)
  if (tmid != null) intent.putExtra(EXTRA_TMID, tmid)
  val pending = PendingIntent.getBroadcast(
    ctx,
    rid.hashCode(),
    intent,
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
  )
  val remoteInput = RemoteInput.Builder(REPLY_KEY).setLabel(label).build()
  return NotificationCompat.Action.Builder(0, label, pending)
    .addRemoteInput(remoteInput)
    .setAllowGeneratedReplies(true)
    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
    .setShowsUserInterface(false)
    .build()
}


/**
 * Fallback when the content could not be fetched: without a rid we can neither
 * group nor deep link, the tap simply opens the app.
 */
private fun postFallbackNotification(ctx: Context, messageId: String) {
  try {
    val notifId = if (messageId.isNotEmpty()) messageId.hashCode() else 0
    val launchIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val pending = PendingIntent.getActivity(
      ctx,
      notifId,
      launchIntent ?: Intent(),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val title = try {
      ctx.applicationInfo.loadLabel(ctx.packageManager).toString()
    } catch (e: Exception) {
      "Rocket Vibe"
    }
    val icon = ctx.resources.getIdentifier("notification_icon", "drawable", ctx.packageName)
    val notification = NotificationCompat.Builder(ctx, "default")
      .setSmallIcon(if (icon != 0) icon else android.R.drawable.ic_dialog_email)
      .setColor(ACCENT_COLOR)
      .setContentTitle(title)
      .setContentText(localizedString(ctx, R.string.rv_push_new_message, "New message"))
      .setContentIntent(pending)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .build()
    NotificationManagerCompat.from(ctx).notify(notifId, notification)
  } catch (e: Exception) {
    Log.w(TAG, "postFallbackNotification", e)
  }
}

/**
 * Schedules the deferred catch-up of a failed push.get. Network constraint: in
 * Doze with the radio off, the attempt waits for the maintenance window or the
 * device waking up, which is exactly the case seen in the field. KEEP
 * uniqueness per messageId: an FCM redelivery of the same push does not create
 * a second worker.
 *
 * \`retryDelayMs\` covers the 429 case: the server said WHEN it will reopen
 * (\`x-ratelimit-reset\`), no point burning an attempt before. A burst in a
 * busy room quickly exceeds \`push.get\`'s 10 req/min.
 */
private fun scheduleCatchUp(
  ctx: Context,
  host: String,
  messageId: String,
  shadow: Boolean,
  retryDelayMs: Long,
) {
  try {
    val workData = Data.Builder()
      .putString("host", host)
      .putString("messageId", messageId)
      .putBoolean("ombre", shadow)
      .build()
    val builder = OneTimeWorkRequest.Builder(RattrapagePushWorker::class.java)
      .setInputData(workData)
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.SECONDS)
    if (retryDelayMs > 0) builder.setInitialDelay(retryDelayMs, TimeUnit.MILLISECONDS)
    WorkManager.getInstance(ctx)
      .enqueueUniqueWork(CATCH_UP_WORK_PREFIX + messageId, ExistingWorkPolicy.KEEP, builder.build())
    // Log.w on purpose (visible in release): it is the field diagnostic trace,
    // and a messageId exposes no content.
    Log.w(TAG, "push.get failed, catch-up scheduled (" + messageId + ")")
    debugLog(ctx, "catch-up scheduled in " + retryDelayMs + " ms (" + messageId + ")")
  } catch (e: Exception) {
    Log.w(TAG, "scheduleCatchUp: failed", e)
    debugLog(ctx, "scheduleCatchUp FAILED: " + e.javaClass.simpleName + " (" + messageId + ")")
  }
}

/**
 * Cancels the pending catch-up of a message whose content was just obtained by
 * another path (FCM redelivery handled successfully): otherwise the worker would
 * add the same message to the conversation a second time. Does NOT interrupt a
 * worker already running; \`isStopped\` and \`alreadyShown\` cover that case.
 */
private fun cancelCatchUp(ctx: Context, messageId: String) {
  try {
    WorkManager.getInstance(ctx).cancelUniqueWork(CATCH_UP_WORK_PREFIX + messageId)
  } catch (e: Exception) {
    Log.w(TAG, "cancelCatchUp: failed", e)
  }
}

/**
 * Scheme + authority of a web URL, lowercased; null if it is not one. Kotlin
 * counterpart of \`lib/origin.ts\`, the same rule written twice for lack of a
 * shared language between the native service and the app. The authority is
 * taken AS IS, userinfo included: "https://server@evil" must never reduce to
 * "https://server".
 */
private fun originOf(url: String): String? {
  val m = Regex("^(https?://[^/?#]+)", RegexOption.IGNORE_CASE).find(url) ?: return null
  return m.groupValues[1].lowercase()
}

/**
 * Reads the expo-secure-store session matching the host, without a JS runtime.
 * Mirrors expo-secure-store 57's storage format: SharedPreferences
 * "SecureStore", one "key_v1-session-<digest>" entry per server, whose value is
 * an AES/GCM envelope decryptable with an AndroidKeyStore key.
 *
 * Only the session whose baseUrl has the SAME ORIGIN as the requested host is
 * kept. There used to be a fallback here, "only one known session, take it even
 * if the host does not match": \`host\` comes entirely from the FCM payload and
 * is validated nowhere, so anyone able to send to the device's FCM token could
 * have X-User-Id and X-Auth-Token sent to the domain of their choice, outside
 * any JS runtime, without a trace. The tolerance that fallback aimed for
 * (trailing slash, subpath) is covered by the origin comparison; DOMAIN
 * tolerance was never intended.
 */
private fun readSession(ctx: Context, host: String): JSONObject? {
  return try {
    val expected = originOf(host)
    if (expected == null) {
      Log.w(TAG, "readSession: non-web host, rejected")
      debugLog(ctx, "push: host rejected (" + host + ")")
      return null
    }
    val prefs = ctx.getSharedPreferences("SecureStore", Context.MODE_PRIVATE)
    for ((key, value) in prefs.all) {
      if (!key.startsWith("key_v1-session-")) continue
      val raw = value as? String ?: continue
      val plain = decryptSecureStore(raw) ?: continue
      val session = try {
        JSONObject(plain)
      } catch (e: Exception) {
        continue
      }
      if (session.optString("authToken").isEmpty() || session.optString("userId").isEmpty()) continue
      if (originOf(session.optString("baseUrl")) == expected) return session
    }
    debugLog(ctx, "push: no session for " + expected)
    null
  } catch (e: Exception) {
    Log.w(TAG, "readSession: failed", e)
    null
  }
}

/**
 * Decrypts an expo-secure-store envelope ("aes" scheme). The IV, the GCM tag
 * length and the key alias are in the envelope; the symmetric key lives in the
 * AndroidKeyStore, generated by expo-secure-store.
 */
private fun decryptSecureStore(envelope: String): String? {
  return try {
    val obj = JSONObject(envelope)
    // "hybrid" scheme = API < 23, out of scope (RN 0.86 minSdk >= 24).
    if (obj.optString("scheme") != "aes") return null
    val ct = Base64.decode(obj.getString("ct"), Base64.DEFAULT)
    val iv = Base64.decode(obj.getString("iv"), Base64.DEFAULT)
    val tlen = obj.getInt("tlen")
    val base = obj.optString("keystoreAlias", "key_v1").ifEmpty { "key_v1" }
    val suffix = if (obj.optBoolean("requireAuthentication", false)) {
      "keystoreAuthenticated"
    } else {
      "keystoreUnauthenticated"
    }
    val alias = "AES/GCM/NoPadding:" + base +
      (if (obj.optBoolean("usesKeystoreSuffix", false)) ":" + suffix else "")
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val entry = ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry ?: return null
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, entry.secretKey, GCMParameterSpec(tlen, iv))
    String(cipher.doFinal(ct), Charsets.UTF_8)
  } catch (e: Exception) {
    Log.w(TAG, "decryptSecureStore: failed", e)
    null
  }
}

/** Key of the text typed in the notification (RemoteInput). */
private const val REPLY_KEY = "rv_reponse"
private const val EXTRA_RID = "rid"
private const val EXTRA_HOST = "host"
private const val EXTRA_TMID = "tmid"

/**
 * Time budget of a reply sent from the notification. \`goAsync\` gives the
 * receiver about ten seconds: 4 + 4 fits, margin included.
 */
private const val REPLY_TIMEOUT_MS = 4000

/**
 * Receives the text typed in the "Reply" action and posts it through
 * \`chat.sendMessage\`, with the server session read as for push.get (same
 * origin guard). The notification is always reposted afterwards: until we do,
 * Android keeps the sending indicator spinning.
 */
class ${RECEIVER_CLASS} : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    val text = RemoteInput.getResultsFromIntent(intent)
      ?.getCharSequence(REPLY_KEY)
      ?.toString()
      ?.trim()
      .orEmpty()
    val rid = intent.getStringExtra(EXTRA_RID).orEmpty()
    val host = intent.getStringExtra(EXTRA_HOST).orEmpty()
    val tmid = intent.getStringExtra(EXTRA_TMID)
    if (rid.isEmpty() || host.isEmpty()) return
    val appContext = ctx.applicationContext
    val pendingResult = goAsync()
    Thread {
      try {
        val sent = text.isNotEmpty() && readSession(appContext, host)?.let {
          sendReply(appContext, it, rid, tmid, text)
        } == true
        debugLog(appContext, "reply from notification (rid=" + rid + "): " + (if (sent) "OK" else "FAILED"))
        repostAfterReply(appContext, rid, host, tmid, text, sent)
      } catch (e: Exception) {
        Log.w(TAG, "${RECEIVER_CLASS}", e)
      } finally {
        pendingResult.finish()
      }
    }.start()
  }
}

/** POST <baseUrl>/api/v1/chat.sendMessage, \`true\` if the server accepted it. */
private fun sendReply(
  ctx: Context,
  session: JSONObject,
  rid: String,
  tmid: String?,
  text: String,
): Boolean {
  var conn: HttpURLConnection? = null
  return try {
    val message = JSONObject().put("rid", rid).put("msg", text)
    if (tmid != null) message.put("tmid", tmid)
    val body = JSONObject().put("message", message).toString().toByteArray(Charsets.UTF_8)
    val url = URL(withoutTrailingSlash(session.optString("baseUrl")) + "/api/v1/chat.sendMessage")
    conn = (url.openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      doOutput = true
      setRequestProperty("X-User-Id", session.optString("userId"))
      setRequestProperty("X-Auth-Token", session.optString("authToken"))
      setRequestProperty("Content-Type", "application/json; charset=utf-8")
      setRequestProperty("Accept", "application/json")
      connectTimeout = REPLY_TIMEOUT_MS
      readTimeout = REPLY_TIMEOUT_MS
    }
    conn.outputStream.use { it.write(body) }
    val code = conn.responseCode
    if (code != 200) {
      debugLog(ctx, "chat.sendMessage HTTP " + code + " (rid=" + rid + ")")
      return false
    }
    val responseBody = conn.inputStream.bufferedReader().use { it.readText() }
    JSONObject(responseBody).optBoolean("success", false)
  } catch (e: Exception) {
    Log.w(TAG, "sendReply: failed", e)
    debugLog(ctx, "chat.sendMessage " + e.javaClass.simpleName + " (rid=" + rid + ")")
    false
  } finally {
    conn?.disconnect()
  }
}

/**
 * Reposts the room notification after a reply: the reply is added to the
 * conversation (as "You") if it went out, otherwise a subtitle says it did not
 * and the field stays there to retry.
 */
private fun repostAfterReply(
  ctx: Context,
  rid: String,
  host: String,
  tmid: String?,
  text: String,
  sent: Boolean,
) {
  val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
  val active = manager.activeNotifications.firstOrNull { it.id == rid.hashCode() }
  val style = active?.let {
    NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it.notification)
  } ?: NotificationCompat.MessagingStyle(
    Person.Builder().setName(localizedString(ctx, R.string.rv_push_me, "You")).build(),
  )
  if (sent) style.addMessage(text, System.currentTimeMillis(), null as Person?)
  publishRoomNotification(
    ctx,
    rid,
    host,
    style,
    silent = true,
    allowReply = true,
    tmid = tmid,
    subText = if (sent) null else localizedString(ctx, R.string.rv_push_reply_failed, "Reply not sent"),
  )
}

/**
 * The outcome of a push.get. \`null\` only said "it did not work": the failure
 * path therefore scheduled eight WorkManager attempts on a revoked token
 * exactly as on a sleeping radio.
 */
private class PushResult(
  val notification: JSONObject?,
  /** HTTP code, or 0 if the request did not complete (network, timeout, unreadable body). */
  val code: Int,
  /** Delay before a useful retry (429: \`x-ratelimit-reset\`), 0 if immediate. */
  val retryDelayMs: Long = 0L,
) {
  /** A refusal time will not change: do not schedule a catch-up. */
  val permanent: Boolean get() = code == 401 || code == 403
}

/**
 * Time budget of the fetch, in milliseconds. We are on the FCM dispatch thread:
 * the comment promised a "tight timeout" but set 8 s of connect AND 8 s of read,
 * 16 s in Doze with the radio down, enough to get killed mid-fetch, which causes
 * exactly the FCM redelivery and the family of duplicates fought elsewhere.
 * 3 + 3 lets the WorkManager catch-up do its job, which is precisely to have
 * time.
 */
private const val TIMEOUT_PUSH_GET_MS = 3000

/** Cap on the wait derived from a 429: beyond it, the ordinary backoff is enough. */
private const val MAX_429_WAIT_MS = 60_000L

/**
 * GET <baseUrl>/api/v1/push.get?id=<messageId>, authenticated by the session
 * read. Returns the notification (title/text/payload) AND the HTTP code, so the
 * caller can tell a transient outage from a permanent refusal.
 *
 * The URL is built on the SESSION's \`baseUrl\`, never on the payload's
 * \`host\`: we choose where the token goes. \`readSession\` already checked
 * both have the same origin, but the baseUrl also carries the subpath of an
 * instance mounted somewhere other than the root.
 */
private fun fetchContent(
  ctx: Context,
  messageId: String,
  session: JSONObject,
): PushResult {
  var conn: HttpURLConnection? = null
  return try {
    val url = URL(
      withoutTrailingSlash(session.optString("baseUrl")) +
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
      debugLog(ctx, "push.get HTTP " + code + " (" + messageId + ")")
      return PushResult(null, code, if (code == 429) waitAfter429(conn) else 0L)
    }
    val body = conn.inputStream.bufferedReader().use { it.readText() }
    val json = JSONObject(body)
    if (!json.optBoolean("success", false)) return PushResult(null, code)
    PushResult(json.optJSONObject("data")?.optJSONObject("notification"), code)
  } catch (e: Exception) {
    Log.w(TAG, "fetchContent: failed", e)
    debugLog(
      ctx,
      "push.get " + e.javaClass.simpleName + ": " + (e.message ?: "") + " (" + messageId + ")",
    )
    PushResult(null, 0)
  } finally {
    conn?.disconnect()
  }
}

/**
 * The server gives the reopening time in epoch ms in \`x-ratelimit-reset\`
 * (the same header \`lib/rest.ts\` reads). Missing or absurd header: 0, and
 * the catch-up starts as soon as the network is there.
 */
private fun waitAfter429(conn: HttpURLConnection): Long {
  return try {
    val raw = conn.getHeaderField("x-ratelimit-reset")?.toLongOrNull() ?: return 0L
    val delay = raw - System.currentTimeMillis()
    if (delay <= 0L) 0L else minOf(delay, MAX_429_WAIT_MS)
  } catch (e: Exception) {
    0L
  }
}

/** Strips trailing "/", like withoutTrailingSlash on the JS side (sessionStore). */
private fun withoutTrailingSlash(u: String): String = u.trimEnd('/')
`;
}

// ---------------------------------------------------------------------------
// Config surgery: the PURE part of the plugin, the one that needs neither Expo
// nor a build to be judged. Exported (`internals`) and covered by
// `plugins/with-fcm-deeplink.test.mjs`: the Kotlin above can only be checked by
// compiling, but this is plain JS, and two of its properties are load-bearing:
// the service's priority `1` (without it, FCM routes to expo's service and the
// whole file goes dead) and exactly where the `implementation` lines land.
// ---------------------------------------------------------------------------

/**
 * The TOP-LEVEL `dependencies` block of a Groovy `build.gradle`: the one that
 * starts at column 0. `/dependencies\s*\{/` targeted the FIRST occurrence in the
 * file, at any depth; correct today by virtue of the RN 0.86 template (it has
 * only one), not of the plugin. A nested block (`buildscript { dependencies { … } }`,
 * a `subprojects`) would have received our artifacts, where they do not compile
 * the app module.
 */
const DEPENDENCIES_BLOCK = /^dependencies\s*\{/m;

/**
 * Adds the missing artifacts to the root `dependencies` block.
 *
 * The guard is `includes(artifact)` WITHOUT the version: if another dependency
 * already brings `com.google.firebase:firebase-messaging` in a nearby version,
 * declaring a second one would split resolution. Idempotent too: an
 * `expo prebuild` without `--clean` goes over an already processed file again.
 *
 * A missing root block THROWS instead of returning the file untouched: the
 * build would fail much further on, on a Kotlin class not found, and the cause
 * would have to be tracked down.
 */
function addDependencies(contents, deps) {
  if (!DEPENDENCIES_BLOCK.test(contents)) {
    throw new Error(
      "with-fcm-deeplink: no top-level `dependencies {` block in app/build.gradle, " +
        'firebase-messaging and work-runtime cannot be declared.',
    );
  }
  let output = contents;
  for (const dep of deps) {
    const artifact = dep.substring(0, dep.lastIndexOf(':'));
    if (output.includes(artifact)) continue;
    output = output.replace(DEPENDENCIES_BLOCK, (m) => `${m}\n    implementation("${dep}")`);
  }
  return output;
}

/**
 * Declares our `FirebaseMessagingService` in the manifest's `<application>`.
 *
 * `android:priority="1"` is not decorative: expo-notifications' is `-1`, and FCM
 * routes the intent to the highest-priority service. A lower value would make
 * all the Kotlin in this file unreachable, with no build error and no message,
 * just notifications turning back into expo's.
 */
function addService(application, serviceName = `.${SERVICE_CLASS}`) {
  application.service = application.service || [];
  const already = application.service.some((s) => s.$?.['android:name'] === serviceName);
  if (!already) {
    application.service.push({
      $: { 'android:name': serviceName, 'android:exported': 'false' },
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
 * Declares the receiver of the "Reply" action. Not exported: only our explicit
 * PendingIntent can reach it.
 */
function addReceiver(application, name = `.${RECEIVER_CLASS}`) {
  application.receiver = application.receiver || [];
  const already = application.receiver.some((r) => r.$?.['android:name'] === name);
  if (!already) {
    application.receiver.push({ $: { 'android:name': name, 'android:exported': 'false' } });
  }
  return application;
}

/** The `strings.xml` of a given language, as written to `res/values-<lang>/`. */
function stringsXml(language) {
  const rows = Object.entries(NATIVE_STRINGS).map(
    ([name, forms]) => `    <string name="${name}">${escapeXml(forms[language])}</string>`,
  );
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${rows.join('\n')}\n</resources>\n`;
}

/**
 * Android escaping: the XML entities, plus the apostrophe, which the resource
 * compiler treats as a delimiter and rejects unescaped.
 */
function escapeXml(s) {
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
        throw new Error('with-fcm-deeplink: android.package missing from app.json');
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
      throw new Error('with-fcm-deeplink: <application> not found in the manifest');
    }
    addService(application);
    addReceiver(application);
    return config;
  });
}

function withNativeDeps(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = addDependencies(config.modResults.contents, [
      FIREBASE_MESSAGING,
      ANDROIDX_WORK,
    ]);
    return config;
  });
}

/**
 * The native path's strings. `values/` (default, English) goes through Expo's
 * helper, which MERGES with what the template already puts there (`app_name`…);
 * `values-fr/` is a folder only we fill, so it is written as is.
 */
function withNativeStrings(config) {
  config = withStringsXml(config, (config) => {
    for (const [name, forms] of Object.entries(NATIVE_STRINGS)) {
      config.modResults = AndroidConfig.Strings.setStringItem(
        [AndroidConfig.Resources.buildResourceItem({ name, value: forms.en })],
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
  config = withNativeStrings(config);
  return config;
};

// For the tests (`plugins/with-fcm-deeplink.test.mjs`), not for the app.
module.exports.internals = {
  SERVICE_CLASS,
  RECEIVER_CLASS,
  addDependencies,
  addReceiver,
  addService,
  escapeXml,
  stringsXml,
  NATIVE_STRINGS,
};
