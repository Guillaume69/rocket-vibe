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
                probeRevision = UUID()
                leave()
                canRegister = false
                canRecover = false
                canEmailRecover = false
                recoveryIdentity = nil
                probeLine = nil
                probeBad = false
            }
        }
    }
    /// Found by probing; forced when the probe gets it wrong behind an unusual proxy.
    public var kind: ServerChoice = .auto {
        didSet {
            if kind != oldValue {
                probeRevision = UUID()
                kchatServers = []
                kchatServer = ""
                leave()
                probeLine = nil
                probeBad = false
            }
        }
    }
    public var user = "" { didSet { if user != oldValue { cancelCode(); password = ""; invitation = "" } } }
    public var password = ""
    public var code = ""
    public var registering = false
    public var recovering = false { didSet { if recovering != oldValue { closeRecoveryEmail() } } }
    public var invitation = ""
    public private(set) var canRegister = false
    public private(set) var canRecover = false
    public private(set) var canEmailRecover = false
    public private(set) var recoveryEmail: NativeRecoveryEmailState?
    /// The 2FA method the server asked a code for: the form shows the code field.
    public private(set) var method: String?
    public private(set) var nativeMethods: [String] = []
    public private(set) var pendingConfirmation = false
    public private(set) var nativeEmail: NativeFactorEmailState?
    public private(set) var error: String?
    public private(set) var busy = false
    public private(set) var knownServers: [String] = []
    /// What the server says about itself: its version and what it asks, or why it will not do.
    public private(set) var probeLine: String?
    /// kChat signs in with an Infomaniak API token in the password field.
    public private(set) var tokenLogin = false
    /// kChat: the account's team servers once it turned out to have several, and the one picked.
    public private(set) var kchatServers: [KchatServer] = []
    public var kchatServer = ""
    /// What sign-in goes to: the address typed, or for kChat the server picked, else its directory.
    public var address: String {
        guard kind == .kchat else { return server }
        return kchatServer.isEmpty ? "https://kchat.infomaniak.com" : kchatServer
    }
    public private(set) var probeBad = false
    @ObservationIgnored private var nativeAttempt: NativeLoginAttempt?
    @ObservationIgnored private var recoveryAttempt: NativeRecoveryEmail?
    @ObservationIgnored private var recoveryIdentity: (String, String)?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var probeRevision = UUID()
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
        canEmailRecover = false
        recoveryIdentity = nil
        self.error = error
    }

    /// Asks the typed server about itself; nothing shown for an address that is not one.
    public func probe(client: Client) async {
        let asked = address
        let expected = probeRevision
        canRegister = false
        canRecover = false
        canEmailRecover = false
        do {
            let p = try await client.probe(server: asked, kind: kind)
            guard asked == address, expected == probeRevision else { return }
            tokenLogin = p.genre == "kchat"
            canRegister = p.genre == "rocketvibe" && p.accountInvitations
            canRecover = p.genre == "rocketvibe" && p.accountRecovery
            canEmailRecover = canRecover && p.emailRecovery
            if let instance = p.instanceId, let epoch = p.dataEpoch { recoveryIdentity = (instance, epoch) }
            else { recoveryIdentity = nil }
            if !p.passwordLogin {
                probeLine = L("login.probe_no_password")
                probeBad = true
                return
            }
            let product = ["rocketvibe": "RocketVibe", "mattermost": "Mattermost", "kchat": "kChat"][p.genre] ?? "Rocket.Chat"
            var facts = ["\(product) \(p.version)".trimmingCharacters(in: .whitespaces)]
            if tokenLogin { facts.append(L("login.kchat_help")) }
            if p.twoFactor { facts.append(L("login.probe_2fa")) }
            if p.e2e { facts.append(L("login.probe_e2e")) }
            probeLine = facts.joined(separator: " · ")
            probeBad = false
        } catch RvError.Local {
            if asked == address, expected == probeRevision { probeLine = nil }
        } catch let RvError.Server(_, _, errorCode, _, _, _) {
            guard asked == address, expected == probeRevision else { return }
            probeLine = L(errorCode == "not_native" ? "login.not_rocketvibe" : "login.probe_failed")
            probeBad = true
        } catch {
            guard asked == address, expected == probeRevision else { return }
            probeLine = L("login.probe_failed")
            probeBad = true
        }
    }

    public func cancelCode() {
        generation = UUID()
        closeRecoveryEmail()
        if nativeAttempt != nil { password = "" }
        nativeAttempt?.close()
        nativeAttempt = nil
        nativeMethods = []
        nativeEmail = nil
        pendingConfirmation = false
        method = nil
        code = ""
        error = nil
        busy = false
    }

    private func closeRecoveryEmail() {
        recoveryAttempt?.close()
        recoveryAttempt = nil
        recoveryEmail = nil
    }

    /// Reading the request vault never sends an email or performs discovery.
    public func loadRecoveryEmail(client: Client) async {
        guard !busy, recovering, canEmailRecover, let (instance, epoch) = recoveryIdentity else { return }
        let expected = generation
        let (address, username) = (server, user.trimmingCharacters(in: .whitespaces))
        guard username.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else { return }
        closeRecoveryEmail()
        do {
            let attempt = try await client.nativeEmailRecovery(server: address, user: username, instanceId: instance, dataEpoch: epoch)
            guard current(expected, address: address, username: username), recovering, canEmailRecover else { attempt.close(); return }
            recoveryAttempt = attempt
            recoveryEmail = attempt.snapshot()
        } catch {
            guard current(expected, address: address, username: username) else { return }
            self.error = L("recovery_email.storage")
        }
    }

    public func refreshRecoveryEmail() { recoveryEmail = recoveryAttempt?.snapshot() }

    public func sendRecoveryEmail(forget: Bool, revision: UInt64) async {
        guard !busy, recovering, let attempt = recoveryAttempt else { return }
        let expected = generation
        let (address, username) = (server, user.trimmingCharacters(in: .whitespaces))
        guard current(expected, address: address, username: username) else { return }
        busy = true; error = nil
        defer { if expected == generation { busy = false } }
        do {
            if forget { try await attempt.forget(viewRevision: revision) }
            else { try await attempt.submit(viewRevision: revision) }
        } catch {
            guard current(expected, address: address, username: username), recoveryAttempt === attempt else { return }
            if case let RvError.Server(status, _, code, _, _, _) = error {
                self.error = L(status == 429 ? "recovery_email.limited" : code == "server_identity_changed" ? "recovery_email.changed"
                    : code == "secure_storage_unavailable" ? "recovery_email.storage" : "recovery_email.failed")
            } else { self.error = L("recovery_email.failed") }
        }
        guard current(expected, address: address, username: username), recoveryAttempt === attempt else { return }
        refreshRecoveryEmail()
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
        expected == generation && address == self.address
            && username == user.trimmingCharacters(in: .whitespaces) && !Task.isCancelled
    }

    private func refreshNativeForm(_ attempt: NativeLoginAttempt) {
        nativeMethods = attempt.methods().filter { $0 == "totp" || $0 == "email" || $0 == "recovery_code" }
        if method == nil || !nativeMethods.contains(method!) { method = nativeMethods.first }
        pendingConfirmation = attempt.pendingConfirmation()
        nativeEmail = attempt.emailDelivery()
        code = ""
    }

    public func sendNativeEmail(resend: Bool, revision: UInt64) async {
        guard !busy, method == "email", let attempt = nativeAttempt else { return }
        let expected = generation
        let (address, username) = (server, user.trimmingCharacters(in: .whitespaces))
        guard current(expected, address: address, username: username) else { return }
        code = ""; busy = true; error = nil
        defer { if expected == generation { busy = false } }
        do {
            _ = try await attempt.sendEmail(resend: resend, viewRevision: revision)
            guard current(expected, address: address, username: username), nativeAttempt === attempt else { return }
            refreshNativeForm(attempt)
        } catch {
            guard current(expected, address: address, username: username), nativeAttempt === attempt else { return }
            refreshNativeForm(attempt)
            if case let RvError.Server(status, message, code, _, _, _) = error {
                if code == "email_resend_cooldown" || code == "email_delivery_limit" || code == "email_queue_limit" {
                    self.error = L("email.limited")
                } else if code == "factor_expired" { self.error = L("login.factor_expired") }
                else if code == "unsupported_feature" || code == "factor_unavailable" { self.error = L("login.factor_unavailable") }
                else if code == "secure_storage_unavailable" { self.error = L("login.secure_storage") }
                else { self.error = Self.describe(status: status, message: message, askingCode: true) }
            } else { self.error = L("security.failed") }
        }
    }

    /// Signs in, or asks for the code the server wants.
    func submit(client: Client) async -> ChatProvider? {
        guard !busy else { return nil }
        let (address, username, secret, challenge, answer) =
            (self.address, user.trimmingCharacters(in: .whitespaces), password, method, code)
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
                let native = try await client.isNativeServer(server: address, kind: kind)
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
                        server: address, kind: kind, user: username, password: secret,
                        method: challenge, code: asking ? answer : nil))
                    guard current(expected, address: address, username: username) else { chat.shutdown(); return nil }
                }
            }
            nativeAttempt = nil
            nativeMethods = []
            nativeEmail = nil
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
            if errorCode == "not_native" { error = L("login.not_rocketvibe"); return nil }
            if errorCode == "kchat_several_servers" {
                kchatServers = (try? await client.kchatServers(token: secret)) ?? []
                kchatServer = kchatServers.first?.url ?? ""
                error = L("login.kchat_pick_server")
                return nil
            }
            if kind == .kchat && status == 401 { error = L("login.kchat_token_rejected"); return nil }
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
