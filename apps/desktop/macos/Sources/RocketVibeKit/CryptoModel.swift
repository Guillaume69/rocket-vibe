import Foundation
import Observation
import RocketVibeCore

/// The same account/viewer fences as the existing security settings. This model
/// displays recovery codes only on explicit request; consent and keys stay in Rust.
@MainActor @Observable
public final class CryptoModel {
    public private(set) var value: NativeCryptoState?
    public private(set) var approval: NativeCryptoApproval?
    public private(set) var withdrawals: CryptoWithdrawalStatus?
    public private(set) var withdrawalApproval: CryptoWithdrawalPreview?
    public private(set) var backups: CryptoBackupStatus?
    public private(set) var backupApproval: CryptoBackupPreview?
    public private(set) var restoreApproval: CryptoRestorePreview?
    public private(set) var recoveryCode = ""
    public var restoreCode = ""
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
        value = nil; approval = nil; withdrawals = nil; withdrawalApproval = nil; output = ""; code = ""; error = nil; busy = false
        backups = nil; backupApproval = nil; restoreApproval = nil; recoveryCode = ""; restoreCode = ""
    }
    private enum Outcome {
        case view(NativeCryptoState), preview(NativeCryptoApproval), grant(String)
        case withdrawals(CryptoWithdrawalStatus), withdrawalPreview(CryptoWithdrawalPreview)
        case backups(CryptoBackupStatus), backupPreview(CryptoBackupPreview), restorePreview(CryptoRestorePreview), recoveryCode(String)
    }
    private struct DisplayCode: Decodable { let code: String }
    private struct Restored: Decodable { let restored: Bool }
    private func recovery<T: Decodable>(_ handle: NativeCrypto, _ input: [String: String]) async throws -> T {
        let input = String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self)
        let output = try await handle.recoveryAction(input: input)
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: Data(output.utf8))
    }
    public func refreshRecovery() async {
        await run { .backups(try await recovery($0, ["action":"view"])) }
    }
    public func reviewBackup() async {
        await run { .backupPreview(try await recovery($0, ["action":"preview_backup"])) }
    }
    public func prepareBackup() async {
        guard let selected = backupApproval else { return }
        await run(recoverBackup: true) { .backups(try await recovery($0, ["action":"prepare_backup", "id":selected.id])) }
    }
    public func showRecoveryCode() async {
        await run { handle in
            let displayed: DisplayCode = try await recovery(handle, ["action":"code"])
            return .recoveryCode(displayed.code)
        }
    }
    public func confirmCodeSaved() async {
        await run(recoverBackup: true) { .backups(try await recovery($0, ["action":"confirm_saved"])) }
    }
    public func resumeBackup() async {
        await run(recoverBackup: true) { .backups(try await recovery($0, ["action":"resume"])) }
    }
    public func cancelBackup() async {
        await run(recoverBackup: true) { .backups(try await recovery($0, ["action":"cancel"])) }
    }
    public func reviewRestore() async {
        let entered = restoreCode
        let fingerprint = value?.remoteFingerprint ?? ""
        await run { .restorePreview(try await recovery($0, ["action":"preview_restore", "code":entered, "fingerprint":fingerprint])) }
    }
    public func confirmRestore() async {
        guard let selected = restoreApproval else { return }
        await run(recoverRegistration: true) { handle in
            let _: Restored = try await recovery(handle, ["action":"restore", "id":selected.id])
            return .view(try await handle.refresh())
        }
    }
    private func withdrawal<T: Decodable>(_ handle: NativeCrypto, _ input: [String: String]) async throws -> T {
        let input = String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self)
        let output = try await handle.withdrawalAction(input: input)
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: Data(output.utf8))
    }
    public func reviewWithdrawal(_ device: CryptoWithdrawalDevice) async {
        await run { .withdrawalPreview(try await withdrawal($0, ["action":"preview", "device":device.device, "fingerprint":device.fingerprint])) }
    }
    public func confirmWithdrawal() async {
        guard let selected = withdrawalApproval else { return }
        await run(recoverWithdrawal: true) { .withdrawals(try await withdrawal($0, ["action":"confirm", "id":selected.id])) }
    }
    public func resumeWithdrawal() async {
        await run(recoverWithdrawal: true) { .withdrawals(try await withdrawal($0, ["action":"resume"])) }
    }
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
    private func run(recoverRegistration: Bool = false, recoverWithdrawal: Bool = false, recoverBackup: Bool = false, _ action: (NativeCrypto) async throws -> Outcome) async {
        let expected = generation
        guard current(expected), !busy, let chat else { return }
        busy = true; error = nil
        recoveryCode = ""; restoreCode = ""
        backupApproval = nil; restoreApproval = nil
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
            case .view(let fresh):
                value = fresh; approval = nil; withdrawalApproval = nil; output = fresh.requestCode; code = ""
                backupApproval = nil; restoreApproval = nil; backups = nil
                if fresh.phase == .ready || fresh.phase == .expired {
                    let status: CryptoWithdrawalStatus = try await withdrawal(active, ["action":"view"])
                    guard current(expected) else { return }; withdrawals = status
                    let backup: CryptoBackupStatus = try await recovery(active, ["action":"view"])
                    guard current(expected) else { return }; backups = backup
                } else { withdrawals = nil }
            case .preview(let fresh): approval = fresh
            case .grant(let fresh): approval = nil; output = fresh; code = fresh
            case .withdrawals(let fresh): withdrawals = fresh; withdrawalApproval = nil; approval = nil
            case .withdrawalPreview(let fresh): withdrawalApproval = fresh; approval = nil
            case .backups(let fresh): backups = fresh; backupApproval = nil; restoreApproval = nil; approval = nil
            case .backupPreview(let fresh): backupApproval = fresh; restoreApproval = nil; approval = nil; withdrawalApproval = nil
            case .restorePreview(let fresh): restoreApproval = fresh; backupApproval = nil; approval = nil; withdrawalApproval = nil
            case .recoveryCode(let fresh): recoveryCode = fresh
            }
        } catch {
            guard current(expected) else { return }
            recoveryCode = ""; restoreCode = ""; backupApproval = nil; restoreApproval = nil
            if recoverBackup, let handle, let fresh: CryptoBackupStatus = try? await recovery(handle, ["action":"view"]) {
                guard current(expected) else { return }; backups = fresh
            }
            if recoverWithdrawal, let handle, let fresh: CryptoWithdrawalStatus = try? await withdrawal(handle, ["action":"view"]) {
                guard current(expected) else { return }; withdrawals = fresh
            }
            if recoverRegistration, let handle, let fresh = try? await handle.refresh() {
                guard current(expected) else { return }
                value = fresh; output = fresh.requestCode; code = ""
            }
            guard current(expected) else { return }
            approval = nil
            withdrawalApproval = nil
            if handle?.isClosed() == true { handle?.close(); handle = nil; value = nil; withdrawals = nil; backups = nil; output = ""; code = "" }
            if case let RvError.Server(_, _, code, _, _, _) = error, code == "reauthentication_required" {
                self.error = L("devices.reauth")
            } else { self.error = L("crypto.failed") }
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
