import Foundation
import RocketVibeCore
import XCTest
@testable import RocketVibeKit

/// Run twice by the dedicated disposable bench. No proof/code is printed or
/// written to a test artifact; the second process uses the real private keyring.
final class NativeSecurityTests: XCTestCase {
    @MainActor
    func testPrivateSettingsAcrossProcessRestartAndLostAcknowledgements() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["RV_NATIVE_SECURITY_TEST_SERVER"],
              let password = env["RV_NATIVE_SECURITY_TEST_PASSWORD"],
              let path = env["RV_NATIVE_SECURITY_TEST_FACTOR_FILE"],
              let home = env["RV_NATIVE_SECURITY_TEST_HOME"],
              let phase = env["RV_NATIVE_SECURITY_TEST_PHASE"] else {
            throw XCTSkip("Requires the disposable native security bench")
        }
        let app = AppModel(home: home)
        defer { app.end() }
        if phase == "proof-regenerate" {
            let issued = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any]
            let codes = try XCTUnwrap(issued?["codes"] as? [String])
            XCTAssertGreaterThan(codes.count, 1)
            app.login.server = server; app.login.user = "swift-security"; app.login.password = password
            await app.submitLogin()
            XCTAssertTrue(app.login.nativeMethods.contains("recovery_code"))
            XCTAssertTrue(app.login.password.isEmpty)
            app.login.selectNativeMethod("recovery_code"); app.login.code = codes[0]
            await app.submitLogin()
            XCTAssertFalse(app.signedIn, "A lost response cannot install a session")
            XCTAssertTrue(app.login.code.isEmpty)
            await app.submitLogin()
            XCTAssertEqual(app.account?.username, "swift-security")
            try await until { app.connection == .online }
            let activePath = URL(fileURLWithPath: app.client.configDir()).appendingPathComponent("active-account")
            let active = try Data(contentsOf: activePath)
            let native = try XCTUnwrap(app.native)
            XCTAssertTrue(native.securitySupported())
            let model = SecurityModel(app: app)
            defer { model.close() }
            await model.open()
            XCTAssertNil(model.error)
            XCTAssertEqual(model.value?.proof, .password, "The bench ages only the existing connected family")
            XCTAssertEqual(model.value?.enabled, true)

            // FFI confirmations carry the revision that was actually displayed.
            let retained = try await native.security()
            let old = try await retained.refresh()
            _ = try await retained.refresh()
            do {
                _ = try await retained.factorAction(action: .regenerate, viewRevision: old.viewRevision)
                XCTFail("A stale confirmation must be rejected before the mutation")
            } catch let RvError.Server(_, _, code, _, _, _) {
                XCTAssertEqual(code, "credentials_changed")
            }
            retained.close()
            XCTAssertFalse(retained.state().loaded)
            do { _ = try await retained.refresh(); XCTFail("A retained closed handle must reject requests") }
            catch let RvError.Server(_, _, code, _, _, _) { XCTAssertEqual(code, "session_closed") }

            model.password = password
            await model.confirmPassword()
            XCTAssertTrue(model.password.isEmpty)
            XCTAssertNotNil(model.error, "The proxy drops the committed password-proof response")
            await recover(model) { $0.proof == .challenge }
            model.method = "recovery_code"; model.code = "INVALID-BACKUP"
            await model.confirmFactor()
            XCTAssertEqual(model.error, L("security.rejected"))
            XCTAssertEqual(model.method, "recovery_code")
            XCTAssertTrue(model.code.isEmpty)
            model.code = codes[1]
            await model.confirmFactor()
            XCTAssertNotNil(model.error, "The proxy drops the committed factor-proof response")
            await recover(model) { $0.proof == .ready }
            XCTAssertTrue(model.code.isEmpty)
            XCTAssertTrue(try Data(contentsOf: activePath) == active, "Proof must not replace the active-account slot")
            let accounts = await app.client.accounts()
            XCTAssertEqual(accounts.count, 1, "Settings must not create another credential family")

            let revision = try XCTUnwrap(model.value?.viewRevision)
            await model.factor(.regenerate, revision: revision)
            await recover(model) { $0.factor == .codes && !$0.codes.isEmpty }
            var copied = false
            let bag = try XCTUnwrap(model.value)
            await model.copy(.codes, revision: bag.viewRevision) { text in
                copied = text == bag.codes.joined(separator: "\n")
            }
            XCTAssertTrue(copied, "Copy must read the original private receipt through the FFI")
            XCTAssertEqual(model.value?.supportsEmail, true)
            model.emailAddress = "swift-security@example.test"
            await model.startEmail(revision: try XCTUnwrap(model.value?.viewRevision))
            XCTAssertTrue(model.emailAddress.isEmpty)
            XCTAssertNotNil(model.error, "The proxy discards the committed email-start response")
            await recover(model) { $0.email?.phase == .pending }
            XCTAssertEqual(model.value?.email?.pendingAddress, "swift-security@example.test")
            XCTAssertNil(model.value?.email?.address)
            model.password = "transient-password"; model.code = "transient-code"; model.setupCode = "transient-setup"
            model.emailAddress = "transient@example.test"; model.emailCode = "00000000"
            model.close()
            XCTAssertNil(model.value)
            XCTAssertTrue(model.password.isEmpty && model.code.isEmpty && model.setupCode.isEmpty && model.method.isEmpty)
            XCTAssertTrue(model.emailAddress.isEmpty && model.emailCode.isEmpty)
            await model.acknowledge(revision: bag.viewRevision)
            XCTAssertNil(model.value, "A closed view cannot acknowledge the durable receipt")
            // app.end() closes the socket without logging out. The next process
            // must resume this one family and the original private code bag.
        } else if phase == "restart-ack-disable" {
            await app.start()
            XCTAssertEqual(app.account?.username, "swift-security")
            try await until { app.connection == .online }
            let model = SecurityModel(app: app)
            defer { model.close() }
            await model.open()
            let restored = try XCTUnwrap(model.value)
            XCTAssertEqual(restored.factor, .codes)
            XCTAssertFalse(restored.codes.isEmpty)
            XCTAssertEqual(restored.proof, .ready)
            XCTAssertEqual(restored.email?.phase, .pending, "The original email intent survives a real process/keyring restart")
            let mailPath = try XCTUnwrap(env["RV_NATIVE_SECURITY_TEST_EMAIL_FILE"])
            var delivered: [String: Any]?
            for _ in 0..<100 {
                if let data = try? Data(contentsOf: URL(fileURLWithPath: mailPath)) {
                    delivered = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                    if delivered != nil { break }
                }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            let delivery = try XCTUnwrap(delivered)
            XCTAssertEqual(delivery["address"] as? String, "swift-security@example.test")
            let mailCode = try XCTUnwrap(delivery["code"] as? String)
            await model.refresh()
            model.emailCode = mailCode
            await model.confirmEmail(revision: restored.viewRevision)
            XCTAssertNotNil(model.error, "An old displayed revision cannot confirm the email")
            XCTAssertTrue(model.emailCode.isEmpty)
            XCTAssertEqual(model.value?.email?.phase, .pending)
            model.emailCode = mailCode
            await model.confirmEmail(revision: try XCTUnwrap(model.value?.viewRevision))
            XCTAssertNotNil(model.error, "The proxy discards the committed email-confirmation response")
            XCTAssertTrue(model.emailCode.isEmpty)
            await recover(model) { $0.email?.phase == .verified }
            XCTAssertEqual(model.value?.email?.address, "swift-security@example.test")
            await model.acknowledgeEmail(revision: try XCTUnwrap(model.value?.viewRevision))
            XCTAssertEqual(model.value?.email?.phase, .idle)
            model.emailAddress = "bad@@example.test"
            await model.startEmail(revision: try XCTUnwrap(model.value?.viewRevision))
            XCTAssertEqual(model.value?.email?.phase, .stale)
            await model.cancelEmail(revision: try XCTUnwrap(model.value?.viewRevision))
            XCTAssertNil(model.error)
            XCTAssertEqual(model.value?.email?.phase, .idle)
            XCTAssertEqual(model.value?.email?.address, "swift-security@example.test")
            await model.acknowledge(revision: restored.viewRevision)
            XCTAssertNotNil(model.error, "An old confirmation cannot acknowledge a refreshed view")
            XCTAssertEqual(model.value?.factor, .codes)
            var staleCopied = false
            await model.copy(.codes, revision: restored.viewRevision) { _ in staleCopied = true }
            XCTAssertFalse(staleCopied)

            // Leaving while the actual FFI job is running invalidates its UI
            // callback. Only the private receipt survives.
            let copyRevision = try XCTUnwrap(model.value?.viewRevision)
            var lateCopied = false
            let late = Task { await model.copy(.codes, revision: copyRevision) { _ in lateCopied = true } }
            for _ in 0..<100 where !model.busy { await Task.yield() }
            XCTAssertTrue(model.busy)
            model.close()
            await late.value
            XCTAssertFalse(lateCopied)
            XCTAssertNil(model.value)
            XCTAssertNil(model.error)
            XCTAssertFalse(model.busy)
            await model.open()
            XCTAssertEqual(model.value?.factor, .codes)

            // A retained model of the previous provider cannot mutate the new
            // provider, even when both providers represent the same account.
            let beforeSwitch = try XCTUnwrap(model.value?.viewRevision)
            let account = try XCTUnwrap(app.account)
            let resumed = await app.resume(account)
            XCTAssertTrue(resumed)
            try await until { app.connection == .online }
            await model.factor(.disable, revision: beforeSwitch)
            model.close()
            let current = SecurityModel(app: app)
            defer { current.close() }
            await current.open()
            XCTAssertEqual(current.value?.enabled, true)
            XCTAssertEqual(current.value?.factor, .codes)
            await current.acknowledge(revision: try XCTUnwrap(current.value?.viewRevision))
            XCTAssertNil(current.error)
            XCTAssertEqual(current.value?.factor, .idle)
            await current.factor(.disable, revision: try XCTUnwrap(current.value?.viewRevision))
            await recover(current) { !$0.enabled && $0.factor == .idle }
            XCTAssertNil(current.error)
            XCTAssertEqual(current.value?.proof, .ready)
            let accounts = await app.client.accounts()
            XCTAssertEqual(accounts.count, 1)
        } else {
            XCTFail("Unknown disposable security test phase")
        }
    }

    @MainActor
    private func recover(_ model: SecurityModel, _ condition: (NativeSecurityState) -> Bool,
                         file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<10 {
            await model.refresh()
            if let value = model.value, condition(value) { return }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Security operation did not recover its committed result", file: file, line: line)
    }
    @MainActor
    private func until(_ condition: @escaping @MainActor () -> Bool,
                       file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<300 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Security provider did not become ready", file: file, line: line)
        throw RvError.Local(message: "security test timeout")
    }
}
