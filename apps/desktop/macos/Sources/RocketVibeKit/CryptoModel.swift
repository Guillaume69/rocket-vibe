import Foundation
import Observation
import RocketVibeCore

/// The same account/viewer fences as the existing security settings. This model
/// only displays public fingerprints/codes; consent and all keys stay in Rust.
@MainActor @Observable
public final class CryptoModel {
    public private(set) var value: NativeCryptoState?
    public private(set) var approval: NativeCryptoApproval?
    public private(set) var output = ""
    public private(set) var busy = false
    public private(set) var error: String?
    public var code = ""
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private let chat: NativeChat?
    @ObservationIgnored private let accountId: UUID
    @ObservationIgnored private var handle: NativeCrypto?
    @ObservationIgnored private var visible = true
    @ObservationIgnored private var generation = UUID()

    public init(app: AppModel) { self.app = app; chat = app.native; accountId = app.sessionId }
    private func current(_ expected: UUID) -> Bool {
        visible && generation == expected && app?.sessionId == accountId && app?.native === chat && chat != nil && !Task.isCancelled
    }
    public func close() {
        visible = false; generation = UUID(); handle?.close(); handle = nil
        value = nil; approval = nil; output = ""; code = ""; error = nil; busy = false
    }
    private enum Outcome { case view(NativeCryptoState), preview(NativeCryptoApproval), grant(String) }
    public func refresh() async { await run { .view(try await $0.refresh()) } }
    public func begin() async {
        guard let value else { return }
        let expected = value.remoteFingerprint
        await run { .view(try await $0.begin(expectedFingerprint: expected)) }
    }
    public func preview(own: Bool) async {
        let request = own ? value?.requestCode ?? "" : code.trimmingCharacters(in: .whitespacesAndNewlines)
        await run { .preview(try await $0.preview(requestCode: request)) }
    }
    public func renew() async {
        guard let value else { return }
        let expected = value.rootFingerprint
        await run { .view(try await $0.renew(expectedFingerprint: expected)) }
    }
    public func approve() async {
        guard let approval else { return }
        let revision = approval.viewRevision
        await run { .grant(try await $0.approve(viewRevision: revision)) }
    }
    public func install() async {
        let grant = code.trimmingCharacters(in: .whitespacesAndNewlines)
        await run(recoverRegistration:true) { .view(try await $0.install(code: grant)) }
    }
    public func resume() async { await run(recoverRegistration:true) { .view(try await $0.resume()) } }
    public func copyOutput(receive: @MainActor (String) -> Void) {
        guard current(generation), !busy, handle?.isClosed() == false, !output.isEmpty else { return }
        receive(output)
    }
    private func run(recoverRegistration: Bool = false, _ action: (NativeCrypto) async throws -> Outcome) async {
        let expected = generation
        guard current(expected), !busy, let chat else { return }
        busy = true; error = nil
        defer { if generation == expected { busy = false } }
        do {
            let active: NativeCrypto
            if let handle { active = handle }
            else {
                let opened = try await chat.cryptoSettings()
                guard current(expected) else { opened.close(); return }
                handle = opened; active = opened
            }
            let fresh = try await action(active)
            guard current(expected) else { return }
            switch fresh {
            case .view(let fresh): value = fresh; approval = nil; output = fresh.requestCode; code = ""
            case .preview(let fresh): approval = fresh
            case .grant(let fresh): approval = nil; output = fresh; code = fresh
            }
        } catch {
            guard current(expected) else { return }
            if recoverRegistration, let handle, let fresh = try? await handle.refresh() {
                guard current(expected) else { return }
                value = fresh; output = fresh.requestCode; code = ""
            }
            guard current(expected) else { return }
            approval = nil
            if handle?.isClosed() == true { handle?.close(); handle = nil; value = nil; output = ""; code = "" }
            self.error = L("crypto.failed")
        }
    }
}

public func cryptoPhaseTitle(_ phase: NativeCryptoPhase) -> String {
    switch phase {
    case .missing: return L("crypto.missing")
    case .identityCreated: return L("crypto.created")
    case .waitingForApproval: return L("crypto.waiting")
    case .registering: return L("crypto.registering")
    case .ready: return L("crypto.ready")
    case .expired: return L("crypto.expired")
    case .renewing: return L("crypto.renewing")
    }
}
