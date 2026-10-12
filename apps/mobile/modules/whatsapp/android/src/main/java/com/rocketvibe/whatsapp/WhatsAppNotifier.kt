package com.rocketvibe.whatsapp

import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** WhatsApp's new messages as notifications, posted here from the engine's
 * frames: the JS side may not run (the background service keeps only the
 * engines). One conversation notification per chat, as the push ones are,
 * with Reply and Mark as read; it goes when the chat is read anywhere. What
 * a replay brings back is never notified, nor anything while the app is in
 * front, where the account's own screens show it. */
internal object WhatsAppNotifier {
  const val CHANNEL = "whatsapp_messages"
  const val ACTION_REPLY = "com.rocketvibe.whatsapp.REPLY"
  const val ACTION_READ = "com.rocketvibe.whatsapp.READ"
  const val EXTRA_STATE = "state"
  const val EXTRA_CHAT = "chat"
  const val REPLY_KEY = "whatsapp_reply"
  private const val ACCENT = 0xFFFF5FA2.toInt()
  /** History older than this is never a new message (a long-offline link catching up). */
  private const val RECENT_MS = 24 * 60 * 60 * 1000L
  private const val SEEN_KEPT = 5000

  private class Account {
    /** Until the engine's first `replayed`, and between `reload` and `replayed`. */
    @Volatile var replaying = true
    val names = ConcurrentHashMap<String, String>()
    val seen = object : LinkedHashMap<String, Unit>() {
      override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Unit>?) = size > SEEN_KEPT
    }
  }

  private val accounts = ConcurrentHashMap<String, Account>()

  /** Whether a screen of the app is in front; replaced by tests. */
  @Volatile internal var inFront: (Context) -> Boolean = { context ->
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  /** A chat's notification id, apart per account (the same JID exists in several). */
  fun id(state: String, chat: String): Int = "whatsapp:$state:$chat".hashCode()

  /** A new engine starts replaying its cache. */
  fun opened(state: String) {
    accounts[state] = Account()
  }

  fun frame(context: Context, state: String, json: String) {
    val account = accounts.getOrPut(state) { Account() }
    val frame = try { JSONObject(json) } catch (e: Exception) { return }
    when (frame.optString("type")) {
      "reload" -> account.replaying = true
      "replayed" -> account.replaying = false
      "names" -> frame.optJSONObject("names")?.let { names ->
        names.keys().forEach { jid -> names.optString(jid).takeIf { it.isNotEmpty() }?.let { account.names[jid] = it } }
      }
      "chat" -> if (frame.optInt("unread") == 0) {
        NotificationManagerCompat.from(context).cancel(id(state, frame.optString("jid")))
      }
      "message" -> frame.optJSONObject("message")?.let { message(context, state, account, it) }
    }
  }

  private fun message(context: Context, state: String, account: Account, m: JSONObject) {
    val id = m.optString("id")
    val fresh = synchronized(account.seen) { account.seen.put(id, Unit) == null }
    if (!fresh || account.replaying || m.optBoolean("mine") || m.optBoolean("deleted")) return
    if (m.optLong("ts") < System.currentTimeMillis() - RECENT_MS || inFront(context)) return
    val chat = m.optString("chat")
    val sender = m.optString("sender")
    val name = account.names[sender] ?: m.optString("author").ifEmpty { fallbackName(sender) }
    val group = chat.endsWith("@g.us")
    post(context, state, chat, if (group) account.names[chat] ?: chat.substringBefore('@') else null, name, words(context, m))
  }

  fun fallbackName(jid: String): String {
    val user = jid.substringBefore('@')
    return if (jid.endsWith("@s.whatsapp.net")) "+$user" else user
  }

  /** An attachment's label then its caption, or the text. */
  private fun words(context: Context, m: JSONObject): String {
    val kind = m.optString("kind")
    val text = m.optString("text")
    if (kind.isEmpty()) return text
    val label = when (kind) {
      "image" -> R.string.rv_wa_kind_image
      "gif" -> R.string.rv_wa_kind_gif
      "video" -> R.string.rv_wa_kind_video
      "audio" -> R.string.rv_wa_kind_audio
      "voice" -> R.string.rv_wa_kind_voice
      "sticker" -> R.string.rv_wa_kind_sticker
      else -> R.string.rv_wa_kind_document
    }.let { context.getString(it) }
    return if (text.isEmpty()) label else "$label · $text"
  }

  private fun channel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL) != null) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL, context.getString(R.string.rv_wa_channel_messages), NotificationManager.IMPORTANCE_HIGH)
    )
  }

  /** Adds a message to the chat's conversation notification (`title` for a group; null for a person). */
  fun post(context: Context, state: String, chat: String, title: String?, sender: String?, text: String, silent: Boolean = false) {
    channel(context)
    val notificationId = id(state, chat)
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val style = manager.activeNotifications.firstOrNull { it.id == notificationId }?.let {
      NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it.notification)
    } ?: NotificationCompat.MessagingStyle(Person.Builder().setName(context.getString(R.string.rv_wa_me)).build())
    if (title != null) {
      style.conversationTitle = title
      style.isGroupConversation = true
    }
    // A null sender is me: the style's own person (a reply from the notification).
    style.addMessage(text, System.currentTimeMillis(), sender?.let { Person.Builder().setName(it).build() })
    // The account's room, through the app's multi-account deep link.
    val link = Uri.parse("rocketvibe://room/" + Uri.encode(chat) + "?host=" + Uri.encode(state))
    val tap = PendingIntent.getActivity(
      context, notificationId,
      Intent(Intent.ACTION_VIEW, link).setPackage(context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    val builder = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(if (icon != 0) icon else android.R.drawable.ic_dialog_email)
      .setColor(ACCENT)
      .setStyle(style)
      .setContentIntent(tap)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setSilent(silent)
      .addAction(replyAction(context, state, chat, notificationId))
      .addAction(readAction(context, state, chat, notificationId))
    try {
      NotificationManagerCompat.from(context).notify(notificationId, builder.build())
    } catch (e: SecurityException) {
      // Notifications refused by the user: nothing to post.
    }
  }

  private fun actionIntent(context: Context, action: String, state: String, chat: String) =
    Intent(context, WhatsAppActionReceiver::class.java).setAction(action)
      .putExtra(EXTRA_STATE, state).putExtra(EXTRA_CHAT, chat)

  private fun replyAction(context: Context, state: String, chat: String, code: Int): NotificationCompat.Action {
    val label = context.getString(R.string.rv_wa_reply)
    // Mutable: the system puts the typed text in it. Explicit, so no other app takes it.
    val pending = PendingIntent.getBroadcast(context, code, actionIntent(context, ACTION_REPLY, state, chat),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
    return NotificationCompat.Action.Builder(0, label, pending)
      .addRemoteInput(RemoteInput.Builder(REPLY_KEY).setLabel(label).build())
      .setAllowGeneratedReplies(true)
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
      .setShowsUserInterface(false)
      .build()
  }

  private fun readAction(context: Context, state: String, chat: String, code: Int): NotificationCompat.Action {
    val pending = PendingIntent.getBroadcast(context, code + 1, actionIntent(context, ACTION_READ, state, chat),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    return NotificationCompat.Action.Builder(0, context.getString(R.string.rv_wa_mark_read), pending)
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
      .setShowsUserInterface(false)
      .build()
  }
}
