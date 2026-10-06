package com.rocketvibe.voice

import android.content.Context
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.track.VideoTrack
import livekit.org.webrtc.RendererCommon

/**
 * One participant's camera or screen, rendered from the engine's room. It
 * rebinds itself when the track comes and goes, so JS only names who and what.
 */
class VoiceVideoView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val renderer = TextureViewRenderer(context)
  private var initialized = false
  private var track: VideoTrack? = null
  var identity: String = ""
    set(value) { field = value; bind() }
  var source: String = "camera"
    set(value) { field = value; bind() }
  var fit: String = "cover"
    set(value) {
      field = value
      renderer.setScalingType(if (value == "contain") RendererCommon.ScalingType.SCALE_ASPECT_FIT else RendererCommon.ScalingType.SCALE_ASPECT_FILL)
    }
  private val listener: () -> Unit = { post { bind() } }

  init {
    addView(renderer, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    VoiceEngine.listen(listener)
    bind()
  }

  override fun onDetachedFromWindow() {
    VoiceEngine.unlisten(listener)
    unbind()
    if (initialized) { renderer.release(); initialized = false }
    super.onDetachedFromWindow()
  }

  private fun unbind() {
    track?.removeRenderer(renderer)
    track = null
  }

  private fun bind() {
    val next = VoiceEngine.videoTrack(identity, source == "screen")
    if (next === track) return
    unbind()
    if (next == null) return
    if (!initialized) {
      if (!VoiceEngine.initRenderer(renderer)) return
      initialized = true
      fit = fit
    }
    // The own camera reads like a mirror; the screen never does.
    renderer.setMirror(source == "camera" && identity == VoiceEngine.localIdentity())
    next.addRenderer(renderer)
    track = next
  }
}
