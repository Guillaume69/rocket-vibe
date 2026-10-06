package com.rocketvibe.voice

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import java.lang.ref.WeakReference

/**
 * An incoming direct call (docs/protocol/VOICE.md): a ringing call
 * notification that opens [IncomingCallActivity] over the lock screen. The
 * app's push service builds the links (it alone reads the session) and calls in.
 */
object VoiceRinging {
  private const val CHANNEL = "voice_calls"
  internal const val EXTRA_RING = "ring"
  internal const val EXTRA_CALLER = "caller"
  internal const val EXTRA_ANSWER = "answer"
  internal const val EXTRA_DECLINE = "decline"
  private var screen: WeakReference<Activity>? = null
  private var showing: String? = null

  private fun id(ring: String) = ("voice-ring:" + ring).hashCode()

  private fun channel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL) != null) return
    val ringtone = Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + context.packageName + "/" + R.raw.ringtone)
    manager.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.voice_calls), NotificationManager.IMPORTANCE_HIGH).apply {
      setSound(ringtone, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
      enableVibration(true)
      vibrationPattern = longArrayOf(0, 600, 400, 600, 1200)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    })
  }

  /** Rings until answered, declined, [timeoutMs] elapses or [cancel]. */
  @JvmStatic
  fun show(context: Context, ring: String, caller: String, answer: String, decline: PendingIntent, timeoutMs: Long) {
    channel(context)
    showing = ring
    val full = Intent(context, IncomingCallActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
      .putExtra(EXTRA_RING, ring).putExtra(EXTRA_CALLER, caller).putExtra(EXTRA_ANSWER, answer).putExtra(EXTRA_DECLINE, decline)
    val fullScreen = PendingIntent.getActivity(context, id(ring), full, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val accept = PendingIntent.getActivity(
      context, id(ring) + 1,
      Intent(Intent.ACTION_VIEW, Uri.parse(answer)).setPackage(context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    val person = Person.Builder().setName(caller).setImportant(true).build()
    val notification = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(if (icon != 0) icon else android.R.drawable.sym_call_incoming)
      .setContentTitle(caller)
      .setContentText(context.getString(R.string.voice_incoming))
      .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, accept))
      .setFullScreenIntent(fullScreen, true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setTimeoutAfter(timeoutMs.coerceIn(1000, 45000))
      .build()
    // The sound repeats until the notification goes, like a phone call.
    notification.flags = notification.flags or Notification.FLAG_INSISTENT
    try {
      NotificationManagerCompat.from(context).notify(id(ring), notification)
    } catch (_: SecurityException) {
      // Notifications refused: the app rings it when opened.
    }
  }

  /** The ring ended elsewhere (answered on another device, cancelled, declined). */
  @JvmStatic
  fun cancel(context: Context, ring: String) {
    NotificationManagerCompat.from(context).cancel(id(ring))
    if (showing == ring) {
      showing = null
      screen?.get()?.finish()
      screen = null
    }
  }

  internal fun attach(activity: Activity) { screen = WeakReference(activity) }
}
