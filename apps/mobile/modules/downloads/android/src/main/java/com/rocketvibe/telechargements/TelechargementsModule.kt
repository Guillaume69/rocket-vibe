package com.rocketvibe.telechargements

import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.IOException

/**
 * Enregistre un fichier du cache dans Téléchargements, comme le ferait un
 * navigateur. Depuis Android 10, `MediaStore.Downloads` accepte n'importe quel
 * type de fichier SANS permission ; avant, on écrit dans le dossier public, ce
 * qui exige WRITE_EXTERNAL_STORAGE (déclarée par expo-media-library jusqu'à
 * l'API 32).
 */
class TelechargementsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Telechargements")

    AsyncFunction("enregistrer") { source: String, nom: String, type: String? ->
      val contexte = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val fichier = File(Uri.parse(source).path ?: throw IOException("Source illisible"))
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val resolver = contexte.contentResolver
        val valeurs = ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, nom)
          put(MediaStore.Downloads.MIME_TYPE, type ?: "application/octet-stream")
          put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val cible = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, valeurs)
          ?: throw IOException("Entrée Téléchargements refusée")
        try {
          val sortie = resolver.openOutputStream(cible) ?: throw IOException("Écriture refusée")
          sortie.use { out -> fichier.inputStream().use { it.copyTo(out) } }
          resolver.update(
            cible,
            ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) },
            null,
            null,
          )
        } catch (e: Exception) {
          resolver.delete(cible, null, null)
          throw e
        }
        cible.toString()
      } else {
        @Suppress("DEPRECATION")
        val dossier = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        dossier.mkdirs()
        val point = nom.lastIndexOf('.')
        val base = if (point > 0) nom.substring(0, point) else nom
        val ext = if (point > 0) nom.substring(point) else ""
        var cible = File(dossier, nom)
        var n = 1
        while (cible.exists()) cible = File(dossier, base + " (" + n++ + ")" + ext)
        fichier.copyTo(cible)
        cible.absolutePath
      }
    }
  }
}
