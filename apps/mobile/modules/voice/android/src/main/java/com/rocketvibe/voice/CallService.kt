package com.rocketvibe.voice

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps a call held by a web page (Jitsi, kMeet) alive with the app in the
 * background or the screen locked: without a microphone foreground service
 * Android silences the page's capture and freezes the process, which drops the
 * conference. Its ongoing call notification hangs up without opening the app.
 */
class CallService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_HANG_UP) {
      title = null
      listeners.forEach { it() }
    }
    val current = title
    if (current == null) {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    fun granted(permission: String) = ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
    var type = if (granted(Manifest.permission.RECORD_AUDIO)) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      else ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    if (granted(Manifest.permission.CAMERA)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
    ServiceCompat.startForeground(this, NOTIFICATION, notification(this, current), type)
    return START_NOT_STICKY
  }

  companion object {
    private const val CHANNEL = "voice"
    private const val NOTIFICATION = 0x63616c6c
    private const val ACTION_HANG_UP = "com.rocketvibe.voice.HANG_UP"
    @Volatile private var title: String? = null
    private val listeners = mutableListOf<() -> Unit>()

    fun hold(context: Context, name: String) {
      title = name
      ContextCompat.startForegroundService(context, Intent(context, CallService::class.java))
    }
    fun release(context: Context) {
      if (title == null) return
      title = null
      context.stopService(Intent(context, CallService::class.java))
    }
    fun listen(listener: () -> Unit) { listeners.add(listener) }
    fun unlisten(listener: () -> Unit) { listeners.remove(listener) }

    private fun notification(context: Context, name: String): android.app.Notification {
      val manager = context.getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager?.getNotificationChannel(CHANNEL) == null) {
        manager?.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.voice_channel), NotificationManager.IMPORTANCE_LOW))
      }
      val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { launch ->
        PendingIntent.getActivity(
          context, NOTIFICATION, launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED),
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
      }
      val hangUp = PendingIntent.getService(
        context, ACTION_HANG_UP.hashCode(), Intent(context, CallService::class.java).setAction(ACTION_HANG_UP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      val caller = Person.Builder().setName(name).setImportant(true).build()
      return NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(if (icon != 0) icon else android.R.drawable.ic_btn_speak_now)
        .setContentTitle(name)
        .setContentText(context.getString(R.string.call_ongoing))
        .setStyle(NotificationCompat.CallStyle.forOngoingCall(caller, hangUp))
        .setContentIntent(open)
        .setOngoing(true)
        .setSilent(true)
        .setUsesChronometer(true)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .build()
    }
  }
}
