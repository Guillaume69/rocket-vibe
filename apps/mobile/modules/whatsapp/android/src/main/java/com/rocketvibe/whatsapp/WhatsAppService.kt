package com.rocketvibe.whatsapp

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/** Background reception, opted into per account: WhatsApp sends a linked
 * device no push, so only a live connection brings its messages. This
 * foreground service keeps the chosen accounts' engines connected with the
 * app closed, under a quiet notification whose Stop turns it off. */
class WhatsAppService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      WhatsAppBackground.disableAll(this)
      stopSelf()
      return START_NOT_STICKY
    }
    val states = WhatsAppBackground.enabled(this)
    if (states.isEmpty()) {
      stopSelf()
      return START_NOT_STICKY
    }
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type())
    for (state in states) {
      try {
        WhatsAppEngines.start(this, state)
      } catch (e: Exception) {
        // A state that cannot open stays off; the others run.
      }
    }
    return START_STICKY
  }

  private fun type(): Int = when {
    Build.VERSION.SDK_INT >= 34 -> ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
    else -> 0
  }

  private fun notification(): android.app.Notification {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL) == null) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL, getString(R.string.rv_wa_channel_service), NotificationManager.IMPORTANCE_LOW)
        )
      }
    }
    val stop = PendingIntent.getService(this, 1, Intent(this, WhatsAppService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val icon = resources.getIdentifier("notification_icon", "drawable", packageName)
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(if (icon != 0) icon else android.R.drawable.stat_notify_sync)
      .setContentTitle(getString(R.string.rv_wa_service_title))
      .setContentText(getString(R.string.rv_wa_service_text))
      .setOngoing(true)
      .setSilent(true)
      .setContentIntent(open)
      .addAction(0, getString(R.string.rv_wa_service_stop), stop)
      .build()
  }

  companion object {
    private const val CHANNEL = "whatsapp_background"
    private const val NOTIFICATION_ID = 0x5741
    const val ACTION_STOP = "com.rocketvibe.whatsapp.STOP"

    /** Starts or stops the service after the chosen accounts changed. */
    fun update(context: Context) {
      val intent = Intent(context, WhatsAppService::class.java)
      if (WhatsAppBackground.enabled(context).isEmpty()) context.stopService(intent)
      else ContextCompat.startForegroundService(context, intent)
    }
  }
}

/** The accounts that receive in the background, kept across restarts. */
object WhatsAppBackground {
  private const val PREFERENCES = "rocketvibe.whatsapp"
  private const val KEY = "background"

  private fun preferences(context: Context) = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  fun enabled(context: Context): Set<String> = preferences(context).getStringSet(KEY, emptySet())!!.toSet()

  fun set(context: Context, state: String, on: Boolean) {
    val now = enabled(context).toMutableSet().apply { if (on) add(state) else remove(state) }
    preferences(context).edit().putStringSet(KEY, now).apply()
    WhatsAppService.update(context)
  }

  fun disableAll(context: Context) {
    preferences(context).edit().putStringSet(KEY, emptySet()).apply()
  }
}

/** After a restart, the background reception the user chose comes back. */
class WhatsAppBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    if (WhatsAppBackground.enabled(context).isNotEmpty()) {
      runCatching { WhatsAppService.update(context) }
    }
  }
}
