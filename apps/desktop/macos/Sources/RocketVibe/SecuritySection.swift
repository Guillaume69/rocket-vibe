import AppKit
import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// Added to the existing grouped preferences, using the shared account model.
struct SecuritySection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: SecurityModel?
    @State private var confirmation: Confirmation?
    private struct Confirmation: Identifiable {
        let id = UUID()
        let model: SecurityModel
        let action: NativeFactorAction
        let revision: UInt64
    }
    var body: some View {
        Section(L("security.title")) {
            if let model {
                if model.busy { ProgressView(L("security.loading")) }
                if let value = model.value, value.loaded {
                    status(value)
                    if value.proof == .password {
                        SecureField(L("login.password"), text: input(model, \.password))
                        Button(L("security.verify")) { Task { await model.confirmPassword() } }
                    }
                    if value.proof == .challenge {
                        Picker(L("security.method"), selection: input(model, \.method)) {
                            ForEach(value.methods, id: \.self) { method in
                                Text(methodTitle(method)).tag(method)
                            }
                        }
                        TextField(L(model.method == "recovery_code" ? "login.code_recovery_code" : "login.code_totp"), text: input(model, \.code))
                        Button(L("security.verify")) { Task { await model.confirmFactor() } }
                    }
                    if value.supportsFactors {
                        if value.factor == .setup {
                            Text(L("security.setup_body")).font(.caption).foregroundStyle(.secondary)
                            Text(value.setupSecret ?? "").font(.system(.body, design: .monospaced))
                            Button(L("security.copy_secret")) { copy(model, .secret, value.viewRevision) }
                            Button(L("security.copy_uri")) { copy(model, .uri, value.viewRevision) }
                            TextField(L("login.code_totp"), text: input(model, \.setupCode))
                            Button(L("security.enable")) { Task { await model.enable(revision: value.viewRevision) } }
                        }
                        if value.factor == .codes {
                            Text(L("security.codes_body")).font(.caption).foregroundStyle(.secondary)
                            Text(value.codes.joined(separator: "\n")).font(.system(.body, design: .monospaced))
                            Button(L("security.copy_codes")) { copy(model, .codes, value.viewRevision) }
                            Button(L("security.saved")) { Task { await model.acknowledge(revision: value.viewRevision) } }
                        }
                        if value.factor == .stale {
                            Text(L("security.stale")).foregroundStyle(.secondary)
                            Button(L("security.discard")) { Task { await model.acknowledge(revision: value.viewRevision) } }
                        }
                        if value.factor == .idle {
                            if value.enabled {
                                Button(L("security.regenerate"), role: .destructive) {
                                    confirmation = Confirmation(model: model, action: .regenerate, revision: value.viewRevision)
                                }
                                Button(L("security.disable"), role: .destructive) {
                                    confirmation = Confirmation(model: model, action: .disable, revision: value.viewRevision)
                                }
                            } else {
                                Button(L("security.setup")) { Task { await model.factor(.setup, revision: value.viewRevision) } }
                            }
                        }
                    }
                } else if !model.busy { Text(L("security.loading")).foregroundStyle(.secondary) }
                if let error = model.error { Text(error).foregroundStyle(.red) }
                Button(L("security.refresh")) { Task { await model.refresh() } }
            }
        }
        .disabled(model?.busy == true)
        .task(id: app.native.map(ObjectIdentifier.init)) {
            confirmation = nil; model?.close()
            let fresh = SecurityModel(app: app); model = fresh
            if scenePhase == .active { await fresh.open() }
            else { fresh.close() }
        }
        .onDisappear { confirmation = nil; model?.close() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model?.open() } }
            else { confirmation = nil; model?.close() }
        }
        .alert(title(confirmation?.action), isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } })) {
            if let pending = confirmation {
                Button(title(pending.action), role: .destructive) {
                    confirmation = nil
                    Task { await pending.model.factor(pending.action, revision: pending.revision) }
                }
            }
            Button(L("actions.cancel"), role: .cancel) { confirmation = nil }
        } message: { Text(L(confirmation?.action == .disable ? "security.disable_body" : "security.regenerate_body")) }
    }
    private func input(_ model: SecurityModel, _ key: ReferenceWritableKeyPath<SecurityModel, String>) -> Binding<String> {
        Binding(get: { model[keyPath: key] }, set: { model[keyPath: key] = $0 })
    }
    private func status(_ value: NativeSecurityState) -> some View {
        VStack(alignment: .leading) {
            if value.supportsFactors {
                Text(L(value.enabled ? "security.enabled" : "security.disabled"))
            }
            Text(value.enabled ? L("security.remaining", count: Int(value.backupCodesRemaining)) : L(value.proof == .ready ? "security.ready" : "security.required"))
                .font(.caption).foregroundStyle(.secondary)
            if value.enabled && value.proof != .ready {
                Text(L("security.required")).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private func methodTitle(_ method: String) -> String {
        L(method == "recovery_code" ? "login.factor_backup" : "login.factor_totp")
    }
    private func title(_ action: NativeFactorAction?) -> String {
        L(action == .disable ? "security.disable" : "security.regenerate")
    }
    private func copy(_ model: SecurityModel, _ kind: NativeSecurityCopy, _ revision: UInt64) {
        Task {
            await model.copy(kind, revision: revision) { text in
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
        }
    }
}
