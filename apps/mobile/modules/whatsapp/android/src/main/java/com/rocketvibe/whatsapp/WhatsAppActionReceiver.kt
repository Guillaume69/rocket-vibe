package com.rocketvibe.whatsapp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import org.json.JSONObject
import java.security.SecureRandom
import kotlin.concurrent.thread

/** Reply and Mark as read from a WhatsApp notification, answered by the
 * engine itself: started (and connected) here when the process had none. */
class WhatsAppActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val state = intent.getStringExtra(WhatsAppNotifier.EXTRA_STATE) ?: return
    val chat = intent.getStringExtra(WhatsAppNotifier.EXTRA_CHAT) ?: return
    val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(WhatsAppNotifier.REPLY_KEY)?.toString()?.trim()
    val app = context.applicationContext
    val pending = goAsync()
    // Off the main thread: starting and connecting an engine takes seconds.
    thread(name = "rv-whatsapp-action") {
      try {
        if (!WhatsAppEngines.awaitConnected(app, state, CONNECT_TIMEOUT_MS)) {
          if (intent.action == WhatsAppNotifier.ACTION_REPLY) {
            WhatsAppNotifier.post(app, state, chat, null, null, app.getString(R.string.rv_wa_not_sent), silent = true)
          }
          return@thread
        }
        if (intent.action == WhatsAppNotifier.ACTION_REPLY && !text.isNullOrEmpty()) {
          val id = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02X".format(it) }
          WhatsAppEngines.handle(state, JSONObject().put("type", "send").put("id", id).put("chat", chat).put("text", text).toString())
          // Answering reads the chat, as WhatsApp's own reply does; the reply stays shown, quietly.
          WhatsAppEngines.handle(state, JSONObject().put("type", "read").put("chat", chat).toString())
          WhatsAppNotifier.post(app, state, chat, null, null, text, silent = true)
        } else if (intent.action == WhatsAppNotifier.ACTION_READ) {
          WhatsAppEngines.handle(state, JSONObject().put("type", "read").put("chat", chat).toString())
          NotificationManagerCompat.from(app).cancel(WhatsAppNotifier.id(state, chat))
        }
      } catch (e: Exception) {
        // A state that cannot open (its key gone): nothing to answer with.
      } finally {
        pending.finish()
      }
    }
  }

  private companion object {
    /** Below the ten seconds a goAsync receiver may take. */
    const val CONNECT_TIMEOUT_MS = 8_000L
  }
}
