package com.rocketvibe.transfertfichier

import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class TransfertFichierModule : Module() {
  private val uploadsScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val transfers = ConcurrentHashMap<String, Call>()
  private val cancelled = ConcurrentHashMap.newKeySet<String>()
  private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
    .callTimeout(150, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS)
    .writeTimeout(15, TimeUnit.SECONDS).build()

  override fun definition() = ModuleDefinition {
    Name("TransfertFichier")
    Events("progress")
    AsyncFunction("cancel") { id: String ->
      cancelled.add(id)
      transfers[id]?.cancel()
      Unit
    }
    AsyncFunction("upload") { id: String, url: String, uri: String, headers: Map<String, String> ->
      val source = Uri.parse(uri)
      if (source.scheme != "file") throw IOException("Private local file required")
      val file = File(source.path ?: throw IOException("Invalid file"))
      val length = file.length()
      if (!file.isFile || length <= 0 || length > 100L * 1024 * 1024) throw IOException("Invalid file size")
      val body = object : RequestBody() {
        override fun contentType() = "application/octet-stream".toMediaType()
        override fun contentLength() = length
        override fun writeTo(sink: BufferedSink) {
          var sent = 0L
          var announced = 0L
          val bytes = ByteArray(256 * 1024)
          file.inputStream().use { input ->
            while (true) {
              if (cancelled.contains(id)) throw IOException("Upload cancelled")
              val count = input.read(bytes)
              if (count < 0) break
              sink.write(bytes, 0, count)
              sent += count
              val now = System.nanoTime()
              if (now - announced > 200_000_000 || sent == length) {
                sendEvent("progress", mapOf("id" to id, "fraction" to sent.toDouble() / length))
                announced = now
              }
            }
          }
        }
      }
      val request = Request.Builder().url(url).put(body).apply { headers.forEach { (key, value) -> header(key, value) } }.build()
      val call = client.newCall(request)
      transfers[id] = call
      try {
        if (cancelled.contains(id)) call.cancel()
        call.execute().use { response ->
          val input = response.body?.byteStream() ?: throw IOException("Missing response")
          // Success/error DTOs are small; never buffer an unbounded remote body.
          val out = java.io.ByteArrayOutputStream()
          val buffer = ByteArray(4096)
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (out.size() + count > 32 * 1024) throw IOException("Oversized upload response")
            out.write(buffer, 0, count)
          }
          mapOf("status" to response.code, "body" to out.toByteArray().toString(Charsets.UTF_8))
        }
      } finally {
        transfers.remove(id)
        cancelled.remove(id)
      }
    }.runOnQueue(uploadsScope)
    OnDestroy { transfers.values.forEach { it.cancel() }; transfers.clear(); cancelled.clear(); uploadsScope.cancel() }
  }
}
