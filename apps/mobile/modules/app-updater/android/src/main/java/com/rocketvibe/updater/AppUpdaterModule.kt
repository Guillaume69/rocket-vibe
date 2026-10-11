package com.rocketvibe.updater

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues
import java.io.File
import java.io.FileOutputStream
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipFile
import javax.net.ssl.HttpsURLConnection

/** Private staging and durable installer state; neither depends on JS staying alive. */
internal object UpdateFiles {
  fun prefs(context: Context) = context.getSharedPreferences("rv-app-updater", Context.MODE_PRIVATE)
  fun directory(context: Context) = File(context.filesDir, "app-updater").apply { mkdirs() }
  fun apk(context: Context) = File(directory(context), "update.apk")
  fun status(context: Context, state: String, error: String? = null): Boolean {
    return prefs(context).edit().putString("status", state).putString("error", error).commit()
  }
  @Suppress("DEPRECATION")
  fun code(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
  @Suppress("DEPRECATION")
  fun flags(): Int = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
  @Suppress("DEPRECATION")
  fun signers(info: PackageInfo): Set<String> {
    val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
    return signatures?.map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }?.toSet() ?: emptySet()
  }
  fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
  fun canInstall(context: Context) = Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()
  @Suppress("DEPRECATION")
  fun installed(context: Context) = context.packageManager.getPackageInfo(context.packageName, flags())
  fun clear(context: Context) {
    apk(context).delete()
    File(directory(context), "update.part").delete()
    prefs(context).edit().remove("session").remove("target").remove("code").remove("digest").remove("size").commit()
    UpdatePrompt.clear(context)
  }
  fun reconcile(context: Context) {
    val prefs = prefs(context)
    if (prefs.contains("code") && code(installed(context)) >= prefs.getLong("code", Long.MAX_VALUE)) {
      clear(context)
      status(context, "updated")
      return
    }
    val session = prefs.getInt("session", -1)
    if (session >= 0 && context.packageManager.packageInstaller.getSessionInfo(session) == null) {
      prefs.edit().remove("session").commit()
      status(context, "failed", "interrupted")
    }
    if (prefs.getString("status", "idle") == "ready" && !apk(context).isFile) status(context, "failed", "interrupted")
  }
}

class AppUpdaterModule : Module() {
  private val executor = Executors.newSingleThreadExecutor()
  private val busy = AtomicBoolean(false)
  private val cancelled = AtomicBoolean(false)
  @Volatile private var connection: HttpsURLConnection? = null

  private fun context(): Context = appContext.reactContext?.applicationContext ?: throw UpdateFailure("unavailable")
  private fun work(promise: Promise, action: () -> Unit) {
    if (!busy.compareAndSet(false, true)) { promise.reject("busy", "busy", null); return }
    cancelled.set(false)
    executor.execute {
      try { action(); promise.resolve(null) }
      catch (error: Exception) {
        val code = if (cancelled.get()) "cancelled" else (error as? UpdateFailure)?.reason ?: "network"
        promise.reject(code, code, error)
      } finally { connection?.disconnect(); connection = null; busy.set(false) }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("AppUpdater")
    Events("progress")
    OnActivityEntersForeground { UpdatePrompt.foreground = true }
    OnActivityEntersBackground { UpdatePrompt.foreground = false }
    OnDestroy { cancelled.set(true); connection?.disconnect(); executor.shutdown() }
    AsyncFunction("info") {
      val context = context()
      UpdateFiles.reconcile(context)
      if (!busy.get()) File(UpdateFiles.directory(context), "update.part").delete()
      val installed = UpdateFiles.installed(context)
      val prefs = UpdateFiles.prefs(context)
      mapOf("version" to installed.versionName, "versionCode" to UpdateFiles.code(installed).toDouble(),
        "abis" to Build.SUPPORTED_ABIS.toList(), "canInstall" to UpdateFiles.canInstall(context),
        "status" to prefs.getString("status", "idle"), "target" to prefs.getString("target", null),
        "error" to prefs.getString("error", null))
    }
    AsyncFunction("download") { version: String, url: String, size: Double, digest: String, promise: Promise ->
      val context = context()
      work(promise) { download(context, version, url, size, digest) }
    }
    Function("cancelDownload") { cancelled.set(true); connection?.disconnect() }
    AsyncFunction("install") { promise: Promise ->
      val context = context()
      UpdatePrompt.foreground = appContext.currentActivity?.hasWindowFocus() == true
      if (!UpdatePrompt.foreground) throw UpdateFailure("foreground")
      work(promise) { install(context) }
    }
    AsyncFunction("cancelInstall") {
      if (busy.get()) throw UpdateFailure("busy")
      val context = context()
      val prefs = UpdateFiles.prefs(context)
      val id = prefs.getInt("session", -1)
      if (id >= 0 && context.packageManager.packageInstaller.getSessionInfo(id) != null) {
        context.packageManager.packageInstaller.abandonSession(id)
      }
      prefs.edit().remove("session").commit()
      UpdatePrompt.clear(context)
      UpdateFiles.status(context, if (UpdateFiles.apk(context).isFile) "ready" else "idle")
    }
    AsyncFunction("resumeInstall") {
      val activity = appContext.currentActivity ?: throw UpdateFailure("foreground")
      val confirmation = UpdatePrompt.confirmation ?: throw UpdateFailure("interrupted")
      activity.startActivity(Intent(activity, UpdateConfirmationActivity::class.java).putExtra(Intent.EXTRA_INTENT, confirmation))
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("openInstallSettings") {
      val activity = appContext.currentActivity ?: throw UpdateFailure("foreground")
      if (Build.VERSION.SDK_INT >= 26) activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${activity.packageName}")))
    }.runOnQueue(Queues.MAIN)
  }

  private fun checkCancelled(deadline: Long = Long.MAX_VALUE) {
    if (cancelled.get()) throw UpdateFailure("cancelled")
    if (System.nanoTime() > deadline) throw UpdateFailure("network")
  }

  private fun connect(url: String): HttpsURLConnection {
    var next = URL(url)
    repeat(6) {
      checkCancelled()
      if (next.protocol != "https" || next.userInfo != null || (next.port != -1 && next.port != 443) || (next.host != "github.com" && !next.host.endsWith(".githubusercontent.com"))) throw UpdateFailure("asset")
      val current = next.openConnection() as HttpsURLConnection
      connection = current
      current.instanceFollowRedirects = false
      current.connectTimeout = 15000
      current.readTimeout = 15000
      current.setRequestProperty("User-Agent", "RocketVibe-Android-Updater")
      current.setRequestProperty("Accept-Encoding", "identity")
      val status = current.responseCode
      if (status in listOf(301, 302, 303, 307, 308)) {
        val location = current.getHeaderField("Location") ?: throw UpdateFailure("network")
        next = URL(next, location)
        current.disconnect()
      } else {
        if (status != 200) throw UpdateFailure("network")
        return current
      }
    }
    throw UpdateFailure("network")
  }

  private fun download(context: Context, version: String, url: String, size: Double, digest: String) {
    if (!Regex("[0-9]+\\.[0-9]+\\.[0-9]+").matches(version) ||
      url != "https://github.com/Guillaume69/rocket-vibe/releases/download/mobile-v$version/rocket-vibe-mobile-$version.apk" ||
      !Regex("[a-f0-9]{64}").matches(digest) || !size.isFinite() || size % 1.0 != 0.0 || size <= 0 || size > 512 * 1024 * 1024) throw UpdateFailure("asset")
    val prefs = UpdateFiles.prefs(context)
    if (prefs.contains("session")) throw UpdateFailure("busy")
    UpdateFiles.clear(context)
    UpdateFiles.status(context, "idle")
    val directory = UpdateFiles.directory(context)
    val expected = size.toLong()
    if (directory.usableSpace < expected * 2 + 16 * 1024 * 1024) throw UpdateFailure("storage")
    val part = File(directory, "update.part")
    try {
      val response = connect(url)
      val length = response.getHeaderFieldLong("Content-Length", -1)
      if (length >= 0 && length != expected) throw UpdateFailure("integrity")
      val deadline = System.nanoTime() + 15L * 60 * 1000000000L
      var lastEvent = 0L
      response.inputStream.use { input ->
        FileOutputStream(part).use { output ->
          VerifiedDownload.copy(input, output, expected, digest, { checkCancelled(deadline) }) { received ->
            val now = System.nanoTime()
            if (now - lastEvent > 250000000L) {
              sendEvent("progress", mapOf("downloaded" to received.toDouble(), "total" to size))
              lastEvent = now
            }
          }
          output.fd.sync()
        }
      }
      val info = inspect(context, part, version)
      if (!part.renameTo(UpdateFiles.apk(context))) throw UpdateFailure("storage")
      if (!prefs.edit().putString("target", version).putLong("code", UpdateFiles.code(info))
        .putString("digest", digest).putLong("size", expected).commit()) throw UpdateFailure("storage")
      if (!UpdateFiles.status(context, "ready")) throw UpdateFailure("storage")
      sendEvent("progress", mapOf("downloaded" to size, "total" to size))
    } catch (error: Exception) {
      UpdateFiles.clear(context)
      UpdateFiles.status(context, "idle")
      throw error
    } finally { part.delete() }
  }

  @Suppress("DEPRECATION")
  private fun inspect(context: Context, file: File, version: String): PackageInfo {
    val pm = context.packageManager
    val candidate = pm.getPackageArchiveInfo(file.absolutePath, UpdateFiles.flags()) ?: throw UpdateFailure("package")
    val installed = UpdateFiles.installed(context)
    if (candidate.packageName != context.packageName || candidate.versionName != version) throw UpdateFailure("package")
    if (UpdateFiles.code(candidate) <= UpdateFiles.code(installed)) throw UpdateFailure("version")
    val signers = UpdateFiles.signers(candidate)
    if (signers.isEmpty() || signers != UpdateFiles.signers(installed)) throw UpdateFailure("signature")
    if ((candidate.applicationInfo?.minSdkVersion ?: Int.MAX_VALUE) > Build.VERSION.SDK_INT) throw UpdateFailure("device")
    val abis = ZipFile(file).use { zip -> zip.entries().asSequence().map { it.name }
      .filter { it.startsWith("lib/") && it.endsWith(".so") }.map { it.split('/')[1] }.toSet() }
    if (abis.isNotEmpty() && Build.SUPPORTED_ABIS.none { it in abis }) throw UpdateFailure("device")
    return candidate
  }

  private fun install(context: Context) {
    if (!UpdateFiles.canInstall(context)) throw UpdateFailure("permission")
    if (!UpdatePrompt.foreground) throw UpdateFailure("foreground")
    val prefs = UpdateFiles.prefs(context)
    if (prefs.contains("session")) throw UpdateFailure("busy")
    val version = prefs.getString("target", null) ?: throw UpdateFailure("interrupted")
    val apk = UpdateFiles.apk(context)
    if (!apk.isFile || apk.length() != prefs.getLong("size", -1)) throw UpdateFailure("integrity")
    apk.inputStream().use { input ->
      VerifiedDownload.copy(input, null, prefs.getLong("size", -1), prefs.getString("digest", "") ?: "", { checkCancelled() })
    }
    inspect(context, apk, version)
    val installer = context.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
      setAppPackageName(context.packageName)
      setSize(apk.length())
      if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
      if (Build.VERSION.SDK_INT >= 33) setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
    }
    val id = installer.createSession(params)
    try {
      if (!prefs.edit().putInt("session", id).putString("status", "installing").remove("error").commit()) throw UpdateFailure("storage")
      installer.openSession(id).use { session ->
        session.openWrite("base.apk", 0, apk.length()).use { output ->
          apk.inputStream().use { it.copyTo(output) }
          session.fsync(output)
        }
        if (!UpdatePrompt.foreground) throw UpdateFailure("foreground")
        if (context.getSystemService(AudioManager::class.java).mode != AudioManager.MODE_NORMAL) throw UpdateFailure("voice")
        // The result receiver must be mutable: Android fills in result extras.
        val result = Intent(context, UpdateResultReceiver::class.java).setAction("${context.packageName}.APP_UPDATE_RESULT")
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        val pending = PendingIntent.getBroadcast(context, id, result, flags)
        session.commit(pending.intentSender)
      }
    } catch (error: Exception) {
      runCatching { installer.abandonSession(id) }
      prefs.edit().remove("session").commit()
      UpdateFiles.status(context, "ready")
      throw error
    }
  }
}
