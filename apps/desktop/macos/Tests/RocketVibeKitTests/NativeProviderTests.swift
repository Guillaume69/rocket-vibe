import Foundation
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
        XCTAssertEqual(room.actions(for: message), [.copy])
        XCTAssertTrue(room.quickReactions.isEmpty)

        native.suspend()
        try await until { app.connection == .offline }
        room.draft = "Swift offline durable"
        await room.send()
        XCTAssertEqual(room.messages.last?.delivery, .pending)
        let intent = try XCTUnwrap(room.messages.last?.id)
        room.draft = "draft before switching"
        // The debounced save must be flushed even when switching immediately.
        let resumed = await app.resume(account)
        XCTAssertTrue(resumed)
        XCTAssertTrue(room.messages.isEmpty, "The old room model must be inactive after switching")
        try await until { app.connection == .online }
        app.open(rid)
        let reopened = try XCTUnwrap(app.room)
        XCTAssertEqual(reopened.draft, "draft before switching")
        try await until { reopened.messages.contains { $0.id == intent && $0.delivery == .sent } }
        XCTAssertEqual(reopened.messages.filter { $0.text == "Swift offline durable" }.count, 1)
        // Retained views / callbacks of the old account cannot enqueue another message.
        room.draft = "stale callback"
        await room.send()
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
    private func until(file: StaticString = #filePath, line: UInt = #line, diagnostics: () -> String = { "" }, _ condition: @escaping @MainActor () -> Bool) async throws {
        for _ in 0..<300 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Native model condition did not become true. \(diagnostics())", file: file, line: line)
        throw RvError.Local(message: "test timeout")
    }
}
