package com.rocketvibe.whatsapp

import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS face of [WhatsAppEngines]: JSON commands in, one `frame` event per engine frame out. */
class WhatsAppModule : Module() {
  private val listener: (String, String) -> Unit = { state, frame ->
    sendEvent("frame", mapOf("state" to state, "frame" to frame))
  }
  private val context: Context
    get() = appContext.reactContext?.applicationContext
      ?: throw CodedException("whatsapp_unavailable", "No React context", null)

  /** Failures reach JS as their `whatsapp_*` code, never with a path or key. */
  private fun <T> coded(block: () -> T): T = try {
    block()
  } catch (error: Exception) {
    val code = error.message?.takeIf { it.startsWith("whatsapp_") } ?: "whatsapp_start_failed"
    throw CodedException(code, code, null)
  }

  override fun definition() = ModuleDefinition {
    Name("WhatsApp")
    Events("frame")
    OnCreate { WhatsAppEngines.listen(listener) }
    OnDestroy { WhatsAppEngines.unlisten(listener) }
    Function("newState") { WhatsAppEngines.newState() }
    Function("running") { WhatsAppEngines.running() }
    AsyncFunction("start") { state: String -> coded { WhatsAppEngines.start(context, state) } }
    AsyncFunction("handle") { state: String, command: String -> WhatsAppEngines.handle(state, command) }
    AsyncFunction("stop") { state: String -> WhatsAppEngines.stop(state) }
    AsyncFunction("forget") { state: String -> coded { WhatsAppEngines.forget(context, state) } }
  }
}
