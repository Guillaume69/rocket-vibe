package com.rocketvibe.updater

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import org.junit.Assert.*
import org.junit.Test

class VerifiedDownloadTest {
  private val bytes = ByteArray(200000) { (it % 127).toByte() }
  private fun digest(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value)
    .joinToString("") { "%02x".format(it.toInt() and 255) }
  private fun rejects(block: () -> Unit) {
    try { block(); fail("An invalid APK must be rejected") }
    catch (error: UpdateFailure) { assertEquals("integrity", error.reason) }
  }
  @Test fun streamsAndVerifiesWithoutReadingWholeApkAtOnce() {
    val output = ByteArrayOutputStream()
    val progress = mutableListOf<Long>()
    VerifiedDownload.copy(ByteArrayInputStream(bytes), output, bytes.size.toLong(), digest(bytes), {}, { progress.add(it) })
    assertArrayEquals(bytes, output.toByteArray())
    assertTrue(progress.size > 1)
    assertEquals(bytes.size.toLong(), progress.last())
  }
  @Test fun rejectsTruncatedDownload() {
    rejects { VerifiedDownload.copy(ByteArrayInputStream(bytes.copyOf(100)), null, bytes.size.toLong(), digest(bytes), {}) }
  }
  @Test fun rejectsDigestMismatchEvenWhenSizeMatches() {
    rejects { VerifiedDownload.copy(ByteArrayInputStream(bytes), null, bytes.size.toLong(), "0".repeat(64), {}) }
  }
  @Test fun refusesOversizedBodyBeforeWritingPastExpectedSize() {
    val output = ByteArrayOutputStream()
    rejects { VerifiedDownload.copy(ByteArrayInputStream(bytes), output, 100, digest(bytes), {}) }
    assertEquals(0, output.size())
  }
  @Test fun checksCancellationBetweenChunksAndBeforeAcceptingCompletion() {
    var checks = 0
    try {
      VerifiedDownload.copy(ByteArrayInputStream(bytes), null, bytes.size.toLong(), digest(bytes), {
        if (++checks == 2) throw UpdateFailure("cancelled")
      })
      fail("Cancelled downloads must never become ready")
    } catch (error: UpdateFailure) { assertEquals("cancelled", error.reason) }
    assertEquals(2, checks)
  }
  @Test fun stagedFilesAreReverifiedWithoutCopying() {
    VerifiedDownload.copy(ByteArrayInputStream(bytes), null, bytes.size.toLong(), digest(bytes), {})
  }
}
