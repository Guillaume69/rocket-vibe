import Foundation
import Observation
import RocketVibeCore

/// Account-scoped device settings, shared by the SwiftUI view and real-server tests.
@MainActor @Observable
public final class DevicesModel {
    public private(set) var rows: [NativeDeviceSession] = []
    public var labels: [String: String] = [:]
    public private(set) var busy = false
    public private(set) var error: String?
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private let chat: NativeChat?
    @ObservationIgnored private let accountId: UUID

    public init(app: AppModel) {
        self.app = app
        chat = app.native
        accountId = app.sessionId
    }
    private var active: Bool { app?.sessionId == accountId && app?.native === chat && chat != nil }

    public func load() async { await run {} }
    public func rename(_ device: NativeDeviceSession) async {
        guard let chat else { return }
        let label = labels[device.id] ?? device.label
        await run { try await chat.renameDevice(id: device.id, label: label) }
    }
    public func revoke(_ device: NativeDeviceSession) async {
        guard let chat, !device.current else { return }
        await run { try await chat.revokeDevice(id: device.id) }
    }
    private func run(_ action: () async throws -> Void) async {
        guard active, !busy, let chat else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await action()
            guard active else { return }
            let fresh = try await chat.deviceSessions()
            guard active else { return }
            rows = fresh
            labels = Dictionary(uniqueKeysWithValues: fresh.map { ($0.id, $0.label) })
        } catch {
            guard active else { return }
            if case let RvError.Server(_, _, code, _, _, _) = error, code == "reauthentication_required" {
                self.error = L("devices.reauth")
            } else { self.error = L("devices.failed") }
        }
    }
}
