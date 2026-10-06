package com.rocketvibe.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.SoundPool

/** The voice sounds (assets/sounds): short cues, and the two looped rings. */
object VoiceSounds {
  private val signalling = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
  private var pool: SoundPool? = null
  private val loaded = mutableMapOf<Int, Int>()
  private var ringback: MediaPlayer? = null
  private var ringtone: MediaPlayer? = null

  fun cue(context: Context, resource: Int) {
    val sounds = pool ?: SoundPool.Builder().setMaxStreams(2).setAudioAttributes(signalling).build().also { created ->
      pool = created
      created.setOnLoadCompleteListener { p, id, status -> if (status == 0) p.play(id, 0.6f, 0.6f, 1, 0, 1f) }
    }
    val id = loaded[resource]
    if (id == null) loaded[resource] = sounds.load(context, resource, 1)
    else sounds.play(id, 0.6f, 0.6f, 1, 0, 1f)
  }

  private fun loop(context: Context, resource: Int, attributes: AudioAttributes): MediaPlayer? =
    MediaPlayer.create(context, resource, attributes, 0)?.apply { isLooping = true; start() }

  /** What the caller hears while the call rings. */
  fun ringback(context: Context, on: Boolean) {
    ringback?.release(); ringback = null
    if (on) ringback = loop(context, R.raw.ringback, signalling)
  }

  /** An incoming call while the app is open (the notification rings otherwise). */
  fun ringtone(context: Context, on: Boolean) {
    ringtone?.release(); ringtone = null
    if (on) ringtone = loop(context, R.raw.ringtone, AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
      .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
  }
}
