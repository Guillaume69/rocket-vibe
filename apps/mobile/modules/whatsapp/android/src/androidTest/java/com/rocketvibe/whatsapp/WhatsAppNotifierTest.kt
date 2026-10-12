package com.rocketvibe.whatsapp

import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** New messages notify, a replay does not, my own do not, and a read clears the chat. */
@RunWith(AndroidJUnit4::class)
class WhatsAppNotifierTest {
  private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
  private val state = "00000000000000000000beef"
  private val manager = context.getSystemService(NotificationManager::class.java)

  @Before fun background() {
    InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(
      "pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS").close()
    WhatsAppNotifier.inFront = { false }
  }

  @After fun restore() {
    manager.cancelAll()
  }

  private fun message(id: String, chat: String, sender: String, text: String, mine: Boolean = false) =
    """{"type":"message","message":{"id":"$chat:$id","chat":"$chat","name":"x","sender":"$sender","author":"Alice","text":"$text","ts":${System.currentTimeMillis()},"mine":$mine}}"""

  private fun active(chat: String) = manager.activeNotifications.firstOrNull { it.id == WhatsAppNotifier.id(state, chat) }

  @Test
  fun newMessagesNotifyOnceAndAReadClearsThem() {
    val alice = "33600000001@s.whatsapp.net"
    WhatsAppNotifier.opened(state)
    WhatsAppNotifier.frame(context, state, message("old", alice, alice, "from the cache"))
    WhatsAppNotifier.frame(context, state, """{"type":"replayed"}""")
    Thread.sleep(300)
    assertNull("a replayed message is not new", active(alice))
    WhatsAppNotifier.frame(context, state, """{"type":"names","names":{"$alice":"Alice Martin"}}""")
    WhatsAppNotifier.frame(context, state, message("1", alice, alice, "Bonjour"))
    WhatsAppNotifier.frame(context, state, message("me", alice, "me", "mine", mine = true))
    WhatsAppNotifier.frame(context, state, message("1", alice, alice, "Bonjour (edited)"))
    WhatsAppNotifier.frame(context, state, message("2", alice, alice, "Ça va ?"))
    Thread.sleep(300)
    val posted = active(alice)
    assertNotNull(posted)
    val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted!!.notification)!!
    assertEquals(listOf("Bonjour", "Ça va ?"), style.messages.map { it.text.toString() })
    assertEquals("Alice Martin", style.messages[0].person?.name?.toString())
    assertEquals(2, posted.notification.actions.size)
    WhatsAppNotifier.frame(context, state, """{"type":"chat","jid":"$alice","unread":0}""")
    Thread.sleep(300)
    assertNull("read elsewhere, gone here", active(alice))
    // Reloaded: what comes again is not new either.
    WhatsAppNotifier.frame(context, state, """{"type":"reload"}""")
    WhatsAppNotifier.frame(context, state, message("3", alice, alice, "during a reload"))
    Thread.sleep(300)
    assertNull(active(alice))
  }
}
