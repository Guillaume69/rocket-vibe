import Foundation
import Observation
import RocketVibeCore

@MainActor @Observable
public final class CryptoRoomModel {
    public private(set) var value: NativeGroupState?
    public private(set) var busy = false
    public private(set) var error: String?
    public var included: Set<String> = []
    public var removed: Set<String> = []
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private let chat: NativeChat?
    @ObservationIgnored private let account: UUID
    @ObservationIgnored private let room: String
    @ObservationIgnored private var handle: NativeCryptoRoom?
    @ObservationIgnored private var visible = true
    @ObservationIgnored private var generation = UUID()

    public init(app: AppModel, room: String) { self.app = app; chat = app.native; account = app.sessionId; self.room = room }
    private func current(_ expected: UUID) -> Bool {
        visible && generation == expected && app?.sessionId == account && app?.native === chat && chat != nil && !Task.isCancelled
    }
    public func close() {
        visible = false; generation = UUID(); handle?.close(); handle = nil
        value = nil; error = nil; included = []; removed = []; busy = false
    }
    public func refresh() async { await run { try await $0.refresh() } }
    public func prepareDevice() async {
        guard let value else { return }; await run { try await $0.publishPackages(revision: value.revision) }
    }
    private func targets(_ value: NativeGroupState) -> [NativeGroupTarget] {
        value.devices.filter { $0.eligible && included.contains($0.id) }.map { NativeGroupTarget(user: $0.user, device: $0.device) }
    }
    public func create() async {
        guard let value else { return }; let devices = targets(value)
        await run { try await $0.previewCreate(revision: value.revision, devices: devices) }
    }
    public func change() async {
        guard let value else { return }; let devices = targets(value)
        let removals = value.participants.filter { removed.contains($0.id) }.map(\.device)
        await run { try await $0.previewChange(revision: value.revision, removals: removals, devices: devices) }
    }
    public func reviewEvent() async {
        guard let value else { return }; await run { try await $0.previewEvent(revision: value.revision) }
    }
    public func confirm() async {
        guard let value, let review = value.review else { return }
        await run { try await $0.confirm(revision: value.revision, fingerprint: review.fingerprint) }
    }
    public func resume() async { guard let value else { return }; await run { try await $0.resume(revision: value.revision) } }
    public func cancel() async { guard let value else { return }; await run { try await $0.cancel(revision: value.revision) } }
    private func run(_ action: (NativeCryptoRoom) async throws -> NativeGroupState) async {
        let expected = generation
        guard current(expected), !busy, let chat else { return }
        busy = true; error = nil
        defer { if expected == generation { busy = false } }
        do {
            let active: NativeCryptoRoom
            if let handle { active = handle }
            else {
                let opened = try await chat.cryptoRoom(room: room)
                guard current(expected) else { opened.close(); return }
                handle = opened; active = opened
            }
            let fresh = try await action(active)
            guard current(expected) else { return }
            value = fresh; included = []; removed = []
        } catch {
            guard current(expected) else { return }
            value = nil; included = []; removed = []; self.error = L("crypto.failed")
            if handle?.isClosed() == true { handle?.close(); handle = nil }
        }
    }
}

public func groupPhaseTitle(_ phase: NativeGroupPhase) -> String {
    switch phase {
    case .empty: return L("crypto.group_empty")
    case .needsAdmission: return L("crypto.group_admission")
    case .acknowledged: return L("crypto.group_ack")
    case .pending: return L("crypto.group_pending")
    }
}
