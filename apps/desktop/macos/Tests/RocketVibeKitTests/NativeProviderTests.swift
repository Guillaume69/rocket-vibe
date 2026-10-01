import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import RocketVibeCore
import XCTest
@testable import RocketVibeKit

/// Runs with a disposable native server and a real Secret Service / macOS Keychain.
final class NativeProviderTests: XCTestCase {
    @MainActor
    func testExistingModelsLoginSendOfflineResumeDraftAndLogout() async throws {
        guard let server = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_SERVER"],
              let password = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_PASSWORD"] else {
            throw XCTSkip("Native integration server unset")
        }
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("rv-native-kit-\(UUID())").path
        defer { try? FileManager.default.removeItem(atPath: home) }
        let app = AppModel(home: home)
        defer { app.end() }
        app.login.server = server
        app.login.user = "desktop"
        app.login.password = "wrong-password"
        await app.submitLogin()
        XCTAssertFalse(app.signedIn)
        XCTAssertEqual(app.login.error, L("login.rejected"))
        app.login.password = password
        await app.submitLogin()
        XCTAssertEqual(app.screen, .chat, app.login.error ?? "no login error")
        XCTAssertNil(app.chat)
        let native = try XCTUnwrap(app.native)
        let account = try XCTUnwrap(app.account)
        XCTAssertEqual(account.genre, "rocketvibe")
        try await until(diagnostics: { "Native connection: \(native.status())" }) { app.connection == .online }

        let devices = DevicesModel(app: app)
        await devices.load()
        XCTAssertNil(devices.error)
        let thisDevice = try XCTUnwrap(devices.rows.first { $0.current })
        devices.labels[thisDevice.id] = "Swift desktop"
        await devices.rename(thisDevice)
        XCTAssertNil(devices.error)
        XCTAssertEqual(devices.rows.first { $0.current }?.label, "Swift desktop")
        let beforeCurrentRevoke = devices.rows.count
        await devices.revoke(thisDevice)
        XCTAssertEqual(devices.rows.count, beforeCurrentRevoke, "Use the existing sign-out flow for this device")
        // A second login kept only in test memory does not replace the app's keychain.
        let extra = try await makeExtraDevice(server: server, password: password)
        await devices.load()
        let otherDevice = try XCTUnwrap(devices.rows.first { $0.id == extra.id })
        XCTAssertFalse(otherDevice.current)
        await devices.revoke(otherDevice)
        XCTAssertNil(devices.error)
        XCTAssertFalse(devices.rows.contains { $0.id == extra.id })
        var probe = URLRequest(url: URL(string: server + "/api/v1/me")!)
        probe.setValue("Bearer " + extra.token, forHTTPHeaderField: "Authorization")
        let (_, rejected) = try await URLSession.shared.data(for: probe)
        XCTAssertEqual((rejected as? HTTPURLResponse)?.statusCode, 401)

        let rid = try await native.createRoom(name: "swift-native-\(UUID())", private: true)
        try await until { app.rooms.contains { $0.rid == rid } }
        app.open(rid)
        let room = try XCTUnwrap(app.room)
        try await until { !room.loading }
        XCTAssertFalse(room.supportsFiles)
        room.draft = "**Swift shared view** :smile:"
        await room.send()
        try await until { room.messages.contains { $0.text == "**Swift shared view** :smile:" && $0.delivery == .sent } }
        let message = try XCTUnwrap(room.messages.last)
        XCTAssertTrue(message.mine)
        XCTAssertFalse(message.body.isEmpty)
        try await until { room.actions(for: message).contains(.edit) && room.actions(for: message).contains(.delete) && room.actions(for: message).contains(.react) }
        XCTAssertEqual(room.quickReactions.count, 6)
        await room.react(message, shortcode: ":+1:", add: true)
        try await until { room.messages.first { $0.id == message.id }?.reactions.count == 1 }
        let reacted = try XCTUnwrap(room.messages.first { $0.id == message.id })
        XCTAssertTrue(reacted.reactions[0].mine)
        XCTAssertEqual(reacted.reactions[0].glyph, "👍")
        XCTAssertEqual(reacted.ts, message.ts)
        XCTAssertTrue(room.quickReactionIsMine(reacted, shortcode: ":+1:"))
        await room.react(reacted, shortcode: ":thumbsup:", add: false)
        try await until { room.messages.first { $0.id == message.id }?.reactions.isEmpty == true }
        XCTAssertTrue(room.supportsEditing)
        XCTAssertTrue(room.supportsMarks)
        try await room.pin(message, true)
        try await room.star(message, true)
        try await until { room.messages.first { $0.id == message.id }?.pinned == true }
        let pins = try await room.marked(starred: false)
        let stars = try await room.marked(starred: true)
        XCTAssertEqual(pins.map(\.id), [message.id])
        XCTAssertEqual(stars.map(\.id), [message.id])
        XCTAssertTrue(stars[0].starred)
        try await room.star(stars[0], false)
        try await room.pin(pins[0], false)
        let emptyPins = try await room.marked(starred: false)
        let emptyStars = try await room.marked(starred: true)
        XCTAssertTrue(emptyPins.isEmpty)
        XCTAssertTrue(emptyStars.isEmpty)
        try await room.prepareMutation(message, editing: true)
        try await room.edit(message, text: "Swift native edited")
        try await until { room.messages.contains { $0.id == message.id && $0.text == "Swift native edited" } }
        let edited = try XCTUnwrap(room.messages.first { $0.id == message.id })
        try await room.prepareMutation(edited, editing: true)
        let competing = try await native.messageActions(messageId: message.id)
        try await native.edit(room: rid, messageId: message.id, revision: competing.revision, text: "Concurrent Swift edit")
        do {
            try await room.edit(edited, text: "Stale editor must not overwrite")
            XCTFail("A stale editor must receive revision_conflict")
        } catch let RvError.Server(status, _, code, _, _, _) {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(code, "revision_conflict")
        }
        try await until { room.messages.contains { $0.id == message.id && $0.text == "Concurrent Swift edit" } }
        let latest = try XCTUnwrap(room.messages.first { $0.id == message.id })
        try await room.prepareMutation(latest, editing: true)
        XCTAssertEqual(room.editingText(latest), "Stale editor must not overwrite", "A failed edit remains available for review")
        XCTAssertEqual(room.editingOriginalText(latest), "Concurrent Swift edit")
        try await room.prepareMutation(latest, editing: false)
        try await room.delete(latest)
        try await until { !room.messages.contains { $0.id == message.id } }
        XCTAssertEqual(room.quickReactions.count, 6)

        let directoryClient = Client(home: home + "/directory-owner")
        let directoryOwner = try await directoryClient.nativeLogin(server: server, user: "mobile", password: password)
        defer { directoryOwner.shutdown() }
        try await until { directoryOwner.status().state == .online }
        let publicName = "swift-directory-\(UUID())"
        let publicId = try await directoryOwner.createRoom(name: publicName, private: false)
        XCTAssertFalse(app.rooms.contains { $0.rid == publicId })
        let found = try await app.provider!.spotlight(query: publicName)
        XCTAssertEqual(found.count, 1)
        await app.go(to: found[0])
        try await until { app.room?.room.rid == publicId && app.room?.loading == false }
        XCTAssertEqual(app.room?.room.kind, "c")
        let publicView = try XCTUnwrap(app.room)
        publicView.draft = "Swift joined public directory"
        await publicView.send()
        try await until { publicView.messages.contains { $0.text == "Swift joined public directory" && $0.delivery == .sent } }
        try await directoryOwner.logout()
        app.open(rid)
        let originalView = try XCTUnwrap(app.room)
        try await until { !originalView.loading }

        native.suspend()
        try await until { app.connection == .offline }
        originalView.draft = "Swift offline durable"
        await originalView.send()
        XCTAssertEqual(originalView.messages.last?.delivery, .pending)
        let intent = try XCTUnwrap(originalView.messages.last?.id)
        originalView.draft = "draft before switching"
        // The debounced save must be flushed even when switching immediately.
        let resumed = await app.resume(account)
        XCTAssertTrue(resumed)
        XCTAssertTrue(originalView.messages.isEmpty, "The old room model must be inactive after switching")
        devices.labels[thisDevice.id] = "Stale device callback"
        await devices.rename(thisDevice)
        XCTAssertEqual(devices.rows.first { $0.id == thisDevice.id }?.label, "Swift desktop")
        try await until { app.connection == .online }
        app.open(rid)
        let reopened = try XCTUnwrap(app.room)
        XCTAssertEqual(reopened.draft, "draft before switching")
        try await until { reopened.messages.contains { $0.id == intent && $0.delivery == .sent } }
        XCTAssertEqual(reopened.messages.filter { $0.text == "Swift offline durable" }.count, 1)
        // Retained views / callbacks of the old account cannot enqueue another message.
        originalView.draft = "stale callback"
        await originalView.send()
        XCTAssertFalse(reopened.messages.contains { $0.text == "stale callback" })

        app.showLogin(error: nil)
        app.cancelLogin()
        XCTAssertEqual(app.screen, .chat)
        let people = try await app.provider!.spotlight(query: "mobile")
        XCTAssertFalse(people.isEmpty)
        await app.go(to: people[0])
        try await until { app.room?.room.kind == "d" }
        await app.signOut()
        XCTAssertEqual(app.screen, .login)
        XCTAssertFalse(app.signedIn)
        XCTAssertTrue(app.accounts.isEmpty)
        let savedAccounts = await app.client.accounts()
        XCTAssertTrue(savedAccounts.isEmpty)
    }

    @MainActor
    func testInvitationInExistingLoginModelAndKeychainResume() async throws {
        guard let server = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_SERVER"],
              let password = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_PASSWORD"],
              let path = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_INVITATION_FILE"] else {
            throw XCTSkip("requires disposable native invitation bench")
        }
        let issued = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
        let token = try XCTUnwrap(issued["token"] as? String)
        let home = "/tmp/rv-swift-signup-\(UUID())"
        let app = AppModel(home: home)
        defer { app.end() }
        app.login.server = server
        app.login.user = "swift-invited"
        app.login.password = password
        await app.login.probe(client: app.client)
        XCTAssertTrue(app.login.canRegister)
        app.login.registering = true
        app.login.invitation = token
        await app.submitLogin()
        XCTAssertEqual(app.screen, .chat, app.login.error ?? "no signup error")
        XCTAssertEqual(app.account?.username, "swift-invited")
        XCTAssertEqual(app.login.invitation, "")
        XCTAssertEqual(app.login.password, "")
        XCTAssertFalse(app.login.registering)
        try await until { app.connection == .online }
        let saved = try XCTUnwrap(app.account)
        let resumed = await app.resume(saved)
        XCTAssertTrue(resumed)
        try await until { app.connection == .online }
        await app.signOut()
        XCTAssertTrue(app.accounts.isEmpty)
    }

    @MainActor
    func testRecoveryInExistingLoginModelRevokesOldSessionAndResumes() async throws {
        guard let server = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_SERVER"],
              let password = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_PASSWORD"],
              let path = ProcessInfo.processInfo.environment["RV_NATIVE_TEST_RECOVERY_FILE"] else {
            throw XCTSkip("requires disposable recovery bench")
        }
        let old = try await makeExtraDevice(server: server, password: password, username: "swift-recovery")
        let issued = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
        let token = try XCTUnwrap(issued["token"] as? String)
        let app = AppModel(home: "/tmp/rv-swift-recovery-\(UUID())")
        defer { app.end() }
        app.login.server = server
        app.login.user = "swift-recovery"
        app.login.password = "native-recovered-test-password"
        await app.login.probe(client: app.client)
        XCTAssertTrue(app.login.canRecover)
        app.login.recovering = true
        app.login.invitation = token
        await app.submitLogin()
        XCTAssertEqual(app.screen, .chat, app.login.error ?? "no recovery error")
        XCTAssertEqual(app.account?.username, "swift-recovery")
        XCTAssertEqual(app.login.invitation, "")
        XCTAssertEqual(app.login.password, "")
        XCTAssertFalse(app.login.recovering)
        try await until { app.connection == .online }
        var probe = URLRequest(url: URL(string: server + "/api/v1/me")!)
        probe.setValue("Bearer " + old.token, forHTTPHeaderField: "Authorization")
        let (_, response) = try await URLSession.shared.data(for: probe)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 401)
        let saved = try XCTUnwrap(app.account)
        let resumed = await app.resume(saved)
        XCTAssertTrue(resumed)
        try await until { app.connection == .online }
        await app.signOut()
        XCTAssertTrue(app.accounts.isEmpty)
    }

    @MainActor
    private func makeExtraDevice(server: String, password: String, username: String = "desktop") async throws -> (id: String, token: String) {
        var request = URLRequest(url: URL(string: server + "/api/v1/auth/login")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["username":username, "password":password])
        let (body, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let login = try JSONSerialization.jsonObject(with: body) as! [String: Any]
        let token = try XCTUnwrap(login["token"] as? String)
        var listing = URLRequest(url: URL(string: server + "/api/v1/me/sessions")!)
        listing.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let (sessions, _) = try await URLSession.shared.data(for: listing)
        let records = try JSONSerialization.jsonObject(with: sessions) as! [[String: Any]]
        return (try XCTUnwrap(records.first { $0["current"] as? Bool == true }?["id"] as? String), token)
    }

    @MainActor
    private func until(file: StaticString = #filePath, line: UInt = #line, diagnostics: () -> String = { "" }, _ condition: @escaping @MainActor () -> Bool) async throws {
        for _ in 0..<300 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Native model condition did not become true. \(diagnostics())", file: file, line: line)
        throw RvError.Local(message: "test timeout")
    }
}
