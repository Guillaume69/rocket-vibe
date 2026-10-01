import Foundation
import Observation
import RocketVibeCore

public let defaultServer = "https://chat.barrut.me"

/// The sign-in form: server, credentials, then a code when the server asks one.
@MainActor @Observable
public final class LoginModel {
    public var server = "" {
        didSet {
            if server != oldValue {
                leave()
                canRegister = false
                canRecover = false
                probeLine = nil
                probeBad = false
            }
        }
    }
    public var user = "" { didSet { if user != oldValue { leave() } } }
    public var password = ""
    public var code = ""
    public var registering = false
    public var recovering = false
    public var invitation = ""
    public private(set) var canRegister = false
    public private(set) var canRecover = false
    /// The 2FA method the server asked a code for: the form shows the code field.
    public private(set) var method: String?
    public private(set) var nativeMethods: [String] = []
    public private(set) var pendingConfirmation = false
    public private(set) var error: String?
    public private(set) var busy = false
    public private(set) var knownServers: [String] = []
    /// What the server says about itself: its version and what it asks, or why it will not do.
    public private(set) var probeLine: String?
    public private(set) var probeBad = false
    @ObservationIgnored private var nativeAttempt: NativeLoginAttempt?
    @ObservationIgnored private var generation = UUID()
    var revision: UUID { generation }

    public init() {}

    func reset(known: [String], error: String?) {
        leave()
        knownServers = known
        if server.isEmpty { server = known.first ?? defaultServer }
        password = ""
        code = ""
        method = nil
        registering = false
        recovering = false
        invitation = ""
        canRegister = false
        canRecover = false
        self.error = error
    }

    /// Asks the typed server about itself; nothing shown for an address that is not one.
    public func probe(client: Client) async {
        let asked = server
        let expected = generation
        canRegister = false
        canRecover = false
        do {
            let p = try await client.probe(server: asked)
            guard asked == server, expected == generation else { return }
            canRegister = p.genre == "rocketvibe" && p.accountInvitations
            canRecover = p.genre == "rocketvibe" && p.accountRecovery
            if !p.passwordLogin {
                probeLine = L("login.probe_no_password")
                probeBad = true
                return
            }
            var facts = ["\(p.genre == "rocketvibe" ? "RocketVibe" : "Rocket.Chat") \(p.version)"]
            if p.twoFactor { facts.append(L("login.probe_2fa")) }
            if p.e2e { facts.append(L("login.probe_e2e")) }
            probeLine = facts.joined(separator: " · ")
            probeBad = false
        } catch RvError.Local {
            if asked == server, expected == generation { probeLine = nil }
        } catch {
            guard asked == server, expected == generation else { return }
            probeLine = L("login.probe_failed")
            probeBad = true
        }
    }

    public func cancelCode() {
        generation = UUID()
        if nativeAttempt != nil { password = "" }
        nativeAttempt = nil
        nativeMethods = []
        pendingConfirmation = false
        method = nil
        code = ""
        error = nil
        busy = false
    }

    public func leave() {
        cancelCode()
        password = ""
        invitation = ""
        registering = false
        recovering = false
    }

    public func selectNativeMethod(_ selected: String) {
        guard !busy, nativeMethods.contains(selected) else { return }
        method = selected
        code = ""
    }

    private func current(_ expected: UUID, address: String, username: String) -> Bool {
        expected == generation && address == server
            && username == user.trimmingCharacters(in: .whitespaces) && !Task.isCancelled
    }

    private func refreshNativeForm(_ attempt: NativeLoginAttempt) {
        nativeMethods = attempt.methods().filter { $0 == "totp" || $0 == "recovery_code" }
        if method == nil || !nativeMethods.contains(method!) { method = nativeMethods.first }
        pendingConfirmation = attempt.pendingConfirmation()
        code = ""
    }

    /// Signs in, or asks for the code the server wants.
    func submit(client: Client) async -> ChatProvider? {
        guard !busy else { return nil }
        let (address, username, secret, challenge, answer) =
            (server, user.trimmingCharacters(in: .whitespaces), password, method, code)
        let invite = registering && canRegister ? invitation.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        let recovery = recovering && canRecover ? invitation.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        let asking = method != nil
        let expected = generation
        error = nil
        busy = true
        defer { if expected == generation { busy = false } }
        do {
            let chat: ChatProvider
            if let attempt = nativeAttempt {
                try await attempt.verify(method: challenge ?? "", code: answer)
                guard current(expected, address: address, username: username) else { return nil }
                let native = try await attempt.commit()
                guard current(expected, address: address, username: username) else { native.shutdown(); return nil }
                chat = .rocketVibe(native)
            } else {
                let native = try await client.isNativeServer(server: address)
                guard current(expected, address: address, username: username) else { return nil }
                if native {
                    let attempt = try await client.nativeStartLogin(server: address, user: username, password: secret,
                                                                   accountCode: recovery ?? invite, recovering: recovery != nil)
                    guard current(expected, address: address, username: username) else { return nil }
                    nativeAttempt = attempt
                    if !attempt.methods().isEmpty {
                        refreshNativeForm(attempt)
                        password = ""
                        invitation = ""
                        registering = false
                        recovering = false
                        if method == nil { error = L("login.factor_unavailable") }
                        return nil
                    }
                    let accepted = try await attempt.commit()
                    guard current(expected, address: address, username: username) else { accepted.shutdown(); return nil }
                    chat = .rocketVibe(accepted)
                } else {
                    chat = .rocketChat(try await client.login(
                        server: address, user: username, password: secret,
                        method: challenge, code: asking ? answer : nil))
                    guard current(expected, address: address, username: username) else { chat.shutdown(); return nil }
                }
            }
            nativeAttempt = nil
            nativeMethods = []
            pendingConfirmation = false
            method = nil
            code = ""
            password = ""
            invitation = ""
            registering = false
            recovering = false
            return chat
        } catch let RvError.Server(status, message, errorCode, twoFactor, _, _) {
            guard current(expected, address: address, username: username) else { return nil }
            if let attempt = nativeAttempt, !attempt.methods().isEmpty { refreshNativeForm(attempt) }
            if errorCode == "factor_rejected" || errorCode == "invalid_factor_code" { error = L("login.bad_code"); return nil }
            if errorCode == "factor_expired" { error = L("login.factor_expired"); return nil }
            if errorCode == "factor_unavailable" { error = L("login.factor_unavailable"); return nil }
            if errorCode == "secure_storage_unavailable" { error = L("login.secure_storage"); return nil }
            if errorCode == "invitation_rejected" { error = L("login.invitation_rejected"); return nil }
            if errorCode == "recovery_rejected" { error = L("login.recovery_rejected"); return nil }
            if errorCode == "invalid_request" && recovery != nil { error = L("login.recovery_help"); return nil }
            if errorCode == "invalid_request" && invite != nil { error = L("login.invitation_help"); return nil }
            if let challenge = twoFactor {
                method = challenge.method
                if asking { error = L("login.bad_code") }
                if challenge.method == "email" && !challenge.codeGenerated {
                    await client.requestEmailCode(server: server, user: user)
                }
                return nil
            }
            error = Self.describe(status: status, message: message, askingCode: asking)
        } catch let RvError.Local(message) {
            guard current(expected, address: address, username: username) else { return nil }
            if let attempt = nativeAttempt, !attempt.methods().isEmpty { refreshNativeForm(attempt) }
            error = message == "invalid server address" ? L("login.bad_server") : message
        } catch {
            guard current(expected, address: address, username: username) else { return nil }
            if let attempt = nativeAttempt, !attempt.methods().isEmpty { refreshNativeForm(attempt) }
            self.error = error.localizedDescription
        }
        return nil
    }

    static func describe(status: UInt16, message: String, askingCode: Bool) -> String {
        switch status {
        case 0: return L("login.unreachable")
        case 401 where askingCode: return L("login.bad_code")
        case 401: return L("login.rejected")
        case 429: return L("login.too_many")
        default: return message
        }
    }
}
