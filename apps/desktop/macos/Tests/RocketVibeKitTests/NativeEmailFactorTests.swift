import Foundation
import RocketVibeCore
import XCTest
@testable import RocketVibeKit

/// Private SMTP fixture + PostgreSQL + actual FFI/keyring, across three processes.
/// Assertions use booleans instead of interpolating a code into failure output.
final class NativeEmailFactorTests: XCTestCase {
    @MainActor
    func testOriginalEmailDeliveriesAndProofsAcrossProcessRestart() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["RV_NATIVE_EMAIL_OTP_SERVER"],
              let password = env["RV_NATIVE_EMAIL_OTP_PASSWORD"],
              let path = env["RV_NATIVE_EMAIL_OTP_FILE"],
              let home = env["RV_NATIVE_EMAIL_OTP_HOME"],
              let phase = env["RV_NATIVE_EMAIL_OTP_PHASE"] else {
            throw XCTSkip("Requires the disposable desktop email OTP bench")
        }
        let app = AppModel(home: home)
        defer { app.end() }
        if phase != "reauth-finish" {
            app.login.server = server; app.login.user = "swift-email"; app.login.password = password
            await app.submitLogin()
            XCTAssertTrue(app.login.nativeMethods.contains("email"))
            XCTAssertTrue(app.login.password.isEmpty && app.login.code.isEmpty)
            app.login.selectNativeMethod("email")
            let initial = try XCTUnwrap(app.login.nativeEmail)
            XCTAssertFalse(app.signedIn)
            if phase == "login-delivery" {
                XCTAssertFalse(initial.requested)
                await app.login.sendNativeEmail(resend: false, revision: initial.viewRevision)
                XCTAssertNotNil(app.login.error, "The proxy discards the accepted email-delivery response")
                XCTAssertTrue(app.login.nativeEmail?.requested == true && app.login.nativeEmail?.delivery == nil)
                XCTAssertTrue(app.login.code.isEmpty)
                XCTAssertFalse(app.signedIn)
                _ = try await mail(path, sequence: 2)
                // A second handle reads the original candidate after a fresh
                // password proof. Revisions fence delayed resend callbacks.
                let retained = try await app.client.nativeStartLogin(server: server, user: "swift-email", password: password, accountCode: nil, recovering: false)
                let old = try XCTUnwrap(retained.emailDelivery())
                XCTAssertTrue(old.requested)
                let resumed = try await retained.sendEmail(resend: false, viewRevision: old.viewRevision)
                XCTAssertNotNil(resumed.delivery)
                try await rejected("credentials_changed") {
                    _ = try await retained.sendEmail(resend: true, viewRevision: old.viewRevision)
                }
                retained.close()
                XCTAssertNil(retained.emailDelivery())
                try await rejected("session_closed") {
                    _ = try await retained.sendEmail(resend: false, viewRevision: resumed.viewRevision)
                }
                let accounts = await app.client.accounts()
                XCTAssertTrue(accounts.isEmpty, "Email delivery must not create an active credential")
                app.login.leave()
                XCTAssertNil(app.login.nativeEmail)
                return
            }
            XCTAssertEqual(phase, "login-proof")
            XCTAssertTrue(initial.requested, "The original private delivery survives a real process restart")
            await app.login.sendNativeEmail(resend: false, revision: initial.viewRevision)
            let delivered = try XCTUnwrap(app.login.nativeEmail)
            XCTAssertNotNil(delivered.delivery)
            XCTAssertTrue(delivered.expiresAt == initial.expiresAt, "Resume cannot extend the original delivery deadline")
            await app.login.sendNativeEmail(resend: true, revision: delivered.viewRevision)
            XCTAssertEqual(app.login.error, L("email.limited"))
            XCTAssertTrue(app.login.code.isEmpty)
            app.login.code = try await mail(path, sequence: 2)
            await app.submitLogin()
            XCTAssertFalse(app.signedIn, "The discarded accepted code response cannot activate a session")
            XCTAssertTrue(app.login.code.isEmpty)
            await app.submitLogin()
        } else { await app.start() }
        XCTAssertEqual(app.account?.username, "swift-email")
        try await until { app.connection == .online }
        let activePath = URL(fileURLWithPath: app.client.configDir()).appendingPathComponent("active-account")
        let active = try Data(contentsOf: activePath)
        let model = SecurityModel(app: app)
        defer { model.close() }
        await model.open()
        XCTAssertNil(model.error)
        if phase == "login-proof" {
            XCTAssertEqual(model.value?.proof, .password)
            XCTAssertEqual(model.value?.enabled, true)
            XCTAssertEqual(model.value?.totpEnabled, false)
            model.password = password
            await model.confirmPassword()
            XCTAssertNotNil(model.error, "The proxy discards the accepted password-proof response")
            XCTAssertTrue(model.password.isEmpty)
            await model.refresh()
            XCTAssertEqual(model.value?.proof, .challenge)
            XCTAssertTrue(model.value?.methods.contains("email") == true)
            model.method = "email"
            await model.sendProofEmail(resend: false, revision: try XCTUnwrap(model.value?.viewRevision))
            XCTAssertNotNil(model.error, "The proxy discards the accepted proof-email response")
            XCTAssertTrue(model.value?.proofEmail?.requested == true)
            XCTAssertTrue(model.code.isEmpty)
            _ = try await mail(path, sequence: 3)
            XCTAssertTrue(try Data(contentsOf: activePath) == active)
            model.close()
            XCTAssertNil(model.value)
            return
        }
        XCTAssertEqual(phase, "reauth-finish")
        XCTAssertEqual(model.value?.proof, .challenge)
        XCTAssertTrue(model.value?.proofEmail?.requested == true)
        model.method = "email"
        let stale = try XCTUnwrap(model.value?.viewRevision)
        await model.refresh()
        await model.sendProofEmail(resend: false, revision: stale)
        XCTAssertNotNil(model.error, "An obsolete displayed proof cannot dispatch email")
        XCTAssertTrue(model.code.isEmpty)
        await model.sendProofEmail(resend: false, revision: try XCTUnwrap(model.value?.viewRevision))
        XCTAssertNil(model.error)
        XCTAssertNotNil(model.value?.proofEmail?.delivery)
        model.code = try await mail(path, sequence: 3)
        await model.confirmFactor()
        XCTAssertNotNil(model.error, "The proxy discards the accepted factor-proof response")
        XCTAssertTrue(model.code.isEmpty)
        await model.refresh()
        XCTAssertEqual(model.value?.proof, .ready)
        XCTAssertNil(model.value?.proofEmail)
        XCTAssertTrue(try Data(contentsOf: activePath) == active, "Identity proof must retain its original active-account family")
        let accounts = await app.client.accounts()
        XCTAssertEqual(accounts.count, 1)
        let revision = try XCTUnwrap(model.value?.viewRevision)
        model.close()
        await model.sendProofEmail(resend: false, revision: revision)
        XCTAssertNil(model.value)
        XCTAssertTrue(model.code.isEmpty)
    }
    @MainActor
    private func rejected(_ expected: String, action: () async throws -> Void) async throws {
        do { try await action(); XCTFail("Retained stale/closed handle must reject the request") }
        catch let RvError.Server(_, _, code, _, _, _) { XCTAssertEqual(code, expected) }
    }
    @MainActor
    private func until(_ ready: () -> Bool) async throws {
        for _ in 0..<200 {
            if ready() { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTFail("Native account must connect")
    }
    private func mail(_ path: String, sequence: Int) async throws -> String {
        for _ in 0..<200 {
            if let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
               let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               value["sequence"] as? Int == sequence,
               let code = value["code"] as? String, code.count == 8, code.allSatisfy(\.isNumber) {
                return code
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw NSError(domain: "Disposable OTP mail did not arrive", code: 1)
    }
}
