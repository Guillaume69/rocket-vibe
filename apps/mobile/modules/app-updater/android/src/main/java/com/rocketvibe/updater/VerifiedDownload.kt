package com.rocketvibe.updater

import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

internal class UpdateFailure(val reason: String) : Exception(reason)

/** Stream verification shared by fresh downloads and staged APK revalidation. */
internal object VerifiedDownload {
  fun copy(input: InputStream, output: OutputStream?, expected: Long, digest: String,
    check: () -> Unit, progress: (Long) -> Unit = {}) {
    val hash = MessageDigest.getInstance("SHA-256")
    var received = 0L
    val buffer = ByteArray(64 * 1024)
    while (true) {
      check()
      val count = input.read(buffer)
      if (count == -1) break
      received += count
      if (received > expected) throw UpdateFailure("integrity")
      output?.write(buffer, 0, count)
      hash.update(buffer, 0, count)
      progress(received)
    }
    check()
    val actual = hash.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    if (received != expected || actual != digest) throw UpdateFailure("integrity")
  }
}
