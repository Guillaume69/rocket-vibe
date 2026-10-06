/** Appended to the existing FCM service by with-fcm-deeplink. CNG regenerates
 * Android sources; this is the authoritative native RocketVibe adaptation. */
module.exports = function nativePushSource() {
  return String.raw`

// RocketVibe HTTP v1: no URL, bearer or chat content comes from FCM.
private fun registerNativeTokenRotation(ctx: Context, token: String) {
  if (token.isEmpty() || token.length > 4096) return
  try {
    ctx.getSharedPreferences("rv-native-fcm", Context.MODE_PRIVATE).edit().putString("token", token).commit()
    for ((key, value) in ctx.getSharedPreferences("SecureStore", Context.MODE_PRIVATE).all) {
      if (!key.startsWith("key_v1-session-")) continue
      val session = JSONObject(decryptSecureStore(value as? String ?: continue) ?: continue)
      if (session.optString("kind", session.optString("genre")) != "rocketvibe") continue
      val scope = JSONObject().put("instanceId", session.optString("nativeInstanceId")).put("dataEpoch", session.optString("nativeDataEpoch"))
        .put("userId", session.optString("userId")).put("deviceId", session.optString("nativePushDeviceId"))
      if (!arrayOf("instanceId", "dataEpoch", "userId", "deviceId").all { isNativeIdentifier(scope.optString(it)) }) continue
      val work = OneTimeWorkRequest.Builder(NativeTokenWorker::class.java).setInputData(Data.Builder().putString("scope", scope.toString()).putLong("created", System.currentTimeMillis()).build())
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
      // A newer rotation follows any request already in flight. Read the latest
      // SDK token when running, so a delayed worker never intentionally restores an old token.
      WorkManager.getInstance(ctx).enqueueUniqueWork("native-token:" + nativeNotificationKey(scope, scope.optString("deviceId")), ExistingWorkPolicy.APPEND_OR_REPLACE, work)
    }
  } catch (_: Exception) { debugLog(ctx, "native token rotation scheduling failed") }
}
class NativeTokenWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
  override fun doWork(): Result {
    val scope = try { JSONObject(inputData.getString("scope") ?: return Result.failure()) } catch (_: Exception) { return Result.failure() }
    val session = readNativeSession(applicationContext, scope) ?: return Result.success()
    if (isStopped || runAttemptCount >= 8 || System.currentTimeMillis() - inputData.getLong("created", 0L) > 86400000L) return Result.success()
    val server = checkNativeServer(session, scope)
    if (server == 409) return Result.success()
    if (server != 200) return Result.retry()
    val token = applicationContext.getSharedPreferences("rv-native-fcm", Context.MODE_PRIVATE).getString("token", null) ?: return Result.success()
    val response = nativeHttp(session, "/api/v1/me/push", JSONObject().put("token", token), method = "PUT")
    if (response.code in arrayOf(400, 401, 403, 404, 409)) return Result.success()
    val receipt = response.body ?: return Result.retry()
    return if (receipt.optString("device_id") == scope.optString("deviceId") && receipt.optString("instance_id") == scope.optString("instanceId") && receipt.optString("data_epoch") == scope.optString("dataEpoch")) Result.success() else Result.failure()
  }
}
private fun isNativeIdentifier(value: String): Boolean = value.matches(Regex("[A-Za-z0-9_-]{1,128}"))
private fun nativePushContext(extras: Bundle): JSONObject? {
  val scope = JSONObject()
  for (key in arrayOf("instanceId", "dataEpoch", "userId", "deviceId", "notificationId", "rid", "messageId")) {
    val value = extras.getString(key).orEmpty()
    if (!isNativeIdentifier(value)) return null
    scope.put(key, value)
  }
  val root = extras.getString("tmid").orEmpty()
  if (root.isNotEmpty()) { if (!isNativeIdentifier(root)) return null; scope.put("tmid", root) }
  return scope
}
private fun nativeNotificationKey(scope: JSONObject, rid: String): String =
  "rocketvibe:" + scope.optString("instanceId") + ":" + scope.optString("dataEpoch") + ":" + scope.optString("userId") + ":" + rid
private fun nativePushKey(scope: JSONObject): String = nativeNotificationKey(scope, scope.optString("notificationId"))

private fun readNativeSession(ctx: Context, scope: JSONObject): JSONObject? {
  return try {
    for ((key, value) in ctx.getSharedPreferences("SecureStore", Context.MODE_PRIVATE).all) {
      if (!key.startsWith("key_v1-session-")) continue
      val clear = decryptSecureStore(value as? String ?: continue) ?: continue
      val session = JSONObject(clear)
      if (session.optString("kind", session.optString("genre")) != "rocketvibe" || session.optString("authToken").isEmpty()) continue
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
private class NativeResponse(val code: Int, val body: JSONObject? = null)
private fun nativeHttp(session: JSONObject, path: String, body: JSONObject? = null, anonymous: Boolean = false, method: String = if (body == null) "GET" else "POST"): NativeResponse {
  fun perform(token: String): NativeResponse {
    var conn: HttpURLConnection? = null
    return try {
      conn = (URL(withoutTrailingSlash(session.optString("baseUrl")) + path).openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = 4000; readTimeout = 4000
        requestMethod = method
        setRequestProperty("Accept", "application/json")
        if (!anonymous) setRequestProperty("Authorization", "Bearer " + token)
        if (body != null) { doOutput = true; setRequestProperty("Content-Type", "application/json") }
      }
      if (body != null) conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
      val code = conn.responseCode
      if (code != 200) return NativeResponse(code)
      val bytes = java.io.ByteArrayOutputStream()
      conn.inputStream.use { input ->
        val buffer = ByteArray(8192)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          if (bytes.size() + read > 1024 * 1024) return NativeResponse(0)
          bytes.write(buffer, 0, read)
        }
      }
      NativeResponse(code, JSONObject(bytes.toString("UTF-8")))
    } catch (_: Exception) { NativeResponse(0) } finally { conn?.disconnect() }
  }
  val result = perform(session.optString("authToken"))
  // The app may have died after the server rotated the bearer, before saving its
  // confirmation. Its already persisted successor can read / send on that family.
  val successor = session.optJSONObject("nativeRenewal")?.optString("next_token").orEmpty()
  return if (!anonymous && result.code == 401 && successor.matches(Regex("[a-f0-9]{64}"))) perform(successor) else result
}
private fun checkNativeServer(session: JSONObject, scope: JSONObject): Int {
  val response = nativeHttp(session, "/.well-known/rocketvibe", anonymous = true)
  val discovery = response.body ?: return if (response.code in arrayOf(400, 401, 403, 404)) 409 else 0
  val versions = discovery.optJSONArray("protocol_versions") ?: return 409
  val supported = (0 until versions.length()).any { versions.optInt(it) == 1 }
  return if (supported && discovery.optString("product") == "rocketvibe" && discovery.optString("api_path") == "/api/v1" &&
    discovery.optString("instance_id") == scope.optString("instanceId") && discovery.optString("data_epoch") == scope.optString("dataEpoch")) 200 else 409
}
private fun nativeLink(session: JSONObject, scope: JSONObject): String =
  "rocketvibe://room/" + Uri.encode(scope.optString("rid")) + "?host=" + Uri.encode(session.optString("baseUrl")) +
    "&nativeScope=" + Uri.encode(JSONObject().put("instanceId", scope.optString("instanceId"))
      .put("dataEpoch", scope.optString("dataEpoch")).put("userId", scope.optString("userId")).toString()) +
    "&msg=" + Uri.encode(scope.optString("messageId")) +
    (scope.optString("tmid").takeIf { it.isNotEmpty() }?.let { "&tmid=" + Uri.encode(it) } ?: "")

// A ringing direct call (docs/protocol/VOICE.md): ids only, the ring is read
// authenticated, then the voice module rings it over the lock screen.
private fun nativeVoiceScope(extras: Bundle): JSONObject? {
  val scope = JSONObject()
  for (key in arrayOf("instanceId", "dataEpoch", "userId", "deviceId", "ringId", "rid")) {
    val value = extras.getString(key).orEmpty()
    if (!isNativeIdentifier(value)) return null
    scope.put(key, value)
  }
  return scope
}
private fun receiveVoicePush(ctx: Context, extras: Bundle) {
  try {
    val scope = nativeVoiceScope(extras) ?: return
    val session = readNativeSession(ctx, scope) ?: return
    val ring = scope.optString("ringId")
    if (extras.getString("type") == "voice_ring_end") { com.rocketvibe.voice.VoiceRinging.cancel(ctx, ring); return }
    // A few seconds at most (FCM leaves ~10 s): the caller's name, and whether it still rings for us.
    val value = nativeHttp(session, "/api/v1/voice/rings/" + ring).body
    if (value != null && (value.optString("state") != "ringing" || value.optJSONObject("callee")?.optString("id") != scope.optString("userId") ||
        value.optString("room_id") != scope.optString("rid"))) return
    val caller = value?.optJSONObject("caller")?.let { it.optString("display_name").ifEmpty { it.optString("username") } }
      ?: localizedString(ctx, R.string.rv_push_incoming_call, "Incoming call")
    val remaining = value?.optLong("expires_in_ms", 30000L) ?: 30000L
    val answer = "rocketvibe://voice-ring/" + Uri.encode(ring) + "?rid=" + Uri.encode(scope.optString("rid")) +
      "&host=" + Uri.encode(session.optString("baseUrl")) + "&nativeScope=" + Uri.encode(JSONObject()
        .put("instanceId", scope.optString("instanceId")).put("dataEpoch", scope.optString("dataEpoch")).put("userId", scope.optString("userId")).toString())
    val decline = PendingIntent.getBroadcast(ctx, ("voice-decline:" + ring).hashCode(),
      Intent(ctx, NativeVoiceReceiver::class.java).setAction("decline").putExtra("scope", scope.toString()),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    com.rocketvibe.voice.VoiceRinging.show(ctx, ring, caller.take(128), answer, decline, remaining)
  } catch (_: Exception) { debugLog(ctx, "native voice ring failed") }
}
/** "Decline" on the ringing call: stop ringing now, tell the server through WorkManager. */
class NativeVoiceReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    val raw = intent.getStringExtra("scope") ?: return
    val scope = try { JSONObject(raw) } catch (_: Exception) { return }
    com.rocketvibe.voice.VoiceRinging.cancel(ctx, scope.optString("ringId"))
    val work = OneTimeWorkRequest.Builder(NativeVoiceDeclineWorker::class.java).setInputData(Data.Builder().putString("scope", raw).build())
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST).build()
    WorkManager.getInstance(ctx).enqueueUniqueWork("native-voice-decline:" + scope.optString("ringId"), ExistingWorkPolicy.KEEP, work)
  }
}
class NativeVoiceDeclineWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
  override fun doWork(): Result {
    val scope = try { JSONObject(inputData.getString("scope") ?: return Result.failure()) } catch (_: Exception) { return Result.failure() }
    val session = readNativeSession(applicationContext, scope) ?: return Result.success()
    // A declined call stops mattering when its ring would have ended anyway.
    if (isStopped || runAttemptCount >= 3) return Result.success()
    val result = nativeHttp(session, "/api/v1/voice/rings/" + scope.optString("ringId") + "/decline", JSONObject())
    return if (result.code == 0 || result.code >= 500) Result.retry() else Result.success()
  }
}

private fun receiveNativePush(ctx: Context, extras: Bundle) {
  try {
    val scope = nativePushContext(extras) ?: return
    val session = readNativeSession(ctx, scope) ?: return
    val key = nativePushKey(scope)
    val data = Data.Builder().putString("scope", scope.toString()).build()
    val work = OneTimeWorkRequest.Builder(NativePushWorker::class.java)
      .setInputData(data).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
    WorkManager.getInstance(ctx).enqueueUniqueWork(key, ExistingWorkPolicy.KEEP, work)
    // Generic notification immediately; only authenticated workers obtain text.
    val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.activeNotifications.none { it.id == key.hashCode() } && !nativePushShown(ctx, key)) {
      val tap = Intent(Intent.ACTION_VIEW, Uri.parse(nativeLink(session, scope))).setPackage(ctx.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val pending = PendingIntent.getActivity(ctx, key.hashCode(), tap, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val text = localizedString(ctx, R.string.rv_push_new_message, "New message")
      NotificationManagerCompat.from(ctx).notify(key.hashCode(), NotificationCompat.Builder(ctx, "default")
        .setSmallIcon(android.R.drawable.ic_dialog_email).setContentTitle(text).setContentText(text)
        .setContentIntent(pending).setAutoCancel(true).build())
    }
  } catch (_: Exception) { debugLog(ctx, "native push scheduling failed") }
}
private fun nativePushShown(ctx: Context, key: String): Boolean {
  val whenPosted = ctx.getSharedPreferences(PREFS_SHOWN, Context.MODE_PRIVATE).getLong(key, 0L)
  return whenPosted != 0L && System.currentTimeMillis() - whenPosted <= SHOWN_RETENTION_MS
}

class NativePushWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
  override fun doWork(): Result {
    val scope = try { JSONObject(inputData.getString("scope") ?: return Result.failure()) } catch (_: Exception) { return Result.failure() }
    val key = nativePushKey(scope)
    val manager = NotificationManagerCompat.from(applicationContext)
    fun stop(): Result { manager.cancel(key.hashCode()); return Result.success() }
    val session = readNativeSession(applicationContext, scope) ?: return stop()
    if (isStopped || runAttemptCount >= 8) return stop()
    val server = checkNativeServer(session, scope)
    if (server == 409) return stop()
    if (server != 200) return Result.retry()
    val result = nativeHttp(session, "/api/v1/push/notifications/" + scope.optString("notificationId"))
    if (result.code in arrayOf(400, 401, 403, 404, 409)) return stop()
    val value = result.body ?: return Result.retry()
    val message = value.optJSONObject("message") ?: return stop()
    val room = value.optJSONObject("room") ?: return stop()
    if (value.optString("instance_id") != scope.optString("instanceId") || value.optString("data_epoch") != scope.optString("dataEpoch") ||
        value.optString("device_id") != scope.optString("deviceId") || value.optString("notification_id") != scope.optString("notificationId") ||
        room.optString("id") != scope.optString("rid") || message.optString("id") != scope.optString("messageId") ||
        message.optString("room_id") != scope.optString("rid") || message.optBoolean("deleted") || !message.isNull("system")) return stop()
    if (isStopped || readNativeSession(applicationContext, scope) == null) return stop()
    manager.cancel(key.hashCode())
    if (alreadyShown(applicationContext, key)) return Result.success()
    val author = message.optJSONObject("author") ?: return stop()
    val text = message.optString("text").ifEmpty {
      val file = message.optJSONArray("files")?.optJSONObject(0)
      file?.optString("filename")?.takeIf { it.isNotEmpty() && it != "null" } ?: message.optJSONArray("cards")?.optJSONObject(0)?.optString("title")?.takeIf { it.isNotEmpty() && it != "null" }
        ?: localizedString(applicationContext, R.string.rv_push_new_message, "New message")
    }.take(1024)
    val payload = JSONObject().put("sender", JSONObject().put("name", author.optString("display_name")).put("username", author.optString("username")))
      .put("type", if (room.optString("kind") == "direct") "d" else "c").put("nativeScope", scope)
    message.optString("reply_to").takeIf { it.isNotEmpty() && it != "null" }?.let { payload.put("tmid", it); scope.put("tmid", it) }
    showRoomNotification(applicationContext, scope.optString("rid"), room.optString("name"), text, payload, session.optString("baseUrl"), silent = true)
    return Result.success()
  }
}

// RemoteInput uses the normal native idempotent send. WorkManager stores an
// operation reference; the bounded local draft has no bearer / FCM credential.
private fun scheduleNativeReply(ctx: Context, scope: JSONObject, text: String): Boolean {
  // WorkManager Data is capped at 10 KiB; this path reserves 4 KiB for the reply.
  // Its operation ID and exact input commit together before acknowledging input.
  if (text.isEmpty() || text.toByteArray(Charsets.UTF_8).size > 4096 || readNativeSession(ctx, scope) == null) return false
  val operation = java.util.UUID.randomUUID().toString()
  val work = OneTimeWorkRequest.Builder(NativeReplyWorker::class.java).setInputData(Data.Builder()
    .putString("operation", operation).putString("scope", scope.toString()).putString("text", text).putLong("created", System.currentTimeMillis()).build())
    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
  WorkManager.getInstance(ctx).enqueueUniqueWork("native-reply:" + operation, ExistingWorkPolicy.KEEP, work).result.get(3, TimeUnit.SECONDS)
  return true
}
class NativeReplyWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
  override fun doWork(): Result {
    val operation = inputData.getString("operation") ?: return Result.failure()
    val scope = try { JSONObject(inputData.getString("scope") ?: return Result.failure()) } catch (_: Exception) { return Result.failure() }
    val text = inputData.getString("text") ?: return Result.failure()
    val session = readNativeSession(applicationContext, scope)
    fun finish(sent: Boolean): Result {
      if (session != null && readNativeSession(applicationContext, scope) != null) {
        repostAfterReply(applicationContext, scope.optString("rid"), session.optString("baseUrl"), scope.optString("tmid").ifEmpty { null }, text, sent, scope)
      }
      return Result.success()
    }
    if (session == null || isStopped) return finish(false)
    if (runAttemptCount >= 8 || System.currentTimeMillis() - inputData.getLong("created", 0L) > 86400000L) return finish(false)
    val server = checkNativeServer(session, scope)
    if (server == 409) return finish(false)
    if (server != 200) return Result.retry()
    val body = JSONObject().put("operation_id", operation).put("text", text)
    scope.optString("tmid").takeIf { it.isNotEmpty() }?.let { body.put("reply_to", it) }
    val result = nativeHttp(session, "/api/v1/rooms/" + scope.optString("rid") + "/messages", body)
    if (result.code == 200 && result.body?.optString("id") == operation && result.body.optString("room_id") == scope.optString("rid")) return finish(true)
    if (result.code in arrayOf(400, 401, 403, 404, 409, 413, 422)) return finish(false)
    return Result.retry()
  }
}
`;
};
