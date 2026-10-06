package com.rocketvibe.crypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.rocketvibe.crypto.engine.CryptoAccount
import com.rocketvibe.crypto.engine.CryptoBridgeException
import com.rocketvibe.crypto.engine.CryptoInstallation
import com.rocketvibe.crypto.engine.InstallationPhase
import com.rocketvibe.crypto.engine.IdentityPhase
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
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
  /** The id the server derives for an accepted message (E2EE_MESSAGES.md). */
  private fun acceptedId(fingerprint: String): String {
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    digest.update("rocketvibe-mls-message-id-v1\u0000".toByteArray(Charsets.UTF_8))
    digest.update(fingerprint.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
    return digest.digest().copyOf(16).joinToString("") { "%02x".format(it.toInt() and 255) }
  }
  private fun refused(action: () -> Unit) {
    try { action(); fail("A changed, inaccessible or retired coffer must be refused") }
    catch (_: CryptoBridgeException) { }
  }
  private fun enroll(installation: CryptoInstallation, account: CryptoAccount): String {
    val scope = JSONObject().put("instance_id", account.instance).put("data_epoch", account.dataEpoch)
    val wire = JSONObject().put("scope", scope).put("identity", JSONObject.NULL).put("devices", JSONArray())
      .put("revocations", JSONArray()).put("next_revocation", JSONObject.NULL)
    val created = installation.identityBegin(wire.toString(), "")
    val preview = installation.identityPreview(wire.toString(), created.requestCode)
    val grant = installation.identityApprove(wire.toString(), preview.id)
    installation.identityInstall(wire.toString(), grant)
    val registration = JSONObject(installation.identityPending(wire.toString()))
    val flags = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
    val certificate = JSONObject(String(Base64.decode(registration.getString("grant"), flags), Charsets.UTF_8)).getJSONObject("certificate")
    val device = certificate.getJSONObject("device")
    fun encode(value: JSONObject) = Base64.encodeToString(value.toString().toByteArray(Charsets.UTF_8), flags)
    val incarnation = installation.status().incarnation
    wire.put("identity", JSONObject().put("user_id", account.user).put("root", encode(device.getJSONObject("root")))
      .put("fingerprint", created.rootFingerprint).put("revision", "1"))
    wire.put("devices", JSONArray().put(JSONObject().put("device_id", account.device).put("incarnation", incarnation)
      .put("certificate", encode(certificate)).put("revision", "1").put("expires_at", device.getString("expires_at"))))
    val receipt = JSONObject().put("scope", scope).put("operation_id", registration.getString("operation_id"))
      .put("kind", "register_device").put("device_id", account.device).put("incarnation", incarnation)
      .put("device_revision", "1").put("root_fingerprint", created.rootFingerprint).put("key_package_refs", JSONArray())
    assertEquals(IdentityPhase.READY, installation.identityAcknowledge(wire.toString(), receipt.toString()).phase)
    return wire.toString()
  }

  @Test fun actualMlsGroupAndPrivateConversationKeepOriginalsAcrossReopen() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = AndroidProtectedKeystore.privateDirectory(File(context.noBackupFilesDir, "crypto-group-test-" + UUID.randomUUID()))
    val directory = AndroidProtectedKeystore.privateDirectory(File(root, "coffer"))
    val platform = File(root, "platform")
    val account = CryptoAccount("https://crypto.example.org", "test-instance", "test-epoch", "alice", UUID.randomUUID().toString())
    var installation = CryptoInstallation.open(directory.absolutePath, account, AndroidProtectedKeystore(platform))
    try {
      val own = enroll(installation, account)
      val scope = JSONObject().put("instance_id", account.instance).put("data_epoch", account.dataEpoch)
      val roster = JSONObject().put("scope", scope).put("room_id", "room").put("authority_version", "authority")
        .put("members", JSONArray().put(JSONObject().put("user_id", account.user).put("access_version", "access").put("activation_version", "active")))
        .put("group", JSONObject.NULL)
      fun command(action: String) = JSONObject().put("action", action)
      fun call(input: JSONObject) = installation.groupAction(own, input.toString())
      fun preview() = JSONObject(call(command("preview").put("roster", roster).put("packages", JSONArray()).put("removals", JSONArray()).put("event", JSONObject.NULL)))
      fun confirm(value: JSONObject, current: JSONObject = roster) = call(command("confirm").put("roster", current)
        .put("id", value.getString("id")).put("fingerprint", value.getString("fingerprint")))
      assertTrue(JSONObject(call(command("view").put("roster", roster))).isNull("accepted"))
      var consent = preview()
      assertEquals("null", call(command("pending").put("room", "room")))
      assertEquals(1, consent.getJSONArray("recipients").length())
      val changed = JSONObject(roster.toString())
      changed.getJSONArray("members").getJSONObject(0).put("access_version", "new-access")
      refused { confirm(consent, changed) }
      consent = preview(); confirm(consent)
      val original = call(command("retry").put("room", "room"))
      installation.stop(); installation.destroy()
      installation = CryptoInstallation.open(directory.absolutePath, account, AndroidProtectedKeystore(platform))
      assertEquals(original, call(command("retry").put("room", "room")))
      val packet = JSONObject(original)
      val flags = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
      val plan = JSONObject(String(Base64.decode(packet.getString("transition"), flags), Charsets.UTF_8)).getJSONObject("plan")
      val pending = JSONObject(call(command("pending").put("room", "room")))
      val incarnation = plan.getJSONObject("scope").getJSONArray("incarnation").let { bytes ->
        (0 until bytes.length()).joinToString("") { "%02x".format(bytes.getInt(it)) }
      }
      val receipt = JSONObject().put("scope", scope).put("room_id", "room").put("incarnation", incarnation)
        .put("operation_id", packet.getString("operation_id")).put("revision", (plan.getLong("expected_revision") + 1).toString())
        .put("epoch", plan.getLong("epoch").toString()).put("fingerprint", pending.getString("fingerprint"))
      val wrong = JSONObject(receipt.toString()).put("fingerprint", "00".repeat(32))
      refused { call(command("acknowledge").put("room", "room").put("receipt", wrong)) }
      call(command("acknowledge").put("room", "room").put("receipt", receipt))
      roster.put("group", receipt)
      assertEquals(receipt.getString("fingerprint"), JSONObject(call(command("view").put("roster", roster))).getJSONObject("accepted").getString("fingerprint"))
      val state = JSONObject().put("receipt", receipt).put("needs_rekey", false)
        .put("transition", packet.getString("transition")).put("tree", packet.getString("tree"))
      fun conversation(action: JSONObject, thread: String? = null): String = installation.conversationAction(own,
        JSONObject().put("roster", roster).put("state", state).put("thread", thread ?: JSONObject.NULL).put("command", action).toString())
      val genesis = JSONObject().put("receipt", receipt).put("transition", packet.getString("transition"))
        .put("commit", JSONObject.NULL).put("welcome", JSONObject.NULL)
      val page = JSONObject().put("scope", scope).put("room_id", "room").put("incarnation", incarnation)
        .put("after", "0").put("through", "1").put("next", JSONObject.NULL)
        .put("events", JSONArray().put(JSONObject().put("position", "1").put("content", JSONObject().put("kind", "group").put("data", genesis))))
      conversation(command("receive").put("page", page))
      assertTrue(JSONObject(conversation(command("view").put("before", JSONObject.NULL).put("limit", 200))).getBoolean("can_send"))
      conversation(command("draft").put("text", "private Android draft"))
      conversation(command("draft").put("text", "private thread draft"), "root")
      val prepared = JSONObject(conversation(command("prepare").put("text", "private Android draft")))
      val operation = prepared.getString("operation")
      val originalMessage = conversation(command("retry").put("operation", operation))
      assertFalse(originalMessage.contains("private Android draft"))
      installation.stop(); installation.destroy()
      installation = CryptoInstallation.open(directory.absolutePath, account, AndroidProtectedKeystore(platform))
      assertEquals(originalMessage, conversation(command("retry").put("operation", operation)))
      assertEquals("\"private Android draft\"", conversation(command("draft").put("text", JSONObject.NULL)))
      assertEquals("\"private thread draft\"", conversation(command("draft").put("text", JSONObject.NULL), "root"))
      val message = JSONObject(originalMessage)
      val proofBytes = Base64.decode(message.getString("proof"), flags)
      val proof = JSONObject(String(proofBytes, Charsets.UTF_8))
      val digest = java.security.MessageDigest.getInstance("SHA-256")
      digest.update("rocketvibe-mls-application-fingerprint-v1\u0000".toByteArray(Charsets.UTF_8))
      val messageFingerprint = digest.digest(proofBytes).joinToString("") { "%02x".format(it.toInt() and 255) }
      val messageId = acceptedId(messageFingerprint)
      val header = Base64.encodeToString(proof.getJSONObject("header").toString().toByteArray(Charsets.UTF_8), flags)
      val messageReceipt = JSONObject().put("scope", scope).put("room_id", "room").put("operation_id", operation)
        .put("header", header).put("fingerprint", messageFingerprint).put("message_id", messageId).put("position", "9007199254740993")
      refused { conversation(command("acknowledge").put("receipt", JSONObject(messageReceipt.toString()).put("fingerprint", "00".repeat(32)))) }
      conversation(command("acknowledge").put("receipt", messageReceipt))
      assertEquals("\"\"", conversation(command("draft").put("text", JSONObject.NULL)))
      val delivered = JSONObject().put("receipt", messageReceipt).put("proof", message.getString("proof")).put("ciphertext", message.getString("ciphertext"))
      page.put("after", "1").put("through", "9007199254740993")
        .put("events", JSONArray().put(JSONObject().put("position", "9007199254740993").put("content", JSONObject().put("kind", "message").put("data", delivered))))
      conversation(command("receive").put("page", page))
      val projected = JSONObject(conversation(command("view").put("before", JSONObject.NULL).put("limit", 200)))
      assertEquals(1, projected.getJSONArray("messages").length())
      assertEquals("private Android draft", projected.getJSONArray("messages").getJSONObject(0).getJSONObject("document").getString("text"))
      assertEquals("9007199254740993", projected.getJSONArray("messages").getJSONObject(0).getString("position"))
      val thread = JSONObject(conversation(command("view").put("before", JSONObject.NULL).put("limit", 200), messageId))
      assertTrue(thread.getBoolean("can_send"))
      assertEquals(messageId, thread.getJSONObject("root").getString("id"))
      assertFalse(JSONObject(conversation(command("view").put("before", JSONObject.NULL).put("limit", 200), "missing-root")).getBoolean("can_send"))
      refused { conversation(command("prepare").put("text", "wrong thread"), "missing-root") }
      conversation(command("draft").put("text", "private Android thread reply"), messageId)
      val replyOperation = JSONObject(conversation(command("prepare").put("text", "private Android thread reply"), messageId)).getString("operation")
      val replyOriginal = conversation(command("retry").put("operation", replyOperation), messageId)
      installation.stop(); installation.destroy()
      installation = CryptoInstallation.open(directory.absolutePath, account, AndroidProtectedKeystore(platform))
      assertEquals(replyOriginal, conversation(command("retry").put("operation", replyOperation), messageId))
      assertEquals("\"private Android thread reply\"", conversation(command("draft").put("text", JSONObject.NULL), messageId))
      assertEquals("\"\"", conversation(command("draft").put("text", JSONObject.NULL)))
      val replyMessage = JSONObject(replyOriginal)
      val replyProofBytes = Base64.decode(replyMessage.getString("proof"), flags)
      val replyProof = JSONObject(String(replyProofBytes, Charsets.UTF_8))
      assertEquals(messageId, replyProof.getJSONObject("header").getString("thread"))
      digest.reset()
      digest.update("rocketvibe-mls-application-fingerprint-v1\u0000".toByteArray(Charsets.UTF_8))
      val replyFingerprint = digest.digest(replyProofBytes).joinToString("") { "%02x".format(it.toInt() and 255) }
      val replyId = acceptedId(replyFingerprint)
      val replyReceipt = JSONObject().put("scope", scope).put("room_id", "room").put("operation_id", replyOperation)
        .put("header", Base64.encodeToString(replyProof.getJSONObject("header").toString().toByteArray(Charsets.UTF_8), flags))
        .put("fingerprint", replyFingerprint).put("message_id", replyId).put("position", "9007199254740994")
      conversation(command("acknowledge").put("receipt", replyReceipt), messageId)
      val replyDelivered = JSONObject().put("receipt", replyReceipt).put("proof", replyMessage.getString("proof")).put("ciphertext", replyMessage.getString("ciphertext"))
      page.put("after", "9007199254740993").put("through", "9007199254740994")
        .put("events", JSONArray().put(JSONObject().put("position", "9007199254740994").put("content", JSONObject().put("kind", "message").put("data", replyDelivered))))
      conversation(command("receive").put("page", page), messageId)
      val replyView = JSONObject(conversation(command("view").put("before", JSONObject.NULL).put("limit", 200), messageId))
      assertEquals(messageId, replyView.getJSONObject("root").getString("id"))
      assertEquals("private Android thread reply", replyView.getJSONArray("messages").getJSONObject(0).getJSONObject("document").getString("text"))
      assertEquals(1, replyView.getJSONObject("retained_replies").getInt(messageId))
      assertFalse(JSONObject(conversation(command("view").put("before", JSONObject.NULL).put("limit", 200), replyId)).getBoolean("can_send"))
      val sourceRows = JSONObject(conversation(command("sources").put("source", JSONObject.NULL)))
      assertEquals(2, sourceRows.getJSONArray("messages").length())
      val selection = JSONObject(conversation(command("select_quote").put("message", replyId).put("membership", "private-membership")))
      assertEquals("private Android thread reply", selection.getString("text"))
      val selectedQuote = selection.getJSONObject("selection")
      assertEquals("9007199254740994", selectedQuote.getJSONObject("reference").getString("revision"))
      assertEquals(sourceRows.getString("admission"), selectedQuote.getString("crypto_admission"))
      val invalidQuote = JSONObject(selectedQuote.toString()).put("crypto_admission", "00".repeat(32))
      refused { conversation(command("prepare").put("text", "").put("quotes", JSONArray().put(invalidQuote)).put("sources", JSONArray())) }
      val ordinaryReference = JSONObject().put("room_id", "ordinary-room").put("message_id", "ordinary-source").put("revision", "9007199254740998")
      val ordinaryQuote = JSONObject().put("reference", ordinaryReference).put("instance_id", account.instance)
        .put("data_epoch", account.dataEpoch).put("membership_version", "ordinary-grant")
      val ordinarySource = JSONObject().put("room_id", "ordinary-room").put("membership_version", "ordinary-grant").put("references", JSONArray().put(ordinaryReference))
      refused { conversation(command("prepare").put("text", "").put("quotes", JSONArray().put(ordinaryQuote)).put("sources", JSONArray())) }
      val downgradedQuote = JSONObject(selectedQuote.toString()).also { it.remove("crypto_admission") }
      val downgradedSource = JSONObject().put("room_id", "room").put("membership_version", "private-membership")
        .put("references", JSONArray().put(downgradedQuote.getJSONObject("reference")))
      refused { conversation(command("prepare").put("text", "").put("quotes", JSONArray().put(downgradedQuote)).put("public_sources", JSONArray().put(downgradedSource))) }
      val quoteOperation = JSONObject(conversation(command("prepare").put("text", "").put("quotes", JSONArray().put(selectedQuote).put(ordinaryQuote))
        .put("sources", JSONArray()).put("public_sources", JSONArray().put(ordinarySource)))).getString("operation")
      val quoteOriginal = conversation(command("retry").put("operation", quoteOperation))
      assertFalse(quoteOriginal.contains("private Android thread reply"))
      installation.stop(); installation.destroy()
      installation = CryptoInstallation.open(directory.absolutePath, account, AndroidProtectedKeystore(platform))
      assertEquals(quoteOriginal, conversation(command("retry").put("operation", quoteOperation)))
      val quoteMessage = JSONObject(quoteOriginal)
      val quoteProofBytes = Base64.decode(quoteMessage.getString("proof"), flags)
      val quoteProof = JSONObject(String(quoteProofBytes, Charsets.UTF_8))
      digest.reset()
      digest.update("rocketvibe-mls-application-fingerprint-v1\u0000".toByteArray(Charsets.UTF_8))
      val quoteFingerprint = digest.digest(quoteProofBytes).joinToString("") { "%02x".format(it.toInt() and 255) }
      val quoteId = acceptedId(quoteFingerprint)
      val quoteReceipt = JSONObject().put("scope", scope).put("room_id", "room").put("operation_id", quoteOperation)
        .put("header", Base64.encodeToString(quoteProof.getJSONObject("header").toString().toByteArray(Charsets.UTF_8), flags))
        .put("fingerprint", quoteFingerprint).put("message_id", quoteId).put("position", "9007199254740995")
      conversation(command("acknowledge").put("receipt", quoteReceipt))
      val quoteDelivered = JSONObject().put("receipt", quoteReceipt).put("proof", quoteMessage.getString("proof")).put("ciphertext", quoteMessage.getString("ciphertext"))
      page.put("after", "9007199254740994").put("through", "9007199254740995")
        .put("events", JSONArray().put(JSONObject().put("position", "9007199254740995").put("content", JSONObject().put("kind", "message").put("data", quoteDelivered))))
      conversation(command("receive").put("page", page))
      val quoteRows = JSONObject(conversation(command("view").put("before", JSONObject.NULL).put("limit", 200))).getJSONArray("messages")
      val quoteDocument = (0 until quoteRows.length()).map { quoteRows.getJSONObject(it) }.single { it.getString("id") == quoteId }.getJSONObject("document")
      assertEquals("", quoteDocument.getString("text"))
      assertEquals(replyId, quoteDocument.getJSONArray("quotes").getJSONObject(0).getString("message_id"))
      assertEquals("9007199254740994", quoteDocument.getJSONArray("quotes").getJSONObject(0).getString("revision"))
      assertEquals(2, quoteDocument.getJSONArray("quotes").length())
      assertEquals("ordinary-source", quoteDocument.getJSONArray("quotes").getJSONObject(1).getString("message_id"))
      assertEquals("9007199254740998", quoteDocument.getJSONArray("quotes").getJSONObject(1).getString("revision"))
      assertFalse(quoteDocument.toString().contains("private Android thread reply"))
      // Private plaintext is present only in the protected coffer, not in its
      // ciphertext or the platform's encrypted small records.
      root.walkTopDown().filter { it.isFile && !it.name.endsWith(".lock") }.forEach {
        assertFalse(it.readBytes().toString(Charsets.ISO_8859_1).contains("private Android draft"))
        assertFalse(it.readBytes().toString(Charsets.ISO_8859_1).contains("private Android thread reply"))
      }
      consent = preview(); assertEquals("change", consent.getString("kind")); confirm(consent)
      val cancellation = JSONObject(call(command("cancel").put("room", "room")))
      val cancelling = JSONObject(call(command("pending").put("room", "room")))
      assertTrue(cancelling.getBoolean("cancelling"))
      assertEquals(cancelling.getString("operation"), cancellation.getJSONObject("original").getString("operation_id"))
      val decision = JSONObject().put("kind", "cancelled").put("data", JSONObject().put("scope", scope).put("room_id", "room")
        .put("incarnation", incarnation).put("operation_id", cancelling.getString("operation")).put("device_id", account.device)
        .put("fingerprint", cancelling.getString("fingerprint")))
      call(command("settle").put("room", "room").put("settlement", decision))
      assertEquals("null", call(command("pending").put("room", "room")))
    } finally { installation.stop(); installation.destroy(); root.deleteRecursively() }
  }

  @Test fun peerIdentityAndDeviceApprovalPersistInActualAndroidCoffer() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = AndroidProtectedKeystore.privateDirectory(File(context.noBackupFilesDir, "crypto-peer-test-" + UUID.randomUUID()))
    val directory = AndroidProtectedKeystore.privateDirectory(File(root, "coffer"))
    val platform = File(root, "platform")
    val aliceAccount = CryptoAccount("https://crypto.example.org", "test-instance", "test-epoch", "alice", UUID.randomUUID().toString())
    val bobAccount = CryptoAccount("https://crypto.example.org", "test-instance", "test-epoch", "bob", UUID.randomUUID().toString())
    var alice = CryptoInstallation.open(directory.absolutePath, aliceAccount, AndroidProtectedKeystore(platform))
    val bob = CryptoInstallation.open(directory.absolutePath, bobAccount, AndroidProtectedKeystore(platform))
    try {
      val own = enroll(alice, aliceAccount)
      val peer = enroll(bob, bobAccount)
      val initial = alice.peerView(own, bobAccount.user, peer)
      val fingerprint = JSONObject(initial.statusJson).getString("fingerprint")
      assertEquals("unknown", JSONObject(initial.statusJson).getString("trust"))
      refused { alice.peerView(own, "mallory", peer) }
      val pinned = alice.peerPin(own, peer, initial.id, "first_contact", fingerprint, "")
      assertEquals("unverified", JSONObject(pinned.statusJson).getString("trust"))
      val verified = alice.peerPin(own, peer, pinned.id, "verify", fingerprint, fingerprint)
      assertEquals("verified", JSONObject(verified.statusJson).getString("trust"))
      val approval = alice.peerPreview(own, peer, verified.id, bobAccount.device)
      val approved = alice.peerApprove(own, peer, approval.id)
      assertTrue(JSONObject(approved.statusJson).getJSONArray("devices").getJSONObject(0).getBoolean("approved"))
      refused { alice.peerApprove(own, peer, approval.id) }
      alice.stop(); alice.destroy()
      alice = CryptoInstallation.open(directory.absolutePath, aliceAccount, AndroidProtectedKeystore(platform))
      val reopened = alice.peerView(own, bobAccount.user, peer)
      assertEquals("verified", JSONObject(reopened.statusJson).getString("trust"))
      assertTrue(JSONObject(reopened.statusJson).getJSONArray("devices").getJSONObject(0).getBoolean("approved"))
    } finally {
      alice.stop(); alice.destroy(); bob.stop(); bob.destroy(); root.deleteRecursively()
    }
  }

  @Test fun actualNativeIdentityCeremonyKeepsOriginalRegistrationAcrossReopen() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = AndroidProtectedKeystore.privateDirectory(File(context.noBackupFilesDir, "crypto-identity-test-" + UUID.randomUUID()))
    val directory = AndroidProtectedKeystore.privateDirectory(File(root, "coffer"))
    val platform = File(root, "platform")
    val account = CryptoAccount("https://crypto.example.org", "test-instance", "test-epoch", "alice", UUID.randomUUID().toString())
    var installation = CryptoInstallation.open(directory.absolutePath, account, AndroidProtectedKeystore(platform))
    val scope = JSONObject().put("instance_id", account.instance).put("data_epoch", account.dataEpoch)
    val wire = JSONObject().put("scope", scope).put("identity", JSONObject.NULL).put("devices", JSONArray())
      .put("revocations", JSONArray()).put("next_revocation", JSONObject.NULL)
    val empty = wire.toString()
    val flags = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
    fun encode(value: JSONObject) = Base64.encodeToString(value.toString().toByteArray(Charsets.UTF_8), flags)
    try {
      assertEquals(IdentityPhase.MISSING, installation.identityView(empty).phase)
      val created = installation.identityBegin(empty, "")
      assertEquals(IdentityPhase.IDENTITY_CREATED, created.phase)
      val preview = installation.identityPreview(empty, created.requestCode)
      assertEquals(created.requestFingerprint, preview.requestFingerprint)
      val grant = installation.identityApprove(empty, preview.id)
      assertEquals(IdentityPhase.REGISTERING, installation.identityInstall(empty, grant).phase)
      val original = installation.identityPending(empty)
      installation.stop(); installation.destroy()
      installation = CryptoInstallation.open(directory.absolutePath, account, AndroidProtectedKeystore(platform))
      assertEquals(original, installation.identityPending(empty))
      val registration = JSONObject(original)
      val certificate = JSONObject(String(Base64.decode(registration.getString("grant"), flags), Charsets.UTF_8)).getJSONObject("certificate")
      val device = certificate.getJSONObject("device")
      val incarnation = installation.status().incarnation
      val receipt = JSONObject().put("scope", scope).put("operation_id", registration.getString("operation_id"))
        .put("kind", "register_device").put("device_id", account.device).put("incarnation", incarnation)
        .put("device_revision", "1").put("root_fingerprint", created.rootFingerprint).put("key_package_refs", JSONArray())
      wire.put("identity", JSONObject().put("user_id", account.user).put("root", encode(device.getJSONObject("root")))
        .put("fingerprint", created.rootFingerprint).put("revision", "1"))
      wire.put("devices", JSONArray().put(JSONObject().put("device_id", account.device).put("incarnation", incarnation)
        .put("certificate", encode(certificate)).put("revision", "1").put("expires_at", device.getString("expires_at"))))
      val wrong = JSONObject(receipt.toString()).put("device_revision", "2")
      refused { installation.identityAcknowledge(wire.toString(), wrong.toString()) }
      assertEquals(original, installation.identityPending(wire.toString()))
      assertEquals(IdentityPhase.READY, installation.identityAcknowledge(wire.toString(), receipt.toString()).phase)
      installation.stop(); installation.destroy()
      installation = CryptoInstallation.open(directory.absolutePath, account, AndroidProtectedKeystore(platform))
      assertEquals(created.rootFingerprint, installation.identityView(wire.toString()).rootFingerprint)
      assertEquals(IdentityPhase.READY, installation.identityView(wire.toString()).phase)
    } finally {
      installation.stop(); installation.destroy(); root.deleteRecursively()
    }
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
