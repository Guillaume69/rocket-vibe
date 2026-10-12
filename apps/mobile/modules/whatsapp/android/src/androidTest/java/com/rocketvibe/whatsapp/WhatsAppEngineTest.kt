package com.rocketvibe.whatsapp

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The real engine (librv_whatsapp.so through JNA) and the real Android
 * Keystore, in the isolated instrumentation app: a new state reaches
 * WhatsApp until it offers a QR, then is erased. Never logs the QR. */
@RunWith(AndroidJUnit4::class)
class WhatsAppEngineTest {
  private fun types(frames: LinkedBlockingQueue<String>, until: String, seconds: Long): List<String> {
    val seen = mutableListOf<String>()
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
    while (until !in seen) {
      val left = deadline - System.nanoTime()
      if (left <= 0) break
      val frame = frames.poll(left, TimeUnit.NANOSECONDS) ?: break
      seen.add(JSONObject(frame).getString("type"))
    }
    return seen
  }

  @Test
  fun aNewStateReachesWhatsAppAndIsErased() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val state = WhatsAppEngines.newState()
    val frames = LinkedBlockingQueue<String>()
    val listener: (String, String) -> Unit = { s, frame -> if (s == state) frames.add(frame) }
    WhatsAppEngines.listen(listener)
    val directory = File(WhatsAppEngines.directory(context), state)
    try {
      WhatsAppEngines.start(context, state)
      WhatsAppEngines.start(context, state)
      assertEquals(listOf(state), WhatsAppEngines.running().filter { it == state })
      val seen = types(frames, "qr", 60)
      assertTrue("loaded first: $seen", seen.contains("status"))
      assertTrue("no QR from WhatsApp: $seen", seen.contains("qr"))
      assertTrue(WhatsAppEngines.handle(state, "{\"type\":\"replay\"}"))
      val replayed = types(frames, "reload", 10)
      assertTrue("replay: $replayed", replayed.contains("reload"))
      WhatsAppEngines.stop(state)
      assertFalse(state in WhatsAppEngines.running())
      assertFalse(WhatsAppEngines.handle(state, "{\"type\":\"replay\"}"))
      // Reopened with the key the Keystore unwraps.
      frames.clear()
      WhatsAppEngines.start(context, state)
      assertTrue(types(frames, "status", 10).contains("status"))
      WhatsAppEngines.stop(state)
    } finally {
      WhatsAppEngines.unlisten(listener)
      WhatsAppEngines.forget(context, state)
    }
    assertFalse(directory.exists())
    assertFalse(File(WhatsAppEngines.directory(context), "$state.key").exists())
  }
}
