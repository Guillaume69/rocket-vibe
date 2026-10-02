import Foundation
import Observation
import RocketVibeCore

/// Private settings on one existing account/family. The opaque Rust handle
/// owns proof/intention IDs; Swift only keeps transient display/input values.
@MainActor @Observable
public final class SecurityModel {
    public private(set) var value: NativeSecurityState?
    public private(set) var busy = false
    public private(set) var error: String?
    public var password = ""
    public var code = ""
    public var setupCode = ""
    public var emailAddress = ""
    public var emailCode = ""
    public var method = "" { didSet { if method != oldValue { code = "" } } }
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private let chat: NativeChat?
    @ObservationIgnored private let accountId: UUID
    @ObservationIgnored private var handle: NativeSecurity?
    @ObservationIgnored private var visible = true
    @ObservationIgnored private var generation = UUID()

    public init(app: AppModel) {
        self.app = app; chat = app.native; accountId = app.sessionId
    }
    private var belongs: Bool { app?.sessionId == accountId && app?.native === chat && chat != nil }
    private func current(_ expected: UUID) -> Bool {
        belongs && visible && generation == expected && !Task.isCancelled
    }
    public func close() {
        visible = false; generation = UUID()
        handle?.close(); handle = nil
        value = nil; password = ""; code = ""; setupCode = ""; method = ""
        emailAddress = ""; emailCode = ""
        busy = false; error = nil
    }
    public func open() async {
        guard belongs, !Task.isCancelled else { return }
        if !visible { visible = true; generation = UUID() }
        await refresh()
    }
    public func refresh() async { await run { try await $0.refresh() } }
    public func confirmPassword() async {
        let input = password; password = ""
        await run { try await $0.confirmPassword(password: input) }
    }
    public func confirmFactor() async {
        let (selected, input) = (method, code.trimmingCharacters(in: .whitespacesAndNewlines))
        code = ""
        await run { try await $0.confirmFactor(method: selected, code: input) }
    }
    public func sendProofEmail(resend: Bool, revision: UInt64) async {
        guard method == "email" else { return }
        code = ""
        await run { try await $0.sendProofEmail(resend: resend, viewRevision: revision) }
    }
    public func factor(_ action: NativeFactorAction, revision: UInt64) async {
        await run { try await $0.factorAction(action: action, viewRevision: revision) }
    }
    public func emailFactor(enabled: Bool, revision: UInt64) async {
        code = ""; setupCode = ""; emailCode = ""; emailAddress = ""
        await run { try await $0.emailFactorAction(enabled: enabled, viewRevision: revision) }
    }
    public func enable(revision: UInt64) async {
        let input = setupCode.trimmingCharacters(in: .whitespacesAndNewlines); setupCode = ""
        await run { try await $0.enable(code: input, viewRevision: revision) }
    }
    public func acknowledge(revision: UInt64) async {
        await run { try await $0.acknowledge(viewRevision: revision) }
    }
    public func startEmail(revision: UInt64) async {
        let input = emailAddress.trimmingCharacters(in: .whitespacesAndNewlines); emailAddress = ""; emailCode = ""
        await run { try await $0.startEmail(address: input, viewRevision: revision) }
    }
    public func confirmEmail(revision: UInt64) async {
        let input = emailCode.trimmingCharacters(in: .whitespacesAndNewlines); emailCode = ""
        await run { try await $0.confirmEmail(code: input, viewRevision: revision) }
    }
    public func removeEmail(revision: UInt64) async {
        emailAddress = ""; emailCode = ""
        await run { try await $0.removeEmail(viewRevision: revision) }
    }
    public func cancelEmail(revision: UInt64) async {
        emailCode = ""
        await run { try await $0.cancelEmail(viewRevision: revision) }
    }
    public func acknowledgeEmail(revision: UInt64) async {
        await run { try await $0.acknowledgeEmail(viewRevision: revision) }
    }
    /// The callback runs synchronously on MainActor immediately after the view
    /// guard check. A disappearing view cannot populate a clipboard afterwards.
    public func copy(_ kind: NativeSecurityCopy, revision: UInt64, receive: @MainActor (String) -> Void) async {
        let expected = generation
        guard current(expected), !busy, let handle else { return }
        busy = true; error = nil
        defer { if generation == expected { busy = false } }
        do {
            let text = try await handle.copy(kind: kind, viewRevision: revision)
            guard current(expected) else { return }
            receive(text)
        } catch {
            guard current(expected) else { return }
            failure(error, handle: handle)
        }
    }
    private func install(_ fresh: NativeSecurityState) {
        value = fresh
        if !fresh.methods.contains(method) { method = fresh.methods.first ?? "" }
        code = ""; setupCode = ""; emailCode = ""
    }
    private func run(_ action: (NativeSecurity) async throws -> NativeSecurityState) async {
        let expected = generation
        guard current(expected), !busy, let chat else { return }
        busy = true; error = nil
        defer { if generation == expected { busy = false } }
        do {
            let active: NativeSecurity
            if let handle { active = handle }
            else {
                let opened = try await chat.security()
                guard current(expected) else { opened.close(); return }
                handle = opened; active = opened
            }
            let fresh = try await action(active)
            guard current(expected) else { return }
            install(fresh)
        } catch {
            guard current(expected) else { return }
            if let handle { failure(error, handle: handle) }
            else { self.error = L("security.failed") }
        }
    }
    private func failure(_ caught: Error, handle: NativeSecurity) {
        var key = "security.failed"
        if case let RvError.Server(_, _, code, _, _, _) = caught {
            if code == "reauthentication_required" { key = "security.required" }
            else if code == "reauthentication_rejected" || code == "factor_rejected" { key = "security.rejected" }
            else if code == "invalid_email_address" { key = "email.invalid" }
            else if code == "email_verification_rejected" { key = "email.rejected" }
            else if code == "email_removal_rejected" { key = "email.removal_stale" }
            else if code == "email_queue_limit" || code == "email_delivery_limit" || code == "email_resend_cooldown" { key = "email.limited" }
        }
        if handle.isClosed() {
            handle.close(); self.handle = nil; value = nil
            password = ""; code = ""; setupCode = ""; method = ""
            emailAddress = ""; emailCode = ""
        }
        else { install(handle.state()) }
        self.error = L(key)
    }
}

public func nativeFactorTitle(_ method: String) -> String {
    L(method == "email" ? "login.factor_email" : method == "recovery_code" ? "login.factor_backup" : "login.factor_totp")
}
public func factorEmailStatus(_ value: NativeFactorEmailState) -> String {
    guard let delivery = value.delivery else { return L(value.requested ? "email.delivery_unknown" : "email.request_code") }
    switch delivery {
    case .queued: return L("email.queued")
    case .sending: return L("email.sending")
    case .deferred: return L("email.deferred")
    case .accepted: return L("email.accepted")
    case .exhausted: return L("email.exhausted")
    }
}
