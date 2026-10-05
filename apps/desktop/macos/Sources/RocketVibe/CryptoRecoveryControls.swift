import RocketVibeKit
import SwiftUI

struct CryptoBackupControls: View {
    let model: CryptoModel
    let status: CryptoBackupStatus
    @State private var cancel = false
    var body: some View {
        Group {
            Text(L("crypto.backup_title")).font(.headline)
            Text(L("crypto.backup_explanation")).font(.caption).foregroundStyle(.secondary)
            if let receipt = status.receipt {
                Text(L("crypto.backup_version") + " : " + receipt.backupRevision).font(.caption)
            }
            if status.controlsRoot {
                if !status.pending {
                    Button(L("crypto.backup_review")) { Task { await model.reviewBackup() } }
                }
                if let preview = model.backupApproval {
                    CryptoBackupConfirmation(model: model, preview: preview)
                }
                if status.pending {
                    Text(L(status.cancelRequested ? "crypto.backup_cancelling" : "crypto.backup_pending")).font(.caption)
                    Button(L("crypto.backup_show_code")) { Task { await model.showRecoveryCode() } }
                    if !model.recoveryCode.isEmpty {
                        Text(model.recoveryCode).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    }
                    if !status.codeSaved {
                        Button(L("crypto.backup_saved")) { Task { await model.confirmCodeSaved() } }
                            .disabled(model.recoveryCode.isEmpty)
                    }
                    if status.codeSaved || status.cancelRequested {
                        Button(L("crypto.backup_resume")) { Task { await model.resumeBackup() } }
                    }
                    if !status.cancelRequested {
                        Button(L("crypto.backup_cancel"), role: .destructive) { cancel = true }
                    }
                }
            } else {
                Text(L("crypto.backup_root_only")).font(.caption).foregroundStyle(.secondary)
            }
        }
        .alert(L("crypto.backup_cancel"), isPresented: $cancel) {
            Button(L("actions.cancel"), role: .cancel) {}
            Button(L("crypto.backup_cancel"), role: .destructive) { Task { await model.cancelBackup() } }
        } message: { Text(L("crypto.backup_cancel_body")) }
        .onDisappear { cancel = false }
    }
}

private struct CryptoBackupConfirmation: View {
    let model: CryptoModel
    let preview: CryptoBackupPreview
    var body: some View {
        Group {
            Text(preview.rootFingerprint).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            Text(L("crypto.backup_version") + " : " + (preview.backupRevision ?? L("crypto.backup_none"))).font(.caption)
            Text(L("crypto.backup_replace")).font(.caption)
            Button(L("crypto.backup_prepare")) { Task { await model.prepareBackup() } }
            Button(L("actions.cancel")) { Task { await model.refresh() } }
        }
    }
}

struct CryptoRestoreControls: View {
    let model: CryptoModel
    var body: some View {
        Group {
            Text(L("crypto.restore_title")).font(.headline)
            Text(L("crypto.restore_explanation")).font(.caption).foregroundStyle(.secondary)
            SecureField(L("crypto.backup_code"), text: Binding(get: { model.restoreCode }, set: { model.restoreCode = $0 }))
            Button(L("crypto.restore_review")) { Task { await model.reviewRestore() } }
                .disabled(model.restoreCode.isEmpty)
            if let preview = model.restoreApproval {
                Text(preview.rootFingerprint).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                Text(preview.backupId).font(.caption).textSelection(.enabled)
                Text(L("crypto.restore_compare")).font(.caption)
                Button(L("crypto.restore_confirm")) { Task { await model.confirmRestore() } }
                Button(L("actions.cancel")) { Task { await model.refresh() } }
            }
        }
    }
}
