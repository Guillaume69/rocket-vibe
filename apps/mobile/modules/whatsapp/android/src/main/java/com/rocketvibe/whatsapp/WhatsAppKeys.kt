package com.rocketvibe.whatsapp

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.io.IOException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Each account's 32-byte state key, wrapped by a non-exportable Android key,
 * in noBackupFilesDir: a state restored elsewhere fails closed. The key never
 * reaches JS. */
internal object WhatsAppKeys {
  private const val ALIAS = "rocketvibe.whatsapp.state.v1"
  private const val IV = 12

  private fun file(context: Context, state: String) = File(WhatsAppEngines.directory(context), "$state.key")

  private fun wrapping(create: Boolean): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    if (!create) throw IOException("whatsapp_key_missing")
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(
        KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .build()
      )
    }.generateKey()
  }

  /** The state's key; created only for a state that does not exist yet. */
  @Synchronized
  fun key(context: Context, state: String, create: Boolean): ByteArray {
    val stored = file(context, state)
    if (stored.exists()) {
      val sealed = AtomicFile(stored).readFully()
      if (sealed.size <= IV) throw IOException("whatsapp_key_missing")
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, wrapping(false), GCMParameterSpec(128, sealed, 0, IV))
      return cipher.doFinal(sealed, IV, sealed.size - IV)
    }
    if (!create) throw IOException("whatsapp_key_missing")
    val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, wrapping(true))
    val sealed = cipher.iv + cipher.doFinal(key)
    val atomic = AtomicFile(stored)
    val out = atomic.startWrite()
    try {
      out.write(sealed)
      atomic.finishWrite(out)
    } catch (error: IOException) {
      atomic.failWrite(out)
      throw error
    }
    return key
  }

  @Synchronized
  fun forget(context: Context, state: String) {
    AtomicFile(file(context, state)).delete()
  }
}
