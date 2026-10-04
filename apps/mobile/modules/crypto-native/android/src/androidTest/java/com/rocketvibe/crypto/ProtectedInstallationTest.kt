package com.rocketvibe.crypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.rocketvibe.crypto.engine.CryptoAccount
import com.rocketvibe.crypto.engine.CryptoBridgeException
import com.rocketvibe.crypto.engine.CryptoInstallation
import com.rocketvibe.crypto.engine.InstallationPhase
import com.rocketvibe.crypto.engine.ProtectedKeystore
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Uses the real Android Keystore, generated Kotlin/JNA ABI and Rust vault.
 * Runs in the isolated instrumentation app, never against a user's account.
 */
@RunWith(AndroidJUnit4::class)
class ProtectedInstallationTest {
  private fun refused(action: () -> Unit) {
    try { action(); fail("A changed, inaccessible or retired coffer must be refused") }
    catch (_: CryptoBridgeException) { }
  }

  @Test fun realKeystoreReopensOriginalCofferAndRefusesCopiedRetiredOrCorruptRecords() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = AndroidProtectedKeystore.privateDirectory(File(context.noBackupFilesDir, "crypto-test-" + UUID.randomUUID()))
    val directory = AndroidProtectedKeystore.privateDirectory(File(root, "coffer"))
    val copy = AndroidProtectedKeystore.privateDirectory(File(root, "copy"))
    val platform = File(root, "platform")
    val keystore = AndroidProtectedKeystore(platform)
    val account = CryptoAccount("https://crypto.example.org", "test-instance", "test-epoch", "alice", UUID.randomUUID().toString())
    val first = CryptoInstallation.open(directory.absolutePath, account, keystore)
    var reopened: CryptoInstallation? = null
    var copied: CryptoInstallation? = null
    try {
      assertNull(keystore.read("native-crypto-installation-" + "00".repeat(32)))
      val absent = first.status()
      assertEquals(InstallationPhase.MISSING, absent.phase)
      assertTrue(platform.listFiles()!!.none { it.name.contains(".sealed") })
      refused { first.initialize("00".repeat(32)) }
      val ready = first.initialize(absent.accountFingerprint)
      assertEquals(InstallationPhase.READY, ready.phase)
      assertEquals(32, ready.incarnation.length)
      // Neither the selection nor protected anchor is persisted as plaintext.
      val blobs = platform.listFiles()!!.filter { it.name.endsWith(".sealed") }
      assertTrue(blobs.size >= 2)
      assertTrue(blobs.none { it.readBytes().toString(Charsets.UTF_8).contains("test-instance") })
      first.stop()
      refused { first.status() }
      reopened = CryptoInstallation.open(directory.absolutePath, account, AndroidProtectedKeystore(platform))
      assertEquals(ready.incarnation, reopened.status().incarnation)
      copied = CryptoInstallation.open(copy.absolutePath, account, keystore)
      refused { copied.status() }
      val broken = blobs.first()
      val original = broken.readBytes()
      broken.writeBytes(original.copyOf().apply { this[lastIndex] = (this[lastIndex].toInt() xor 1).toByte() })
      refused { reopened.status() }
      refused { reopened.initialize(ready.accountFingerprint) }
      broken.writeBytes(original)
      reopened.retire(ready.accountFingerprint)
      assertTrue(reopened.isClosed())
      val afterRetirement = CryptoInstallation.open(directory.absolutePath, account, keystore)
      try { refused { afterRetirement.status() }; refused { afterRetirement.initialize(ready.accountFingerprint) } }
      finally { afterRetirement.stop(); afterRetirement.destroy() }
    } finally {
      first.stop(); first.destroy()
      reopened?.let { it.stop(); it.destroy() }
      copied?.let { it.stop(); it.destroy() }
      root.deleteRecursively()
    }
  }

  @Test fun closedCallerKeepsTheKernelLeaseUntilTheActualPlatformWriteFinishes() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = AndroidProtectedKeystore.privateDirectory(File(context.noBackupFilesDir, "crypto-lease-test-" + UUID.randomUUID()))
    val directory = AndroidProtectedKeystore.privateDirectory(File(root, "coffer"))
    val platform = AndroidProtectedKeystore(File(root, "platform"))
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val delayed = object : ProtectedKeystore {
      override fun read(name: String) = platform.read(name)
      override fun write(name: String, value: ByteArray) {
        entered.countDown()
        check(release.await(10, TimeUnit.SECONDS))
        platform.write(name, value)
      }
    }
    val account = CryptoAccount("https://crypto.example.org", "test-instance", "test-epoch", "alice", UUID.randomUUID().toString())
    val first = CryptoInstallation.open(directory.absolutePath, account, delayed)
    val second = CryptoInstallation.open(directory.absolutePath, account, platform)
    val executor = Executors.newSingleThreadExecutor()
    try {
      val status = first.status()
      val writing = executor.submit<Boolean> {
        try { first.initialize(status.accountFingerprint); false }
        catch (_: CryptoBridgeException.Closed) { true }
      }
      assertTrue(entered.await(5, TimeUnit.SECONDS))
      first.stop()
      refused { second.status() } // The unfinished platform write still owns the Rust lease.
      release.countDown()
      assertTrue(writing.get(10, TimeUnit.SECONDS))
      val durable = second.status()
      assertEquals(InstallationPhase.READY, durable.phase)
      assertEquals(durable.incarnation, second.initialize(status.accountFingerprint).incarnation)
    } finally {
      release.countDown()
      executor.shutdown()
      assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS))
      first.stop(); first.destroy(); second.stop(); second.destroy()
      root.deleteRecursively()
    }
  }
}
