import Foundation
import RocketVibeCore
import XCTest
@testable import RocketVibeKit

/// Actual FFI/models + PostgreSQL + Secret Service, across three processes.
final class NativeEmailSettingsTests: XCTestCase {
    @MainActor
    func testOriginalProfileReceiptsAcrossProcessRestart() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["RV_NATIVE_EMAIL_SETTINGS_SERVER"],
              let password = env["RV_NATIVE_EMAIL_SETTINGS_PASSWORD"],
              let home = env["RV_NATIVE_EMAIL_SETTINGS_HOME"],
              let phase = env["RV_NATIVE_EMAIL_SETTINGS_PHASE"] else {
            throw XCTSkip("Requires disposable email settings bench")
        }
        let app = AppModel(home: home)
        defer { app.end() }
        if phase == "enable" {
            app.login.server = server; app.login.user = "swift-email"; app.login.password = password
            await app.submitLogin()
        } else { await app.start() }
        XCTAssertEqual(app.account?.username, "swift-email")
        for _ in 0..<200 {
            if app.connection == .online { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(app.connection, .online)
        let model = SecurityModel(app: app)
        defer { model.close() }
        await model.open()
        XCTAssertNil(model.error)
        XCTAssertTrue(model.value?.email?.address == "swift-email@example.test")
        if phase == "enable" {
            XCTAssertEqual(model.value?.proof, .ready)
            XCTAssertEqual(model.value?.emailFactorEnabled, false)
            XCTAssertEqual(model.value?.canEnableEmailFactor, true)
            let stale = try XCTUnwrap(model.value?.viewRevision)
            await model.refresh()
            await model.emailFactor(enabled: true, revision: stale)
            XCTAssertNotNil(model.error, "Obsolete displayed approval must reject before HTTP")
            await model.emailFactor(enabled: true, revision: try XCTUnwrap(model.value?.viewRevision))
            XCTAssertNotNil(model.error, "Proxy discards successful activation acknowledgement")
            return
        }
        if phase == "resume-disable" {
            XCTAssertEqual(model.value?.emailFactorEnabled, true)
            XCTAssertEqual(model.value?.totpEnabled, false)
            XCTAssertEqual(model.value?.enabled, true)
            XCTAssertEqual(model.value?.factor, .codes)
            let original = try XCTUnwrap(model.value?.codes)
            XCTAssertTrue(original.count == 10)
            var copied = ""
            await model.copy(.codes, revision: try XCTUnwrap(model.value?.viewRevision)) { copied = $0 }
            XCTAssertNil(model.error)
            XCTAssertTrue(copied == original.joined(separator: "\n"))
            await model.refresh()
            XCTAssertTrue(model.value?.codes == original, "Refreshing must retain the original backup bag")
            XCTAssertEqual(model.value?.proof, .password)
            model.password = password
            await model.confirmPassword()
            XCTAssertNotNil(model.error, "Proxy discards accepted password-proof response")
            await model.refresh()
            XCTAssertEqual(model.value?.proof, .challenge)
            model.method = "recovery_code"; model.code = original[0]
            await model.confirmFactor()
            XCTAssertNotNil(model.error, "Proxy discards accepted full proof response")
            await model.refresh()
            XCTAssertEqual(model.value?.proof, .ready)
            await model.acknowledge(revision: try XCTUnwrap(model.value?.viewRevision))
            XCTAssertNil(model.error)
            XCTAssertTrue(model.value?.codes.isEmpty == true)
            let stale = try XCTUnwrap(model.value?.viewRevision)
            await model.refresh()
            await model.emailFactor(enabled: false, revision: stale)
            XCTAssertNotNil(model.error)
            XCTAssertEqual(model.value?.emailFactorEnabled, true)
            await model.emailFactor(enabled: false, revision: try XCTUnwrap(model.value?.viewRevision))
            XCTAssertNotNil(model.error, "Proxy discards successful removal acknowledgement")
            return
        }
        XCTAssertEqual(phase, "resume-disabled")
        XCTAssertEqual(model.value?.emailFactorEnabled, false)
        XCTAssertEqual(model.value?.enabled, false)
        XCTAssertEqual(model.value?.factor, .idle)
        XCTAssertTrue(model.value?.codes.isEmpty == true)
        let retained = try await XCTUnwrap(app.native).security()
        _ = try await retained.refresh()
        let revision = retained.state().viewRevision
        retained.close()
        do {
            _ = try await retained.emailFactorAction(enabled: true, viewRevision: revision)
            XCTFail("Closed handle must reject activation")
        } catch let RvError.Server(_, _, code, _, _, _) {
            XCTAssertEqual(code, "session_closed")
        }
        model.close()
        await model.emailFactor(enabled: true, revision: revision)
        XCTAssertNil(model.value)
    }
}
