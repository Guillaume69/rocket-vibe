import RocketVibeKit
import SwiftUI

/// History backup (path B): enabling a generation behind its own code, joining
/// it with the code, uploading now and restoring. The code shows only on
/// explicit request and is cleared when the settings close.
struct CryptoHistoryBackupControls: View {
    let model: CryptoModel
    let status: CryptoHistoryBackupStatus
    @State private var confirm = false
    var body: some View {
        Group {
            Text(L("crypto.history_backup_title")).font(.headline)
            Text(L("crypto.history_backup_explanation")).font(.caption).foregroundStyle(.secondary)
            Text(L(status.pending ? "crypto.history_backup_pending"
                : status.holdsKey ? "crypto.history_backup_on" : "crypto.history_backup_off")).font(.caption)
            if let generation = status.generation {
                Text(generation).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            }
            if !model.historyBackupResult.isEmpty {
                Text(model.historyBackupResult).font(.caption)
            }
            if status.pending {
                Button(L("crypto.history_backup_show_code")) { Task { await model.showHistoryCode() } }
                if !model.historyCode.isEmpty {
                    Text(model.historyCode).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                }
                if !status.codeSaved {
                    Button(L("crypto.history_backup_saved")) { Task { await model.confirmHistoryCodeSaved() } }
                        .disabled(model.historyCode.isEmpty)
                }
                if status.codeSaved || status.cancelRequested {
                    Button(L("crypto.history_backup_resume")) { Task { await model.resumeHistoryBackup() } }
                }
                if !status.cancelRequested {
                    Button(L("crypto.history_backup_cancel"), role: .destructive) { Task { await model.cancelHistoryBackup() } }
                }
            } else {
                Button(L(status.holdsKey ? "crypto.history_backup_rotate" : "crypto.history_backup_enable")) {
                    Task { await model.reviewHistoryBackup() }
                }
                if let review = model.historyBackupApproval {
                    Text(L(review.generationRevision == nil ? "crypto.history_backup_explanation" : "crypto.history_backup_replace"))
                        .font(.caption)
                    Button(L("crypto.history_backup_enable")) { confirm = true }
                }
                SecureField(L("crypto.history_backup_code"), text: Binding(get: { model.historyJoinCode }, set: { model.historyJoinCode = $0 }))
                Button(L("crypto.history_backup_join")) { Task { await model.joinHistoryBackup() } }
                    .disabled(model.historyJoinCode.isEmpty)
                if status.holdsKey {
                    Button(L("crypto.history_backup_sync")) { Task { await model.syncHistoryBackup() } }
                    Button(L("crypto.history_backup_restore")) { Task { await model.restoreHistoryBackup() } }
                }
            }
        }
        .alert(L("crypto.history_backup_enable"), isPresented: $confirm) {
            Button(L("actions.cancel"), role: .cancel) {}
            Button(L("crypto.history_backup_enable")) { Task { await model.prepareHistoryBackup() } }
        } message: {
            Text(L(model.historyBackupApproval?.generationRevision == nil ? "crypto.history_backup_explanation" : "crypto.history_backup_replace"))
        }
        .onDisappear { confirm = false }
    }
}
