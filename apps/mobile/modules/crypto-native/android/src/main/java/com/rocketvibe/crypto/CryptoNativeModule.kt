package com.rocketvibe.crypto

import com.rocketvibe.crypto.engine.CryptoAccount
import com.rocketvibe.crypto.engine.CryptoBridgeException
import com.rocketvibe.crypto.engine.CryptoInstallation
import com.rocketvibe.crypto.engine.InstallationStatus
import com.rocketvibe.crypto.engine.IdentityStatus
import com.rocketvibe.crypto.engine.IdentityApproval
import com.rocketvibe.crypto.engine.PeerApproval
import com.rocketvibe.crypto.engine.PeerReview
import com.rocketvibe.crypto.engine.openFile
import com.rocketvibe.crypto.engine.sealFile
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
  private fun identityDto(status: IdentityStatus) = mapOf(
    "phase" to status.phase.name.lowercase(),
    "rootFingerprint" to status.rootFingerprint, "remoteFingerprint" to status.remoteFingerprint,
    "requestFingerprint" to status.requestFingerprint, "requestCode" to status.requestCode,
    "controlsRoot" to status.controlsRoot,
    "certificateExpiresAt" to status.certificateExpiresAt,
  )
  private fun approvalDto(value: IdentityApproval) = mapOf(
    "id" to value.id, "rootFingerprint" to value.rootFingerprint,
    "requestFingerprint" to value.requestFingerprint, "device" to value.device, "expiresAt" to value.expiresAt,
  )
  private fun peerDto(value: PeerReview) = mapOf("id" to value.id, "statusJson" to value.statusJson)
  private fun peerApprovalDto(value: PeerApproval) = mapOf(
    "id" to value.id, "user" to value.user, "rootFingerprint" to value.rootFingerprint,
    "device" to value.device, "fingerprint" to value.fingerprint, "incarnation" to value.incarnation, "expiresAt" to value.expiresAt,
  )

  /** A private file of the app, given as a `file://` URI; never a content provider. */
  private fun localPath(uri: String): String {
    val parsed = android.net.Uri.parse(uri)
    if (parsed.scheme != "file") throw CryptoBridgeException.Integrity()
    return parsed.path ?: throw CryptoBridgeException.Integrity()
  }

  override fun definition() = ModuleDefinition {
    Name("CryptoNative")
    // Encrypted files (E2EE_FILES.md): stateless, streamed in Rust, off the main thread.
    AsyncFunction("sealFile") { source: String, target: String ->
      sealFile(localPath(source), localPath(target))
    }
    AsyncFunction("openFile") { key: String, bytes: String, sha256: String, source: String, target: String ->
      openFile(key, bytes, sha256, localPath(source), localPath(target))
    }
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
    AsyncFunction("peerView") { handle: String, own: String, user: String, peer: String -> synchronized(lock) {
      peerDto(view(handle).peerView(own, user, peer))
    } }
    AsyncFunction("peerPin") { handle: String, own: String, peer: String, id: String, choice: String, confirmed: String, old: String -> synchronized(lock) {
      peerDto(view(handle).peerPin(own, peer, id, choice, confirmed, old))
    } }
    AsyncFunction("peerPreview") { handle: String, own: String, peer: String, id: String, device: String -> synchronized(lock) {
      peerApprovalDto(view(handle).peerPreview(own, peer, id, device))
    } }
    AsyncFunction("peerApprove") { handle: String, own: String, peer: String, id: String -> synchronized(lock) {
      peerDto(view(handle).peerApprove(own, peer, id))
    } }
    AsyncFunction("identityView") { handle: String, directory: String -> synchronized(lock) {
      identityDto(view(handle).identityView(directory))
    } }
    AsyncFunction("withdrawalAction") { handle: String, directory: String, input: String -> synchronized(lock) {
      view(handle).withdrawalAction(directory, input)
    } }
    AsyncFunction("recoveryAction") { handle: String, directory: String, input: String -> synchronized(lock) {
      view(handle).recoveryAction(directory, input)
    } }
    AsyncFunction("historyBackupAction") { handle: String, directory: String, input: String -> synchronized(lock) {
      view(handle).historyBackupAction(directory, input)
    } }
    AsyncFunction("historyAction") { handle: String, directory: String, input: String -> synchronized(lock) {
      view(handle).historyAction(directory, input)
    } }
    AsyncFunction("groupAction") { handle: String, directory: String, input: String -> synchronized(lock) {
      view(handle).groupAction(directory, input)
    } }
    AsyncFunction("conversationAction") { handle: String, directory: String, input: String -> synchronized(lock) {
      view(handle).conversationAction(directory, input)
    } }
    AsyncFunction("identityBegin") { handle: String, directory: String, expectedRoot: String -> synchronized(lock) {
      identityDto(view(handle).identityBegin(directory, expectedRoot))
    } }
    AsyncFunction("identityRenew") { handle: String, directory: String, expectedRoot: String -> synchronized(lock) {
      identityDto(view(handle).identityRenew(directory, expectedRoot))
    } }
    AsyncFunction("identityPreview") { handle: String, directory: String, request: String -> synchronized(lock) {
      approvalDto(view(handle).identityPreview(directory, request))
    } }
    AsyncFunction("identityApprove") { handle: String, directory: String, id: String -> synchronized(lock) {
      view(handle).identityApprove(directory, id)
    } }
    AsyncFunction("identityInstall") { handle: String, directory: String, grant: String -> synchronized(lock) {
      identityDto(view(handle).identityInstall(directory, grant))
    } }
    AsyncFunction("identityPending") { handle: String, directory: String -> synchronized(lock) {
      view(handle).identityPending(directory)
    } }
    AsyncFunction("identityAcknowledge") { handle: String, directory: String, receipt: String -> synchronized(lock) {
      identityDto(view(handle).identityAcknowledge(directory, receipt))
    } }
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
