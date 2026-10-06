package com.rocketvibe.voice

import android.app.Activity
import android.content.Context
import android.media.projection.MediaProjectionManager
import expo.modules.kotlin.Promise
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
  private var consent: Promise? = null

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
    AsyncFunction("setCamera") { enabled: Boolean -> VoiceEngine.setCamera(enabled) }.runOnQueue(Queues.MAIN)
    // Asks Android for the screen (MediaProjection consent), then shares it. Resolves false when refused.
    AsyncFunction("startScreenShare") { promise: Promise ->
      val activity = appContext.currentActivity
      val projection = activity?.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
      if (activity == null || projection == null) { promise.resolve(false); return@AsyncFunction }
      consent?.resolve(false)
      consent = promise
      activity.startActivityForResult(projection.createScreenCaptureIntent(), SCREEN_REQUEST)
    }.runOnQueue(Queues.MAIN)
    OnActivityResult { _, payload ->
      if (payload.requestCode != SCREEN_REQUEST) return@OnActivityResult
      val promise = consent ?: return@OnActivityResult
      consent = null
      val data = payload.data
      if (payload.resultCode == Activity.RESULT_OK && data != null) {
        VoiceEngine.startScreenShare(data)
        promise.resolve(true)
      } else promise.resolve(false)
    }
    AsyncFunction("stopScreenShare") { VoiceEngine.stopScreenShare() }.runOnQueue(Queues.MAIN)
    View(VoiceVideoView::class) {
      Prop("identity") { view: VoiceVideoView, identity: String -> view.identity = identity }
      Prop("source") { view: VoiceVideoView, source: String -> view.source = source }
      Prop("fit") { view: VoiceVideoView, fit: String -> view.fit = fit }
    }
    AsyncFunction("missed") {
      appContext.reactContext?.let { VoiceSounds.cue(it, R.raw.cue_missed) }
      Unit
    }.runOnQueue(Queues.MAIN)
  }
}

private const val SCREEN_REQUEST = 0x7276
