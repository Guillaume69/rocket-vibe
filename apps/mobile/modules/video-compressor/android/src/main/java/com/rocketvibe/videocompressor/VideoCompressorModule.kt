package com.rocketvibe.videocompressor

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Shrinks a video before upload, with Media3 Transformer, Android's official
 * transcoder, on hardware MediaCodec. Outputs H.264 MP4 at the requested
 * bitrate, short side capped (aspect preserved), audio copied as is when the
 * container accepts it. The file is written to the app cache: that is what
 * lets `deleteIfTemporary` (ui/temporaryFiles.ts) clean it up once the upload
 * is settled.
 */
@OptIn(UnstableApi::class)
class VideoCompressorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VideoCompressor")

    AsyncFunction("compress") { uri: String, maxShortSide: Int, videoBitrate: Int, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_CONTEXT", "Android context unavailable.", null)
        return@AsyncFunction
      }
      // Metadata is read here, on the function's thread: it is I/O. Transformer
      // needs a Looper thread, the main one (transcoding runs on its own
      // threads, nothing blocks there).
      val effects = resizeEffects(context, uri, maxShortSide)
      Handler(Looper.getMainLooper()).post {
        try {
          startExport(context, uri, effects, videoBitrate, promise)
        } catch (e: Exception) {
          promise.reject("ERR_COMPRESSION", e.message ?: "Transcoding failed.", e)
        }
      }
    }
  }

  private fun startExport(
    context: Context,
    uri: String,
    effects: List<Effect>,
    videoBitrate: Int,
    promise: Promise,
  ) {
    val output = File.createTempFile("compressed-video-", ".mp4", context.cacheDir)
    val transformer = Transformer.Builder(context)
      // H.264: the codec every recipient can play, browsers included.
      .setVideoMimeType(MimeTypes.VIDEO_H264)
      .setEncoderFactory(
        DefaultEncoderFactory.Builder(context)
          .setRequestedVideoEncoderSettings(
            VideoEncoderSettings.Builder().setBitrate(videoBitrate).build(),
          )
          .build(),
      )
      .addListener(object : Transformer.Listener {
        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
          promise.resolve(
            mapOf(
              "uri" to Uri.fromFile(output).toString(),
              "size" to output.length().toDouble(),
            ),
          )
        }

        override fun onError(
          composition: Composition,
          exportResult: ExportResult,
          exportException: ExportException,
        ) {
          output.delete()
          promise.reject(
            "ERR_COMPRESSION",
            exportException.message ?: "Transcoding failed.",
            exportException,
          )
        }
      })
      .build()
    transformer.start(
      EditedMediaItem.Builder(MediaItem.fromUri(uri))
        .setEffects(Effects(listOf(), effects))
        .build(),
      output.absolutePath,
    )
  }

  /**
   * The resize, if the video exceeds the cap; otherwise no effect, since
   * re-encoding at the requested bitrate already shrinks it. The compared
   * dimensions are the UPRIGHT ones (rotation applied, Transformer straightens
   * the image before effects): a 1080×1920 portrait and a 1920×1080 landscape
   * both come out with a short side of 720, neither shrunk more than the
   * other.
   */
  private fun resizeEffects(context: Context, uri: String, maxShortSide: Int): List<Effect> {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(context, Uri.parse(uri))
      val width =
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
      val height =
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
      if (width == null || height == null || width <= 0 || height <= 0) return listOf()
      val rotation =
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull()
          ?: 0
      val rotated = rotation == 90 || rotation == 270
      val uprightWidth = if (rotated) height else width
      val uprightHeight = if (rotated) width else height
      val shortSide = minOf(uprightWidth, uprightHeight)
      if (shortSide <= maxShortSide) return listOf()
      // Even target height (encoder constraint); the width follows the aspect
      // and the encoder aligns it to its own constraints.
      val targetHeight = (uprightHeight.toLong() * maxShortSide / shortSide).toInt() / 2 * 2
      return listOf(Presentation.createForHeight(targetHeight))
    } catch (e: Exception) {
      // Unreadable metadata: no resize, re-encoding only.
      return listOf()
    } finally {
      retriever.release()
    }
  }
}
