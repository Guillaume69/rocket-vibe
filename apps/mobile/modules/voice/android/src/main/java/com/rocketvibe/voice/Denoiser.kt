package com.rocketvibe.voice

import android.util.Log

/**
 * RNNoise (crates/rv-voice-mobile, the desktop sidecar's noise remover) over
 * JNI: one handle for the process, used from the audio thread only. Absent
 * library (a build without it): [available] is false and the microphone goes
 * through WebRTC's own noise suppression alone.
 */
internal object Denoiser {
  /** 10 ms at 48 kHz, mono. */
  const val FRAME = 480

  val available: Boolean = try {
    System.loadLibrary("rv_voice_mobile")
    true
  } catch (error: UnsatisfiedLinkError) {
    Log.w("RocketVibeVoice", "noise remover unavailable")
    false
  }

  private var handle = 0L

  /** Cleans [frame] in place; its voice probability, 0 to 1. */
  fun process(frame: ShortArray): Float {
    if (!available) return 0f
    if (handle == 0L) handle = create()
    return process(handle, frame)
  }

  @JvmStatic private external fun create(): Long
  @JvmStatic private external fun process(handle: Long, samples: ShortArray): Float
}
