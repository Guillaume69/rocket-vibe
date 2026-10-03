/** Appended to the existing FCM service by with-fcm-deeplink. CNG regenerates
 * Android sources; this is the authoritative native RocketVibe adaptation. */
module.exports = function nativePushSource() {
  return String.raw`

// RocketVibe HTTP v1: no URL, bearer or chat content comes from FCM.
private fun enregistrerRotationNative(ctx: Context, token: String) {
  if (token.isEmpty() || token.length > 4096) return
  try {
    ctx.getSharedPreferences("rv-native-fcm", Context.MODE_PRIVATE).edit().putString("token", token).commit()
    for ((key, value) in ctx.getSharedPreferences("SecureStore", Context.MODE_PRIVATE).all) {
      if (!key.startsWith("key_v1-session-")) continue
      val session = JSONObject(dechiffrerSecureStore(value as? String ?: continue) ?: continue)
      if (session.optString("genre") != "rocketvibe") continue
      val scope = JSONObject().put("instanceId", session.optString("nativeInstanceId")).put("dataEpoch", session.optString("nativeDataEpoch"))
        .put("userId", session.optString("userId")).put("deviceId", session.optString("nativePushDeviceId"))
      if (!arrayOf("instanceId", "dataEpoch", "userId", "deviceId").all { identifiantNatif(scope.optString(it)) }) continue
      val work = OneTimeWorkRequest.Builder(JetonNatifWorker::class.java).setInputData(Data.Builder().putString("scope", scope.toString()).putLong("created", System.currentTimeMillis()).build())
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
      // A newer rotation follows any request already in flight. Read the latest
      // SDK token when running, so a delayed worker never intentionally restores an old token.
      WorkManager.getInstance(ctx).enqueueUniqueWork("native-token:" + cleNotifNative(scope, scope.optString("deviceId")), ExistingWorkPolicy.APPEND_OR_REPLACE, work)
    }
  } catch (_: Exception) { journal(ctx, "native token rotation scheduling failed") }
}
class JetonNatifWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
  override fun doWork(): Result {
    val scope = try { JSONObject(inputData.getString("scope") ?: return Result.failure()) } catch (_: Exception) { return Result.failure() }
    val session = lireSessionNative(applicationContext, scope) ?: return Result.success()
    if (isStopped || runAttemptCount >= 8 || System.currentTimeMillis() - inputData.getLong("created", 0L) > 86400000L) return Result.success()
    val server = verifierServeurNatif(session, scope)
    if (server == 409) return Result.success()
    if (server != 200) return Result.retry()
    val token = applicationContext.getSharedPreferences("rv-native-fcm", Context.MODE_PRIVATE).getString("token", null) ?: return Result.success()
    val response = httpNatif(session, "/api/v1/me/push", JSONObject().put("token", token), method = "PUT")
    if (response.code in arrayOf(400, 401, 403, 404, 409)) return Result.success()
    val receipt = response.body ?: return Result.retry()
    return if (receipt.optString("device_id") == scope.optString("deviceId") && receipt.optString("instance_id") == scope.optString("instanceId") && receipt.optString("data_epoch") == scope.optString("dataEpoch")) Result.success() else Result.failure()
  }
}
private fun identifiantNatif(value: String): Boolean = value.matches(Regex("[A-Za-z0-9_-]{1,128}"))
private fun contexteNatif(extras: Bundle): JSONObject? {
  val scope = JSONObject()
  for (key in arrayOf("instanceId", "dataEpoch", "userId", "deviceId", "notificationId", "rid", "messageId")) {
    val value = extras.getString(key).orEmpty()
    if (!identifiantNatif(value)) return null
    scope.put(key, value)
  }
  val root = extras.getString("tmid").orEmpty()
  if (root.isNotEmpty()) { if (!identifiantNatif(root)) return null; scope.put("tmid", root) }
  return scope
}
private fun cleNotifNative(scope: JSONObject, rid: String): String =
  "rocketvibe:" + scope.optString("instanceId") + ":" + scope.optString("dataEpoch") + ":" + scope.optString("userId") + ":" + rid
private fun clePushNatif(scope: JSONObject): String = cleNotifNative(scope, scope.optString("notificationId"))

private fun lireSessionNative(ctx: Context, scope: JSONObject): JSONObject? {
  return try {
    for ((key, value) in ctx.getSharedPreferences("SecureStore", Context.MODE_PRIVATE).all) {
      if (!key.startsWith("key_v1-session-")) continue
      val clear = dechiffrerSecureStore(value as? String ?: continue) ?: continue
      val session = JSONObject(clear)
      if (session.optString("genre") != "rocketvibe" || session.optString("authToken").isEmpty()) continue
      if (session.optString("nativeInstanceId") != scope.optString("instanceId") ||
          session.optString("nativeDataEpoch") != scope.optString("dataEpoch") ||
          session.optString("userId") != scope.optString("userId") ||
          session.optString("nativePushDeviceId") != scope.optString("deviceId")) continue
      val url = URL(session.optString("baseUrl"))
      if (url.host.isEmpty() || url.userInfo != null || url.query != null || url.ref != null ||
          (url.protocol != "https" && !(BuildConfig.DEBUG && url.protocol == "http"))) continue
      return session
    }
    null
  } catch (_: Exception) { null }
}
private class ReponseNative(val code: Int, val body: JSONObject? = null)
private fun httpNatif(session: JSONObject, path: String, body: JSONObject? = null, anonymous: Boolean = false, method: String = if (body == null) "GET" else "POST"): ReponseNative {
  fun perform(token: String): ReponseNative {
    var conn: HttpURLConnection? = null
    return try {
      conn = (URL(sansSlashFinal(session.optString("baseUrl")) + path).openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = 4000; readTimeout = 4000
        requestMethod = method
        setRequestProperty("Accept", "application/json")
        if (!anonymous) setRequestProperty("Authorization", "Bearer " + token)
        if (body != null) { doOutput = true; setRequestProperty("Content-Type", "application/json") }
      }
      if (body != null) conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
      val code = conn.responseCode
      if (code != 200) return ReponseNative(code)
      val bytes = java.io.ByteArrayOutputStream()
      conn.inputStream.use { input ->
        val buffer = ByteArray(8192)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          if (bytes.size() + read > 1024 * 1024) return ReponseNative(0)
          bytes.write(buffer, 0, read)
        }
      }
      ReponseNative(code, JSONObject(bytes.toString("UTF-8")))
    } catch (_: Exception) { ReponseNative(0) } finally { conn?.disconnect() }
  }
  val result = perform(session.optString("authToken"))
  // The app may have died after the server rotated the bearer, before saving its
  // confirmation. Its already persisted successor can read / send on that family.
  val successor = session.optJSONObject("nativeRenewal")?.optString("next_token").orEmpty()
  return if (!anonymous && result.code == 401 && successor.matches(Regex("[a-f0-9]{64}"))) perform(successor) else result
}
private fun verifierServeurNatif(session: JSONObject, scope: JSONObject): Int {
  val response = httpNatif(session, "/.well-known/rocketvibe", anonymous = true)
  val discovery = response.body ?: return if (response.code in arrayOf(400, 401, 403, 404)) 409 else 0
  val versions = discovery.optJSONArray("protocol_versions") ?: return 409
  val supported = (0 until versions.length()).any { versions.optInt(it) == 1 }
  return if (supported && discovery.optString("product") == "rocketvibe" && discovery.optString("api_path") == "/api/v1" &&
    discovery.optString("instance_id") == scope.optString("instanceId") && discovery.optString("data_epoch") == scope.optString("dataEpoch")) 200 else 409
}
private fun lienNatif(session: JSONObject, scope: JSONObject): String =
  "rocketvibe://salon/" + Uri.encode(scope.optString("rid")) + "?host=" + Uri.encode(session.optString("baseUrl")) +
    "&nativeScope=" + Uri.encode(JSONObject().put("instanceId", scope.optString("instanceId"))
      .put("dataEpoch", scope.optString("dataEpoch")).put("userId", scope.optString("userId")).toString())

private fun recevoirPushNatif(ctx: Context, extras: Bundle) {
  try {
    val scope = contexteNatif(extras) ?: return
    val session = lireSessionNative(ctx, scope) ?: return
    val key = clePushNatif(scope)
    val data = Data.Builder().putString("scope", scope.toString()).build()
    val work = OneTimeWorkRequest.Builder(PushNatifWorker::class.java)
      .setInputData(data).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
    WorkManager.getInstance(ctx).enqueueUniqueWork(key, ExistingWorkPolicy.KEEP, work)
    // Generic notification immediately; only authenticated workers obtain text.
    val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.activeNotifications.none { it.id == key.hashCode() } && !pushNatifAffiche(ctx, key)) {
      val tap = Intent(Intent.ACTION_VIEW, Uri.parse(lienNatif(session, scope))).setPackage(ctx.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val pending = PendingIntent.getActivity(ctx, key.hashCode(), tap, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val text = chaine(ctx, R.string.rv_push_nouveau_message, "New message")
      NotificationManagerCompat.from(ctx).notify(key.hashCode(), NotificationCompat.Builder(ctx, "default")
        .setSmallIcon(android.R.drawable.ic_dialog_email).setContentTitle(text).setContentText(text)
        .setContentIntent(pending).setAutoCancel(true).build())
    }
  } catch (_: Exception) { journal(ctx, "native push scheduling failed") }
}
private fun pushNatifAffiche(ctx: Context, key: String): Boolean {
  val whenPosted = ctx.getSharedPreferences(PREFS_AFFICHES, Context.MODE_PRIVATE).getLong(key, 0L)
  return whenPosted != 0L && System.currentTimeMillis() - whenPosted <= RETENTION_AFFICHES_MS
}

class PushNatifWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
  override fun doWork(): Result {
    val scope = try { JSONObject(inputData.getString("scope") ?: return Result.failure()) } catch (_: Exception) { return Result.failure() }
    val key = clePushNatif(scope)
    val manager = NotificationManagerCompat.from(applicationContext)
    fun stop(): Result { manager.cancel(key.hashCode()); return Result.success() }
    val session = lireSessionNative(applicationContext, scope) ?: return stop()
    if (isStopped || runAttemptCount >= 8) return stop()
    val server = verifierServeurNatif(session, scope)
    if (server == 409) return stop()
    if (server != 200) return Result.retry()
    val result = httpNatif(session, "/api/v1/push/notifications/" + scope.optString("notificationId"))
    if (result.code in arrayOf(400, 401, 403, 404, 409)) return stop()
    val value = result.body ?: return Result.retry()
    val message = value.optJSONObject("message") ?: return stop()
    val room = value.optJSONObject("room") ?: return stop()
    if (value.optString("instance_id") != scope.optString("instanceId") || value.optString("data_epoch") != scope.optString("dataEpoch") ||
        value.optString("device_id") != scope.optString("deviceId") || value.optString("notification_id") != scope.optString("notificationId") ||
        room.optString("id") != scope.optString("rid") || message.optString("id") != scope.optString("messageId") ||
        message.optString("room_id") != scope.optString("rid") || message.optBoolean("deleted") || !message.isNull("system")) return stop()
    if (isStopped || lireSessionNative(applicationContext, scope) == null) return stop()
    manager.cancel(key.hashCode())
    if (dejaAffiche(applicationContext, key)) return Result.success()
    val author = message.optJSONObject("author") ?: return stop()
    val text = message.optString("text").ifEmpty {
      val file = message.optJSONArray("files")?.optJSONObject(0)
      file?.optString("filename")?.takeIf { it.isNotEmpty() && it != "null" } ?: message.optJSONArray("cards")?.optJSONObject(0)?.optString("title")?.takeIf { it.isNotEmpty() && it != "null" }
        ?: chaine(applicationContext, R.string.rv_push_nouveau_message, "New message")
    }.take(1024)
    val payload = JSONObject().put("sender", JSONObject().put("name", author.optString("display_name")).put("username", author.optString("username")))
      .put("type", if (room.optString("kind") == "direct") "d" else "c").put("nativeScope", scope)
    message.optString("reply_to").takeIf { it.isNotEmpty() && it != "null" }?.let { payload.put("tmid", it); scope.put("tmid", it) }
    afficherNotifSalon(applicationContext, scope.optString("rid"), room.optString("name"), text, payload, session.optString("baseUrl"), silencieux = true)
    return Result.success()
  }
}

// RemoteInput uses the normal native idempotent send. WorkManager stores an
// operation reference; the bounded local draft has no bearer / FCM credential.
private fun planifierReponseNative(ctx: Context, scope: JSONObject, text: String): Boolean {
  // WorkManager Data is capped at 10 KiB; this path reserves 4 KiB for the reply.
  // Its operation ID and exact input commit together before acknowledging input.
  if (text.isEmpty() || text.toByteArray(Charsets.UTF_8).size > 4096 || lireSessionNative(ctx, scope) == null) return false
  val operation = java.util.UUID.randomUUID().toString()
  val work = OneTimeWorkRequest.Builder(ReponseNativeWorker::class.java).setInputData(Data.Builder()
    .putString("operation", operation).putString("scope", scope.toString()).putString("text", text).putLong("created", System.currentTimeMillis()).build())
    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
  WorkManager.getInstance(ctx).enqueueUniqueWork("native-reply:" + operation, ExistingWorkPolicy.KEEP, work).result.get(3, TimeUnit.SECONDS)
  return true
}
class ReponseNativeWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
  override fun doWork(): Result {
    val operation = inputData.getString("operation") ?: return Result.failure()
    val scope = try { JSONObject(inputData.getString("scope") ?: return Result.failure()) } catch (_: Exception) { return Result.failure() }
    val text = inputData.getString("text") ?: return Result.failure()
    val session = lireSessionNative(applicationContext, scope)
    fun finish(sent: Boolean): Result {
      if (session != null && lireSessionNative(applicationContext, scope) != null) {
        reposerApresReponse(applicationContext, scope.optString("rid"), session.optString("baseUrl"), scope.optString("tmid").ifEmpty { null }, text, sent, scope)
      }
      return Result.success()
    }
    if (session == null || isStopped) return finish(false)
    if (runAttemptCount >= 8 || System.currentTimeMillis() - inputData.getLong("created", 0L) > 86400000L) return finish(false)
    val server = verifierServeurNatif(session, scope)
    if (server == 409) return finish(false)
    if (server != 200) return Result.retry()
    val body = JSONObject().put("operation_id", operation).put("text", text)
    scope.optString("tmid").takeIf { it.isNotEmpty() }?.let { body.put("reply_to", it) }
    val result = httpNatif(session, "/api/v1/rooms/" + scope.optString("rid") + "/messages", body)
    if (result.code == 200 && result.body?.optString("id") == operation && result.body.optString("room_id") == scope.optString("rid")) return finish(true)
    if (result.code in arrayOf(400, 401, 403, 404, 409, 413, 422)) return finish(false)
    return Result.retry()
  }
}
`;
};
