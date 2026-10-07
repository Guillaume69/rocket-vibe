import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

struct CryptoSection: View {
    @Environment(AppModel.self) var app
    @State private var model: CryptoModel?
    var body: some View {
        Section(L("crypto.title")) {
            Text(L("crypto.explanation")).font(.caption).foregroundStyle(.secondary)
            if let model {
                if model.busy { ProgressView(L("crypto.loading")) }
                if let value = model.value {
                    CryptoIdentitySummary(model: model, value: value)
                    CryptoIdentityControls(model: model, value: value)
                    if let withdrawals = model.withdrawals {
                        CryptoWithdrawalControls(model: model, status: withdrawals)
                    }
                    if let backups = model.backups {
                        CryptoBackupControls(model: model, status: backups)
                    }
                    if value.phase == .missing && !value.remoteFingerprint.isEmpty {
                        CryptoRestoreControls(model: model)
                    }
                    if value.phase == .ready {
                        CryptoHistoryControls(model: model)
                    }
                    if value.phase == .ready, let backup = model.historyBackup {
                        CryptoHistoryBackupControls(model: model, status: backup)
                    }
                    if value.phase != .missing, let storage = model.storage {
                        CryptoStorageControls(model: model, status: storage)
                    }
                }
                if let error = model.error { Text(error).foregroundStyle(.red) }
                Button(L("crypto.refresh")) { Task { await model.refresh() } }
            }
        }
        .disabled(model?.busy == true)
        .task(id: app.sessionId) {
            model?.close()
            let fresh = CryptoModel(app: app); model = fresh; await fresh.refresh()
        }
        .onDisappear { model?.close() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in
            model?.close(); model = nil
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            guard model == nil else { return }
            let fresh = CryptoModel(app: app); model = fresh
            Task { await fresh.refresh() }
        }
    }
}

private struct CryptoIdentitySummary: View {
    let model: CryptoModel
    let value: NativeCryptoState
    var body: some View {
        Group {
            Text(cryptoPhaseTitle(value.phase))
            if let expires = value.certificateExpiresAt {
                Text(L("crypto.expires") + " : " + Date(timeIntervalSince1970:TimeInterval(expires)).formatted(date:.abbreviated,time:.shortened))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(L("crypto.root")).font(.caption)
            Text(model.approval?.rootFingerprint ?? (value.rootFingerprint.isEmpty ? value.remoteFingerprint : value.rootFingerprint))
                .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            if let approval = model.approval {
                Text(L("crypto.compare")).font(.caption)
                Text(approval.device).textSelection(.enabled)
                Text(approval.requestFingerprint).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                Button(L("crypto.approve")) { Task { await model.approve() } }
            } else if !value.requestFingerprint.isEmpty {
                Text(L("crypto.proof")).font(.caption)
                Text(value.requestFingerprint).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            }
        }
    }
}

private struct CryptoIdentityControls: View {
    let model: CryptoModel
    let value: NativeCryptoState
    var body: some View {
        Group {
            if value.phase == .missing || value.phase == .identityCreated || value.phase == .waitingForApproval {
                Button(L("crypto.begin")) { Task { await model.begin() } }
            }
            if value.phase == .ready || value.phase == .expired || value.phase == .renewing {
                Button(L("crypto.renew")) { Task { await model.renew() } }
                    .disabled(model.withdrawals?.pending != nil || model.backups?.pending == true)
            }
            if value.controlsRoot && !value.requestCode.isEmpty {
                Button(L("crypto.own_preview")) { Task { await model.preview(own: true) } }
            }
            Text(L("crypto.compare")).font(.caption).foregroundStyle(.secondary)
            TextField(L("crypto.code"), text: Binding(get: { model.code }, set: { model.code = $0 }))
            if value.controlsRoot { Button(L("crypto.preview")) { Task { await model.preview(own: false) } } }
            if value.phase == .identityCreated || value.phase == .waitingForApproval || value.phase == .renewing {
                Button(L("crypto.install")) { Task { await model.install() } }
            }
            if value.phase == .registering { Button(L("crypto.resume")) { Task { await model.resume() } } }
            if !model.output.isEmpty {
                Text(L(model.code == model.output ? "crypto.grant_ready" : "crypto.association")).font(.caption)
                Text(model.output).font(.system(.caption, design: .monospaced)).lineLimit(4).textSelection(.enabled)
                Button(L("crypto.copy")) { model.copyOutput { code in
                    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(code, forType: .string)
                } }
            }
        }
    }
}

private struct CryptoWithdrawalControls: View {
    let model: CryptoModel
    let status: CryptoWithdrawalStatus
    @State private var confirm = false
    private var confirmation: String {
        let selected = model.withdrawalApproval
        return [L("crypto.withdrawal_body"), selected?.device ?? "", selected?.fingerprint ?? "", selected?.incarnation ?? ""].joined(separator: "\n\n")
    }
    var body: some View {
        Group {
            Text(L("crypto.withdrawals")).font(.headline)
            if !status.controlsRoot { Text(L("crypto.withdrawal_root_only")).font(.caption).foregroundStyle(.secondary) }
            ForEach(status.devices) { device in
                Text(device.device).textSelection(.enabled)
                if let expires = Double(device.expiresAt) {
                    Text(L("crypto.expires") + " : " + Date(timeIntervalSince1970:expires).formatted(date:.abbreviated,time:.shortened))
                        .font(.caption).foregroundStyle(.secondary)
                }
                if status.controlsRoot {
                    Button(L("crypto.withdrawal_review")) { Task { await model.reviewWithdrawal(device) } }
                        .disabled(status.pending != nil)
                }
            }
            if let preview = model.withdrawalApproval {
                Text(preview.device).textSelection(.enabled)
                Text(preview.fingerprint).font(.system(.caption,design:.monospaced)).textSelection(.enabled)
                Text(preview.incarnation).font(.system(.caption,design:.monospaced)).textSelection(.enabled)
                Button(L("crypto.withdrawal_confirm")) { confirm = true }
            }
            if let pending = status.pending {
                Text(L("crypto.withdrawal_pending") + " : " + pending.device).font(.caption)
                Button(L("crypto.withdrawal_resume")) { Task { await model.resumeWithdrawal() } }
            }
            ForEach(status.withdrawn) { device in
                Text(L("crypto.withdrawn") + " : " + device.device + " · " + device.incarnation)
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .confirmOverlay(
            isPresented: $confirm,
            title: L("crypto.withdrawal_confirm"),
            message: confirmation,
            actions: [ModalAction(title: L("crypto.withdrawal_confirm"), role: .destructive) { Task { await model.confirmWithdrawal() } }]
        )
        .onDisappear { confirm = false }
    }
}
