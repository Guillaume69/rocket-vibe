package com.rocketvibe.whatsapp

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** A recorded note as the composer makes it (AAC in MP4, 44.1 kHz stereo)
 * becomes Opus in Ogg, the format WhatsApp plays as a voice note. */
@RunWith(AndroidJUnit4::class)
class WhatsAppVoiceTest {
  /** Two seconds of a 440 Hz tone, encoded like the composer's recordings. */
  private fun recording(file: File) {
    val rate = 44_100
    val channels = 2
    val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, channels).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
    }
    val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    encoder.start()
    val muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    val total = rate * 2
    var written = 0
    var track = -1
    val info = MediaCodec.BufferInfo()
    var done = false
    while (true) {
      if (!done) {
        val i = encoder.dequeueInputBuffer(10_000)
        if (i >= 0) {
          val buffer = encoder.getInputBuffer(i)!!
          buffer.clear()
          val frames = minOf(buffer.remaining() / (2 * channels), total - written)
          val time = written * 1_000_000L / rate
          if (frames <= 0) {
            encoder.queueInputBuffer(i, 0, 0, time, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            done = true
          } else {
            val shorts = buffer.order(ByteOrder.nativeOrder()).asShortBuffer()
            for (f in 0 until frames) {
              val v = (sin(2 * PI * 440 * (written + f) / rate) * 8000).toInt().toShort()
              shorts.put(v); shorts.put(v)
            }
            encoder.queueInputBuffer(i, 0, frames * 2 * channels, time, 0)
            written += frames
          }
        }
      }
      val o = encoder.dequeueOutputBuffer(info, 10_000)
      if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
        track = muxer.addTrack(encoder.outputFormat)
        muxer.start()
      } else if (o >= 0) {
        val buffer = encoder.getOutputBuffer(o)!!
        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) muxer.writeSampleData(track, buffer, info)
        encoder.releaseOutputBuffer(o, false)
        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
      }
    }
    encoder.stop(); encoder.release(); muxer.stop(); muxer.release()
  }

  @Test
  fun aRecordedNoteBecomesOpusInOgg() {
    assumeTrue(WhatsAppVoice.available())
    val dir = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
    val input = File(dir, "vocal-test.m4a")
    val output = File(dir, "vocal-test.ogg")
    output.delete()
    recording(input)
    assertTrue(WhatsAppVoice.toOpus(input.absolutePath, output.absolutePath))
    val bytes = output.readBytes()
    assertEquals("OggS", String(bytes, 0, 4, Charsets.US_ASCII))
    assertTrue("an Opus stream", String(bytes, Charsets.ISO_8859_1).contains("OpusHead"))
    assertTrue("two seconds of audio, not just headers: ${bytes.size} bytes", bytes.size > 2_000)
    // Not audio: refused, nothing claimed.
    val text = File(dir, "not-audio.m4a").apply { writeText("hello") }
    assertFalse(WhatsAppVoice.toOpus(text.absolutePath, File(dir, "not-audio.ogg").absolutePath))
    input.delete(); output.delete(); text.delete()
  }
}
