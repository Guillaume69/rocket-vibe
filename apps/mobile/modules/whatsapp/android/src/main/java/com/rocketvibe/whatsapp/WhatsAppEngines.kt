package com.rocketvibe.whatsapp

import android.content.Context
import com.sun.jna.CallbackThreadInitializer
import com.sun.jna.Native
import java.io.File
import java.io.IOException
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/** The process's WhatsApp engines, one per account state. An engine holds its
 * state's lock, so the UI and (later) the background service share this one
 * instance: a JS reload or an account switch never stops an engine; only
 * stop, logout and forget do. */
object WhatsAppEngines {
  private class Running(val handle: Long, val frame: WhatsAppLibrary.Frame)

  private val running = ConcurrentHashMap<String, Running>()
  private val listeners = CopyOnWriteArrayList<(String, String) -> Unit>()
  private val stateId = Regex("[0-9a-f]{24}")
  private const val STOP = "{\"type\":\"stop\"}"

  fun listen(listener: (String, String) -> Unit) { listeners.add(listener) }
  fun unlisten(listener: (String, String) -> Unit) { listeners.remove(listener) }

  internal fun directory(context: Context): File {
    val dir = File(context.noBackupFilesDir, "whatsapp")
    if (!dir.exists() && !dir.mkdirs()) throw IOException("whatsapp_storage_unavailable")
    return dir
  }

  private fun stateFile(context: Context, state: String): File {
    if (!stateId.matches(state)) throw IllegalArgumentException("whatsapp_invalid_state")
    return File(File(directory(context), state), "state.bin")
  }

  /** A new account state's id: random, lower-case hex, as the desktop makes them. */
  fun newState(): String = ByteArray(12).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

  fun running(): List<String> = running.keys.toList()

  /** Opens the state and connects; nothing when it already runs here. */
  @Synchronized
  fun start(context: Context, state: String) {
    val path = stateFile(context, state)
    if (running.containsKey(state)) return
    val key = WhatsAppKeys.key(context, state, create = !path.exists())
    try {
      val frame = object : WhatsAppLibrary.Frame {
        override fun invoke(handle: Long, frame: String) {
          listeners.forEach { it(state, frame) }
        }
      }
      // The engine's threads stay attached between frames instead of being
      // attached and detached for each one.
      Native.setCallbackThreadInitializer(frame, CallbackThreadInitializer(true, false, "rv-whatsapp"))
      val handle = WhatsAppLibrary.native.rvwa_open(path.absolutePath, key, key.size, frame)
      when {
        handle == -1L -> throw IllegalStateException("whatsapp_busy")
        handle <= 0L -> throw IllegalStateException("whatsapp_start_failed")
      }
      running[state] = Running(handle, frame)
      WhatsAppLibrary.native.rvwa_connect(handle)
    } finally {
      key.fill(0)
    }
  }

  /** Runs one command; false once the engine ended, which closes it. */
  fun handle(state: String, command: String): Boolean {
    val engine = running[state] ?: return false
    val alive = WhatsAppLibrary.native.rvwa_handle(engine.handle, command) == 1
    if (!alive) close(state)
    return alive
  }

  fun stop(state: String) {
    val engine = running[state] ?: return
    WhatsAppLibrary.native.rvwa_handle(engine.handle, STOP)
    close(state)
  }

  @Synchronized
  private fun close(state: String) {
    running.remove(state)?.let { WhatsAppLibrary.native.rvwa_close(it.handle) }
  }

  /** Stops the engine and erases the state, its media and its key. */
  fun forget(context: Context, state: String) {
    stateFile(context, state)
    stop(state)
    File(directory(context), state).deleteRecursively()
    WhatsAppKeys.forget(context, state)
  }
}
