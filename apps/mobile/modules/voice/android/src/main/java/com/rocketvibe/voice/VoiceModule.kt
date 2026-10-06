package com.rocketvibe.voice

import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class ConnectOptions : Record {
  @Field val room: String = ""
  @Field val url: String = ""
  @Field val token: String = ""
  @Field val title: String = ""
  @Field val link: String? = null
  @Field val microphone: Boolean = true
}

/** JS face of [VoiceEngine]: commands in, one `change` event carrying the whole snapshot out. */
class VoiceModule : Module() {
  private val listener: () -> Unit = { sendEvent("change", VoiceEngine.last) }

  override fun definition() = ModuleDefinition {
    Name("Voice")
    Events("change")
    OnCreate {
      VoiceEngine.attach(appContext.reactContext ?: throw IllegalStateException("No React context"))
      VoiceEngine.listen(listener)
    }
    OnDestroy { VoiceEngine.unlisten(listener) }
    Function("snapshot") { VoiceEngine.last }
    AsyncFunction("connect") { o: ConnectOptions ->
      VoiceEngine.connect(o.room, o.url, o.token, o.title, o.link, o.microphone)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("disconnect") { VoiceEngine.leave() }.runOnQueue(Queues.MAIN)
    AsyncFunction("setMicrophone") { enabled: Boolean -> VoiceEngine.setMicrophone(enabled) }.runOnQueue(Queues.MAIN)
    AsyncFunction("setDeafened") { on: Boolean -> VoiceEngine.setDeafened(on) }.runOnQueue(Queues.MAIN)
    AsyncFunction("setRoute") { route: String -> VoiceEngine.setRoute(route) }.runOnQueue(Queues.MAIN)
    AsyncFunction("ringback") { on: Boolean ->
      appContext.reactContext?.let { VoiceSounds.ringback(it, on) }
      Unit
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("ringtone") { on: Boolean ->
      appContext.reactContext?.let { VoiceSounds.ringtone(it, on) }
      Unit
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("dismissRing") { ring: String ->
      appContext.reactContext?.let { VoiceRinging.cancel(it, ring) }
      Unit
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("missed") {
      appContext.reactContext?.let { VoiceSounds.cue(it, R.raw.cue_missed) }
      Unit
    }.runOnQueue(Queues.MAIN)
  }
}
