package com.rocketvibe.crypto

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.AtomicFile
import com.rocketvibe.crypto.engine.CryptoBridgeException
import com.rocketvibe.crypto.engine.ProtectedKeystore
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Non-exportable Android key wraps the private engine's small platform records.
 * The wrapping blobs live outside the coffer, in noBackupFilesDir. No method is
 * exported to JS. Locked, corrupt or missing existing keys always fail closed.
 */
internal class AndroidProtectedKeystore(private val directory: File) : ProtectedKeystore {
  companion object {
    private const val ALIAS = "rocketvibe.crypto.platform.v1"
    private const val MAX_RECORD = 4096
    private val processLock = Any()

    fun privateDirectory(directory: File): File {
      if (!directory.exists() && !directory.mkdirs()) throw IOException("crypto_storage_unavailable")
      val stat = Os.lstat(directory.absolutePath)
      if (!OsConstants.S_ISDIR(stat.st_mode)) throw IOException("crypto_storage_unavailable")
      Os.chmod(directory.absolutePath, 0x1c0) // 0700
      return directory
    }
  }

  init { privateDirectory(directory) }

  private fun exists(file: File): Boolean = try {
    val stat = Os.lstat(file.absolutePath)
    if (!OsConstants.S_ISREG(stat.st_mode)) throw IOException("crypto_storage_unavailable")
    true
  } catch (error: ErrnoException) {
    if (error.errno == OsConstants.ENOENT) false else throw error
  }

  private fun file(name: String): File {
    if (!Regex("native-crypto-(installation-)?[0-9a-f]{64}").matches(name)) {
      throw IOException("crypto_storage_unavailable")
    }
    val hash = MessageDigest.getInstance("SHA-256").digest(name.toByteArray(Charsets.UTF_8))
    return File(directory, hash.joinToString("") { "%02x".format(it) } + ".sealed")
  }

  private fun key(allowCreate: Boolean): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    if (store.containsAlias(ALIAS)) {
      return store.getKey(ALIAS, null) as? SecretKey ?: throw IOException("crypto_storage_unavailable")
    }
    val files = directory.listFiles() ?: throw IOException("crypto_storage_unavailable")
    if (!allowCreate || files.any { it.name.contains(".sealed") }) {
      throw IOException("crypto_storage_unavailable")
    }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true).setKeySize(256).build())
    }.generateKey()
  }

  // Finish the real platform IO synchronously before returning to Rust's lease.
  // A file lock also serializes key creation and AtomicFile recovery across app processes.
  private fun <T> guarded(operation: () -> T): T = synchronized(processLock) {
    try {
      RandomAccessFile(File(directory, "platform.lock"), "rw").use { lock ->
        Os.chmod(File(directory, "platform.lock").absolutePath, 0x180) // 0600
        lock.channel.lock().use { operation() }
      }
    } catch (error: Exception) {
      // Never expose platform diagnostics or interpret failure as absence.
      throw CryptoBridgeException.Storage().apply { initCause(error) }
    }
  }

  private fun aad(name: String) = ("rocketvibe-android-keystore-v1\u0000" + name).toByteArray(Charsets.UTF_8)

  private fun sealedRecord(base: File): ByteArray = AtomicFile(base).openRead().use { input ->
    val bytes = ByteArray(MAX_RECORD + 30)
    var length = 0
    while (length < bytes.size) {
      val count = input.read(bytes, length, bytes.size - length)
      if (count < 0) break
      length += count
    }
    if (length == bytes.size || input.read() != -1) throw IOException("crypto_storage_unavailable")
    bytes.copyOf(length).also { bytes.fill(0) }
  }

  override fun read(name: String): ByteArray? = guarded {
    val base = file(name)
    val present = exists(base)
    val backup = exists(File(base.path + ".bak"))
    val pending = exists(File(base.path + ".new"))
    if (!present && !backup) {
      if (pending) throw IOException("crypto_storage_unavailable")
      return@guarded null
    }
    val record = sealedRecord(base)
    try {
      if (record.size < 29 || record[0] != 1.toByte()) throw IOException("crypto_storage_unavailable")
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, record.copyOfRange(1, 13)))
      cipher.updateAAD(aad(name))
      cipher.doFinal(record, 13, record.size - 13).also {
        if (it.size > MAX_RECORD) { it.fill(0); throw IOException("crypto_storage_unavailable") }
      }
    } finally { record.fill(0) }
  }

  override fun write(name: String, value: ByteArray) = guarded {
    try {
      if (value.size > MAX_RECORD) throw IOException("crypto_storage_unavailable")
      val base = file(name)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key(true))
      if (cipher.iv.size != 12) throw IOException("crypto_storage_unavailable")
      cipher.updateAAD(aad(name))
      val encrypted = cipher.doFinal(value)
      val bytes = ByteBuffer.allocate(13 + encrypted.size).put(1.toByte()).put(cipher.iv).put(encrypted).array()
      try {
        val atomic = AtomicFile(base)
        val out = atomic.startWrite()
        try {
          val pending = File(base.path + ".new")
          Os.chmod(if (exists(pending)) pending.absolutePath else base.absolutePath, 0x180)
          out.write(bytes)
          out.fd.sync() // AtomicFile alone only logs some sync failures.
          atomic.finishWrite(out)
        } catch (error: Exception) {
          atomic.failWrite(out)
          throw error
        }
        // Persist the rename before Rust releases its lease. A failure here is
        // ambiguous and must not undo the already published AtomicFile record.
        val fd = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
        try { Os.fsync(fd) } finally { Os.close(fd) }
        val published = sealedRecord(base)
        try {
          if (!published.contentEquals(bytes)) throw IOException("crypto_storage_unavailable")
        } finally { published.fill(0) }
      } finally { encrypted.fill(0); bytes.fill(0) }
    } finally { value.fill(0) }
  }
}
