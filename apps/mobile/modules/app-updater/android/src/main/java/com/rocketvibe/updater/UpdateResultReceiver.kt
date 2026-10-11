package com.rocketvibe.updater

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Bundle

internal object UpdatePrompt {
  @Volatile var foreground = false
  @Volatile var confirmation: Intent? = null
  private const val NOTIFICATION = 726410
  fun clear(context: Context) {
    confirmation = null
    context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION)
  }
  fun show(context: Context, intent: Intent) {
    confirmation = intent
    val launch = Intent(context, UpdateConfirmationActivity::class.java).putExtra(Intent.EXTRA_INTENT, intent)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val pending = PendingIntent.getActivity(context, NOTIFICATION, launch, flags)
    val manager = context.getSystemService(NotificationManager::class.java)
    val builder = if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel("rv-updates", context.getString(R.string.rv_update_channel), NotificationManager.IMPORTANCE_DEFAULT))
      Notification.Builder(context, "rv-updates")
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context)
    }
    runCatching { manager.notify(NOTIFICATION, builder.setSmallIcon(android.R.drawable.stat_sys_download_done)
      .setContentTitle(context.getString(R.string.rv_update_title))
      .setContentText(context.getString(R.string.rv_update_confirmation)).setContentIntent(pending).setAutoCancel(true).build()) }
    if (foreground) runCatching { context.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
  }
}

/** Explicit, non-exported receiver, backed by the OS-held session PendingIntent. */
class UpdateResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != "${context.packageName}.APP_UPDATE_RESULT") return
    val prefs = UpdateFiles.prefs(context)
    val id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
    if (id < 0 || id != prefs.getInt("session", -2)) return
    when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        @Suppress("DEPRECATION")
        val confirmation = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        if (confirmation == null) { UpdateFiles.status(context, "failed", "interrupted"); return }
        UpdateFiles.status(context, "confirmation")
        UpdatePrompt.show(context, confirmation)
      }
      PackageInstaller.STATUS_SUCCESS -> {
        UpdateFiles.clear(context)
        UpdateFiles.status(context, "updated")
      }
      else -> {
        runCatching { context.packageManager.packageInstaller.abandonSession(id) }
        prefs.edit().remove("session").commit()
        UpdatePrompt.clear(context)
        val error = when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
          PackageInstaller.STATUS_FAILURE_ABORTED -> "cancelled"
          PackageInstaller.STATUS_FAILURE_STORAGE -> "storage"
          PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "device"
          PackageInstaller.STATUS_FAILURE_BLOCKED -> "blocked"
          PackageInstaller.STATUS_FAILURE_INVALID -> "integrity"
          else -> "install"
        }
        UpdateFiles.status(context, "failed", error)
      }
    }
  }
}

/** Notification fallback works even if the React/Expo process was killed. */
class UpdateConfirmationActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    @Suppress("DEPRECATION")
    val confirmation = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
    if (savedInstanceState == null && confirmation != null) runCatching { startActivity(confirmation) }
    finish()
  }
}
