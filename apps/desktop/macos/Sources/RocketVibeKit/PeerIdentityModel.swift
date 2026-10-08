import Foundation
import Observation
import RocketVibeCore

@MainActor @Observable
public final class PeerIdentityModel {
    public private(set) var value: NativePeerState?
    public private(set) var busy = false
    public private(set) var error: String?
    public var confirmed = ""
    public var previous = ""
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private let chat: NativeChat?
    @ObservationIgnored private let account: UUID
    @ObservationIgnored private let user: String
    @ObservationIgnored private var handle: NativeCryptoPeer?
    @ObservationIgnored private var visible = true
    @ObservationIgnored private var generation = UUID()

    public init(app: AppModel, user: String) { self.app = app; chat = app.native; account = app.sessionId; self.user = user }
    private func current(_ expected: UUID) -> Bool {
        visible && generation == expected && app?.sessionId == account && app?.native === chat && chat != nil && !Task.isCancelled
    }
    public func close() {
        visible = false; generation = UUID(); handle?.close(); handle = nil
        value = nil; error = nil; confirmed = ""; previous = ""; busy = false
    }
    public func refresh() async { await run { try await $0.refresh() } }
    public func pin(_ action: NativePeerRootAction) async {
        guard let value else { return }
        let code = action == .firstContact ? value.fingerprint : confirmed.trimmingCharacters(in: .whitespacesAndNewlines)
        let old = previous.trimmingCharacters(in: .whitespacesAndNewlines)
        await run { try await $0.pinRoot(revision: value.revision, action: action, confirmed: code, previous: old) }
    }
    public func preview(device: String) async {
        guard let value else { return }
        await run { try await $0.previewDevice(revision: value.revision, device: device) }
    }
    public func approve() async {
        guard let value, value.approval != nil else { return }
        await run { try await $0.approveDevice(revision: value.revision) }
    }
    private func run(_ action: (NativeCryptoPeer) async throws -> NativePeerState) async {
        let expected = generation
        guard current(expected), !busy, let chat else { return }
        busy = true; error = nil
        defer { if expected == generation { busy = false } }
        do {
            let active: NativeCryptoPeer
            if let handle { active = handle }
            else {
                let opened = try await chat.cryptoPeer(user: user)
                guard current(expected) else { opened.close(); return }
                handle = opened; active = opened
            }
            let fresh = try await action(active)
            guard current(expected) else { return }
            value = fresh; confirmed = ""; previous = ""
        } catch {
            guard current(expected) else { return }
            value = nil; confirmed = ""; previous = ""; self.error = L("crypto.failed")
            if handle?.isClosed() == true { handle?.close(); handle = nil }
        }
    }
}

/// What to do next in a member's identity check, said where it is seen: the
/// device list where the approval happens comes after it.
public func peerNextStep(_ value: NativePeerState) -> String? {
    switch value.trust {
    case .unknown: return L("crypto.peer_next_pin")
    case .changed: return nil
    case .unverified, .verified:
        if value.devices.isEmpty { return L("crypto.peer_no_devices") }
        return L(value.devices.contains { !$0.approved } ? "crypto.peer_next_devices" : "crypto.peer_all_approved")
    }
}

/// A crypto failure as shown: an untrusted member says what to do.
public func cryptoFailure(_ error: Error) -> String {
    // A bot member blocks the group: it must leave first (RFC 0003).
    if case let RvError.Server(_, _, code, _, _, _) = error, code == "crypto_bot_member" {
        return L(botErrorKey(code: "crypto_bot_member"))
    }
    if case RvError.Local(let message) = error, message == "crypto_peer_untrusted" {
        return L("crypto.group_untrusted")
    }
    return L("crypto.failed")
}

public func peerTrustTitle(_ trust: NativePeerTrust) -> String {
    switch trust {
    case .unknown: return L("crypto.peer_unknown")
    case .unverified: return L("crypto.peer_unverified")
    case .verified: return L("crypto.peer_verified")
    case .changed: return L("crypto.peer_changed")
    }
}
