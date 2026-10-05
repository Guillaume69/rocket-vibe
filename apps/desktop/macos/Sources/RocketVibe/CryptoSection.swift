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
                    if value.phase == .missing || value.phase == .identityCreated || value.phase == .waitingForApproval {
                        Button(L("crypto.begin")) { Task { await model.begin() } }
                    }
                    if value.phase == .ready || value.phase == .expired || value.phase == .renewing {
                        Button(L("crypto.renew")) { Task { await model.renew() } }
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
    }
}
