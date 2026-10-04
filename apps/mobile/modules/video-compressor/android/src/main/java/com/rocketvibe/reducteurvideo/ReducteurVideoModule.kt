package com.rocketvibe.reducteurvideo

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
 * c'est ce qui autorise `supprimerSiTemporaire` (ui/temporaryFiles.ts) à
 * le nettoyer une fois l'envoi soldé.
 */
@OptIn(UnstableApi::class)
class ReducteurVideoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ReducteurVideo")

    AsyncFunction("reduire") { uri: String, coteCourtMax: Int, bitrateVideo: Int, promise: Promise ->
      val contexte = appContext.reactContext
      if (contexte == null) {
        promise.reject("ERR_CONTEXTE", "Contexte Android indisponible.", null)
        return@AsyncFunction
      }
      // Les métadonnées se lisent ici, sur le thread de la fonction : c'est de
      // l'I/O. Transformer, lui, exige un thread à Looper — le principal (le
      // transcodage tourne sur ses propres threads, rien n'y bloque).
      val effets = effetsRedimension(contexte, uri, coteCourtMax)
      Handler(Looper.getMainLooper()).post {
        try {
          demarrer(contexte, uri, effets, bitrateVideo, promise)
        } catch (e: Exception) {
          promise.reject("ERR_REDUCTION", e.message ?: "Transcodage impossible.", e)
        }
      }
    }
  }

  private fun demarrer(
    contexte: Context,
    uri: String,
    effets: List<Effect>,
    bitrateVideo: Int,
    promise: Promise,
  ) {
    val sortie = File.createTempFile("video-reduite-", ".mp4", contexte.cacheDir)
    val transformer = Transformer.Builder(contexte)
      // H.264 : le codec que tout destinataire sait lire, navigateur compris.
      .setVideoMimeType(MimeTypes.VIDEO_H264)
      .setEncoderFactory(
        DefaultEncoderFactory.Builder(contexte)
          .setRequestedVideoEncoderSettings(
            VideoEncoderSettings.Builder().setBitrate(bitrateVideo).build(),
          )
          .build(),
      )
      .addListener(object : Transformer.Listener {
        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
          promise.resolve(
            mapOf(
              "uri" to Uri.fromFile(sortie).toString(),
              "taille" to sortie.length().toDouble(),
            ),
          )
        }

        override fun onError(
          composition: Composition,
          exportResult: ExportResult,
          exportException: ExportException,
        ) {
          sortie.delete()
          promise.reject(
            "ERR_REDUCTION",
            exportException.message ?: "Transcodage impossible.",
            exportException,
          )
        }
      })
      .build()
    transformer.start(
      EditedMediaItem.Builder(MediaItem.fromUri(uri))
        .setEffects(Effects(listOf(), effets))
        .build(),
      sortie.absolutePath,
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
  private fun effetsRedimension(contexte: Context, uri: String, coteCourtMax: Int): List<Effect> {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(contexte, Uri.parse(uri))
      val largeur =
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
      val hauteur =
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
      if (largeur == null || hauteur == null || largeur <= 0 || hauteur <= 0) return listOf()
      val rotation =
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull()
          ?: 0
      val pivotee = rotation == 90 || rotation == 270
      val largeurDroite = if (pivotee) hauteur else largeur
      val hauteurDroite = if (pivotee) largeur else hauteur
      val coteCourt = minOf(largeurDroite, hauteurDroite)
      if (coteCourt <= coteCourtMax) return listOf()
      // Hauteur cible paire (contrainte d'encodeur) ; la largeur suit l'aspect
      // et l'encodeur l'aligne lui-même sur ses propres contraintes.
      val hauteurCible = (hauteurDroite.toLong() * coteCourtMax / coteCourt).toInt() / 2 * 2
      return listOf(Presentation.createForHeight(hauteurCible))
    } catch (e: Exception) {
      // Métadonnées illisibles : pas de redimensionnement, le réencodage seul.
      return listOf()
    } finally {
      retriever.release()
    }
  }
}
