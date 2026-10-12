package com.rocketvibe.whatsapp

import com.sun.jna.Callback
import com.sun.jna.Library
import com.sun.jna.Native

/** librv_whatsapp.so (apps/desktop/whatsapp/mobile): the WhatsApp engine's C face. */
internal interface WhatsAppLibrary : Library {
  /** Each frame an engine emits, a JSON object, on one of the engine's threads. */
  interface Frame : Callback {
    fun invoke(handle: Long, frame: String)
  }

  /** The engine's handle; -1 when the state is held elsewhere, -2 on any other failure. */
  fun rvwa_open(path: String, key: ByteArray, keyLength: Int, callback: Frame): Long
  fun rvwa_connect(handle: Long)
  /** 1 while the engine runs, 0 once it ended. */
  fun rvwa_handle(handle: Long, command: String): Int
  fun rvwa_close(handle: Long)

  companion object {
    val native: WhatsAppLibrary by lazy {
      Native.load("rv_whatsapp", WhatsAppLibrary::class.java, mapOf(Library.OPTION_STRING_ENCODING to "UTF-8"))
    }
  }
}
