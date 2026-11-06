package com.rocketvibe.voice

/**
 * Slack canvases (crates/rv-voice-mobile/src/canvas.rs, the desktop's engine)
 * over JNI: reading a canvas's `load-data` answer and planning a save, both
 * base64 in and JSON out, null when this build lacks the library or the
 * document cannot be read. The app does the HTTP.
 */
internal object Canvas {
  private val available: Boolean = Denoiser.available

  fun readDocument(load: String): String? = if (available) read0(load) else null

  fun planSave(load: String, markdown: String, session: String, suffix: String, nowSecs: Long): String? =
    if (available) plan0(load, markdown, session, suffix, nowSecs) else null

  @JvmStatic @JvmName("read") private external fun read0(load: String): String?

  @JvmStatic @JvmName("plan") private external fun plan0(
    load: String,
    markdown: String,
    session: String,
    suffix: String,
    nowSecs: Long,
  ): String?
}
