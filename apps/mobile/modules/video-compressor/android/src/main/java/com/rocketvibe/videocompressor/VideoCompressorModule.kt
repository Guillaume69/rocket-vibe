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
 * Réduction d'une vidéo avant envoi, par Media3 Transformer — le transcodeur
 * officiel d'Android, sur MediaCodec matériel. Sortie MP4 H.264 au bitrate
 * demandé, côté court plafonné (l'aspect est préservé), audio copié tel quel
 * quand le conteneur l'accepte. Le fichier est écrit dans le cache de l'app :
 * c'est ce qui autorise `deleteIfTemporary` (ui/temporaryFiles.ts) à
 * le nettoyer une fois l'envoi soldé.
 */
@OptIn(UnstableApi::class)
class VideoCompressorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VideoCompressor")

    AsyncFunction("compress") { uri: String, maxShortSide: Int, videoBitrate: Int, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_CONTEXT", "Contexte Android indisponible.", null)
        return@AsyncFunction
      }
      // Les métadonnées se lisent ici, sur le thread de la fonction : c'est de
      // l'I/O. Transformer, lui, exige un thread à Looper — le principal (le
      // transcodage tourne sur ses propres threads, rien n'y bloque).
      val effects = resizeEffects(context, uri, maxShortSide)
      Handler(Looper.getMainLooper()).post {
        try {
          startExport(context, uri, effects, videoBitrate, promise)
        } catch (e: Exception) {
          promise.reject("ERR_COMPRESSION", e.message ?: "Transcodage impossible.", e)
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
      // H.264 : le codec que tout destinataire sait lire, navigateur compris.
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
            exportException.message ?: "Transcodage impossible.",
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
   * Le redimensionnement, si la vidéo dépasse le plafond ; sinon aucun effet —
   * le réencodage au bitrate demandé réduit déjà. Les dimensions comparées
   * sont les dimensions DROITES (rotation appliquée — Transformer redresse
   * l'image avant les effets) : un portrait 1080×1920 et un paysage 1920×1080
   * sortent tous deux avec un côté court de 720, pas l'un plus réduit que
   * l'autre.
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
      // Hauteur cible paire (contrainte d'encodeur) ; la largeur suit l'aspect
      // et l'encodeur l'aligne lui-même sur ses propres contraintes.
      val targetHeight = (uprightHeight.toLong() * maxShortSide / shortSide).toInt() / 2 * 2
      return listOf(Presentation.createForHeight(targetHeight))
    } catch (e: Exception) {
      // Métadonnées illisibles : pas de redimensionnement, le réencodage seul.
      return listOf()
    } finally {
      retriever.release()
    }
  }
}
