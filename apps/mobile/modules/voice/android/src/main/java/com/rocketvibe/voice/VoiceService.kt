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
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the process, the microphone and the call alive with the app in the
 * background (a microphone foreground service), behind an ongoing call
 * notification: mute and leave without opening the app.
 */
class VoiceService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    VoiceEngine.attach(this)
    when (intent?.action) {
      ACTION_MUTE -> VoiceEngine.setMicrophone(!VoiceEngine.microphone || VoiceEngine.deafened)
      ACTION_LEAVE -> VoiceEngine.leave()
    }
    if (VoiceEngine.roomId == null) {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    // A microphone service needs the permission; without it the call only listens.
    val type = if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    ServiceCompat.startForeground(this, NOTIFICATION, notification(this), type)
    return START_NOT_STICKY
  }

  companion object {
    private const val CHANNEL = "voice"
    private const val NOTIFICATION = 0x766f6963
    private const val ACTION_MUTE = "com.rocketvibe.voice.MUTE"
    private const val ACTION_LEAVE = "com.rocketvibe.voice.LEAVE"
    private var running = false

    fun start(context: Context) {
      running = true
      ContextCompat.startForegroundService(context, Intent(context, VoiceService::class.java))
    }
    /** Mute state and title moved: redraw the notification. */
    fun refresh(context: Context) {
      if (running) context.getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION, notification(context))
    }
    fun stop(context: Context) {
      if (!running) return
      running = false
      context.stopService(Intent(context, VoiceService::class.java))
    }

    private fun action(context: Context, action: String) = PendingIntent.getService(
      context, action.hashCode(), Intent(context, VoiceService::class.java).setAction(action),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun notification(context: Context): android.app.Notification {
      val manager = context.getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager?.getNotificationChannel(CHANNEL) == null) {
        manager?.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.voice_channel), NotificationManager.IMPORTANCE_LOW))
      }
      val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
      val open = VoiceEngine.link?.let { link ->
        PendingIntent.getActivity(
          context, 0, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
      }
      val muted = !VoiceEngine.microphone || VoiceEngine.deafened
      val caller = Person.Builder().setName(VoiceEngine.title).setImportant(true).build()
      return NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(if (icon != 0) icon else android.R.drawable.ic_btn_speak_now)
        .setContentTitle(VoiceEngine.title)
        .setContentText(context.getString(if (muted) R.string.voice_muted else R.string.voice_connected))
        .setStyle(NotificationCompat.CallStyle.forOngoingCall(caller, action(context, ACTION_LEAVE)))
        .addAction(0, context.getString(if (muted) R.string.voice_unmute else R.string.voice_mute), action(context, ACTION_MUTE))
        .setContentIntent(open)
        .setOngoing(true)
        .setSilent(true)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .build()
    }
  }
}
