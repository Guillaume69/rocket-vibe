package com.rocketvibe.voice

import android.content.Context
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.track.VideoTrack
import livekit.org.webrtc.RendererCommon
import livekit.org.webrtc.VideoSink
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * One participant's camera or screen, rendered from the engine's room. It
 * rebinds itself when the track comes and goes, so JS only names who and what.
 * The renderer stretches frames to its own size, so this view sizes it to the
 * frame's proportions: inside the view (`contain`, letterboxed) or over it
 * (`cover`, the overflow clipped).
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
      place()
    }
  private val listener: () -> Unit = { post { bind() } }
  @Volatile private var frameWidth = 0
  @Volatile private var frameHeight = 0
  /** Only watches the frames' size, on the render thread. */
  private val sizer = VideoSink { frame ->
    val (width, height) = frame.rotatedWidth to frame.rotatedHeight
    if (width != frameWidth || height != frameHeight) {
      frameWidth = width
      frameHeight = height
      post { place() }
    }
  }

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

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    place()
  }

  private fun place() {
    val (width, height) = this.width to this.height
    if (width == 0 || height == 0) return
    var (w, h) = width to height
    val (fw, fh) = frameWidth to frameHeight
    if (fw > 0 && fh > 0) {
      val (sx, sy) = width.toFloat() / fw to height.toFloat() / fh
      val scale = if (fit == "contain") min(sx, sy) else max(sx, sy)
      w = (fw * scale).roundToInt()
      h = (fh * scale).roundToInt()
    }
    val (left, top) = (width - w) / 2 to (height - h) / 2
    renderer.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
    renderer.layout(left, top, left + w, top + h)
  }

  private fun unbind() {
    track?.removeRenderer(renderer)
    track?.removeRenderer(sizer)
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
    next.addRenderer(sizer)
    track = next
  }
}
