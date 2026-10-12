package com.rocketvibe.whatsapp

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Build
import android.os.SystemClock
import java.nio.ByteOrder

/** A recorded voice note (the composer's AAC in MP4) made into what WhatsApp
 * plays as one: Opus in Ogg, mono, 48 kHz. Android's own codecs and muxer,
 * from Android 10; before, the note goes as an audio file. */
internal object WhatsAppVoice {
  private const val RATE = 48_000
  private const val TIMEOUT_US = 10_000L
  /** A codec that stops answering is given up after this long. */
  private const val LIMIT_MS = 60_000L

  fun available(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

  /** Writes [output]; false when this device cannot, or the input is not audio. */
  fun toOpus(input: String, output: String): Boolean {
    if (!available()) return false
    val pcm = decode(input) ?: return false
    return pcm.isNotEmpty() && encode(pcm, output)
  }

  /** The audio track as 16-bit mono samples at [RATE]. */
  private fun decode(input: String): ShortArray? {
    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(input)
      val track = (0 until extractor.trackCount).firstOrNull {
        extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      } ?: return null
      extractor.selectTrack(track)
      val format = extractor.getTrackFormat(track)
      var rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      val decoder = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
      val samples = Samples()
      try {
        decoder.configure(format, null, null, 0)
        decoder.start()
        val info = MediaCodec.BufferInfo()
        var inputDone = false
        val deadline = SystemClock.elapsedRealtime() + LIMIT_MS
        while (SystemClock.elapsedRealtime() < deadline) {
          if (!inputDone) {
            val i = decoder.dequeueInputBuffer(TIMEOUT_US)
            if (i >= 0) {
              val n = extractor.readSampleData(decoder.getInputBuffer(i)!!, 0)
              if (n < 0) {
                decoder.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                inputDone = true
              } else {
                decoder.queueInputBuffer(i, 0, n, extractor.sampleTime, 0)
                extractor.advance()
              }
            }
          }
          val o = decoder.dequeueOutputBuffer(info, TIMEOUT_US)
          if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            rate = decoder.outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            channels = decoder.outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
          } else if (o >= 0) {
            val buffer = decoder.getOutputBuffer(o)!!
            buffer.position(info.offset)
            buffer.limit(info.offset + info.size)
            val shorts = buffer.order(ByteOrder.nativeOrder()).asShortBuffer()
            while (shorts.remaining() >= channels) {
              var sum = 0
              repeat(channels) { sum += shorts.get() }
              samples.add((sum / channels).toShort())
            }
            decoder.releaseOutputBuffer(o, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return resample(samples, rate)
          }
        }
        return null
      } finally {
        runCatching { decoder.stop() }
        decoder.release()
      }
    } catch (error: Exception) {
      return null
    } finally {
      extractor.release()
    }
  }

  /** Samples kept unboxed: a minute of audio is millions of them. */
  private class Samples {
    private var data = ShortArray(1 shl 16)
    var size = 0
      private set
    fun add(value: Short) {
      if (size == data.size) data = data.copyOf(size * 2)
      data[size++] = value
    }
    fun toArray(): ShortArray = data.copyOf(size)
  }

  /** Linear resampling to [RATE]: Opus only takes 8, 12, 16, 24 or 48 kHz. */
  private fun resample(input: Samples, rate: Int): ShortArray {
    val samples = input.toArray()
    if (rate == RATE || samples.isEmpty()) return samples
    val count = (samples.size.toLong() * RATE / rate).toInt()
    return ShortArray(count) { i ->
      val position = i.toDouble() * rate / RATE
      val index = position.toInt().coerceAtMost(samples.size - 1)
      val next = (index + 1).coerceAtMost(samples.size - 1)
      val fraction = position - index
      (samples[index] * (1 - fraction) + samples[next] * fraction).toInt().toShort()
    }
  }

  private fun encode(pcm: ShortArray, output: String): Boolean {
    val encoder = try {
      MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
    } catch (error: Exception) {
      return false
    }
    val muxer = MediaMuxer(output, MediaMuxer.OutputFormat.MUXER_OUTPUT_OGG)
    var track = -1
    var started = false
    try {
      val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, RATE, 1)
      format.setInteger(MediaFormat.KEY_BIT_RATE, 32_000)
      encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      encoder.start()
      val info = MediaCodec.BufferInfo()
      var offset = 0
      var inputDone = false
      val deadline = SystemClock.elapsedRealtime() + LIMIT_MS
      while (SystemClock.elapsedRealtime() < deadline) {
        if (!inputDone) {
          val i = encoder.dequeueInputBuffer(TIMEOUT_US)
          if (i >= 0) {
            val buffer = encoder.getInputBuffer(i)!!
            buffer.clear()
            val count = minOf(buffer.remaining() / 2, pcm.size - offset)
            val time = offset * 1_000_000L / RATE
            if (count <= 0) {
              encoder.queueInputBuffer(i, 0, 0, time, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              buffer.order(ByteOrder.nativeOrder()).asShortBuffer().put(pcm, offset, count)
              encoder.queueInputBuffer(i, 0, count * 2, time, 0)
              offset += count
            }
          }
        }
        val o = encoder.dequeueOutputBuffer(info, TIMEOUT_US)
        if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          track = muxer.addTrack(encoder.outputFormat)
          muxer.start()
          started = true
        } else if (o >= 0) {
          val buffer = encoder.getOutputBuffer(o)!!
          // The Opus header travels in the track format, not as a sample.
          if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0 && started) {
            buffer.position(info.offset)
            buffer.limit(info.offset + info.size)
            muxer.writeSampleData(track, buffer, info)
          }
          encoder.releaseOutputBuffer(o, false)
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return started
        }
      }
      return false
    } catch (error: Exception) {
      return false
    } finally {
      runCatching { encoder.stop() }
      encoder.release()
      runCatching { if (started) muxer.stop() }
      muxer.release()
    }
  }
}
