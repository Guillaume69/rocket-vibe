package com.rocketvibe.crypto

import com.rocketvibe.crypto.engine.CryptoAccount
import com.rocketvibe.crypto.engine.CryptoBridgeException
import com.rocketvibe.crypto.engine.CryptoInstallation
import com.rocketvibe.crypto.engine.InstallationStatus
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.UUID

class CryptoNativeModule : Module() {
  private val lock = Any()
  private val views = mutableMapOf<String, CryptoInstallation>()
  private var stopped = false

  private fun view(handle: String): CryptoInstallation {
    if (stopped) throw CryptoBridgeException.Closed()
    return views[handle] ?: throw CryptoBridgeException.Closed()
  }

  private fun dto(status: InstallationStatus) = mapOf(
    "phase" to status.phase.name.lowercase(),
    "accountFingerprint" to status.accountFingerprint,
    "incarnation" to status.incarnation,
  )

  override fun definition() = ModuleDefinition {
    Name("CryptoNative")
    AsyncFunction("open") { scope: Map<String, String> -> synchronized(lock) {
      if (stopped || views.size >= 16) throw CryptoBridgeException.Closed()
      if (scope.keys != setOf("origin", "instance", "dataEpoch", "user", "device")) throw CryptoBridgeException.Changed()
      val context = appContext.reactContext ?: throw CryptoBridgeException.Closed()
      val root = AndroidProtectedKeystore.privateDirectory(File(context.noBackupFilesDir, "rocketvibe-crypto"))
      val coffer = AndroidProtectedKeystore.privateDirectory(File(root, "coffers"))
      val account = CryptoAccount(scope.getValue("origin"), scope.getValue("instance"), scope.getValue("dataEpoch"),
        scope.getValue("user"), scope.getValue("device"))
      val instance = CryptoInstallation.open(coffer.absolutePath, account, AndroidProtectedKeystore(File(root, "platform")))
      try {
        val status = instance.status()
        val handle = UUID.randomUUID().toString()
        views[handle] = instance
        dto(status) + ("handle" to handle)
      } catch (error: Exception) { instance.stop(); instance.destroy(); throw error }
    } }
    AsyncFunction("status") { handle: String -> synchronized(lock) { dto(view(handle).status()) } }
    AsyncFunction("initialize") { handle: String, fingerprint: String -> synchronized(lock) {
      dto(view(handle).initialize(fingerprint))
    } }
    AsyncFunction("retire") { handle: String, fingerprint: String -> synchronized(lock) {
      val instance = view(handle)
      instance.retire(fingerprint)
      views.remove(handle)
      instance.destroy()
    } }
    AsyncFunction("close") { handle: String -> synchronized(lock) {
      views.remove(handle)?.let { it.stop(); it.destroy() }
      Unit
    } }
    OnDestroy { synchronized(lock) {
      stopped = true
      views.values.forEach { it.stop(); it.destroy() }
      views.clear()
    } }
  }
}
