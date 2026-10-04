package com.rocketvibe.downloads

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
class DownloadsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Downloads")

    AsyncFunction("save") { source: String, name: String, type: String? ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val file = File(Uri.parse(source).path ?: throw IOException("Unreadable source"))
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, name)
          put(MediaStore.Downloads.MIME_TYPE, type ?: "application/octet-stream")
          put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
          ?: throw IOException("Downloads entry refused")
        try {
          val output = resolver.openOutputStream(target) ?: throw IOException("Write refused")
          output.use { out -> file.inputStream().use { it.copyTo(out) } }
          resolver.update(
            target,
            ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) },
            null,
            null,
          )
        } catch (e: Exception) {
          resolver.delete(target, null, null)
          throw e
        }
        target.toString()
      } else {
        @Suppress("DEPRECATION")
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        dir.mkdirs()
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var target = File(dir, name)
        var n = 1
        while (target.exists()) target = File(dir, base + " (" + n++ + ")" + ext)
        file.copyTo(target)
        target.absolutePath
      }
    }
  }
}
