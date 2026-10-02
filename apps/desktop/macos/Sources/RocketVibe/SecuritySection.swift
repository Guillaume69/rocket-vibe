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
    private enum ConfirmationAction {
        case factor(NativeFactorAction)
        case removeEmail(String)
    }
    private struct Confirmation: Identifiable {
        let id = UUID()
        let model: SecurityModel
        let action: ConfirmationAction
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
                        if model.method == "email", let email = value.proofEmail {
                            Text(factorEmailStatus(email)).font(.caption).foregroundStyle(.secondary)
                            Button(L(email.requested ? "email.resume_delivery" : "email.send_code")) {
                                Task { await model.sendProofEmail(resend: false, revision: value.viewRevision) }
                            }.disabled(!email.requested && !email.canDeliver)
                            if email.delivery != nil {
                                Button(L("email.resend_code")) {
                                    Task { await model.sendProofEmail(resend: true, revision: value.viewRevision) }
                                }.disabled(!email.canDeliver)
                            }
                        }
                        TextField(L(model.method == "email" ? "email.code" : model.method == "recovery_code" ? "login.code_recovery_code" : "login.code_totp"), text: input(model, \.code))
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
                            if value.totpEnabled {
                                Button(L("security.regenerate"), role: .destructive) {
                                    confirmation = Confirmation(model: model, action: .factor(.regenerate), revision: value.viewRevision)
                                }
                                Button(L("security.disable"), role: .destructive) {
                                    confirmation = Confirmation(model: model, action: .factor(.disable), revision: value.viewRevision)
                                }
                            } else {
                                Button(L("security.setup")) { Task { await model.factor(.setup, revision: value.viewRevision) } }
                            }
                        }
                    }
                    if value.supportsEmail, let email = value.email {
                        emailSettings(model, value, email)
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
                    Task {
                        switch pending.action {
                        case let .factor(action): await pending.model.factor(action, revision: pending.revision)
                        case .removeEmail: await pending.model.removeEmail(revision: pending.revision)
                        }
                    }
                }
            }
            Button(L("actions.cancel"), role: .cancel) { confirmation = nil }
        } message: { Text(confirmationBody(confirmation?.action)) }
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
        nativeFactorTitle(method)
    }
    @ViewBuilder
    private func emailSettings(_ model: SecurityModel, _ value: NativeSecurityState, _ email: NativeEmailState) -> some View {
        VStack(alignment: .leading) {
            Text(L("email.title")).font(.headline)
            Text(L("email.private")).font(.caption).foregroundStyle(.secondary)
            if let address = email.address {
                Text(L("email.current")).font(.caption).foregroundStyle(.secondary)
                Text(address)
            } else { Text(L("email.none")).foregroundStyle(.secondary) }
        }
        if email.phase == .idle && email.canVerify {
            TextField(L("email.address"), text: input(model, \.emailAddress))
            Button(L("email.start")) { Task { await model.startEmail(revision: value.viewRevision) } }
                .disabled(value.proof != .ready)
        }
        if email.phase == .idle && email.canRemove, let address = email.address {
            Button(L("email.remove"), role: .destructive) {
                confirmation = Confirmation(model: model, action: .removeEmail(address), revision: value.viewRevision)
            }
            .disabled(value.proof != .ready)
        }
        if email.phase == .pending {
            Text(L("email.pending")).font(.caption).foregroundStyle(.secondary)
            Text(email.pendingAddress ?? "")
            if let delivery = email.delivery { Text(deliveryTitle(delivery)).font(.caption).foregroundStyle(.secondary) }
            SecureField(L("email.code"), text: input(model, \.emailCode))
            Button(L("email.confirm")) { Task { await model.confirmEmail(revision: value.viewRevision) } }
                .disabled(value.proof != .ready)
            Button(L("email.cancel")) { Task { await model.cancelEmail(revision: value.viewRevision) } }
        }
        if email.phase == .verified {
            Text(L("email.verified"))
            Button(L("email.done")) { Task { await model.acknowledgeEmail(revision: value.viewRevision) } }
        }
        if email.phase == .stale {
            Text(L("email.stale")).foregroundStyle(.secondary)
            Button(L("email.restart")) { Task { await model.cancelEmail(revision: value.viewRevision) } }
        }
        if email.phase == .removalPending {
            Text(L("email.removal_pending")).foregroundStyle(.secondary)
            Button(L("email.cancel_removal")) { Task { await model.cancelEmail(revision: value.viewRevision) } }
        }
        if email.phase == .removed {
            Text(L("email.removed"))
            Button(L("email.done")) { Task { await model.acknowledgeEmail(revision: value.viewRevision) } }
        }
        if email.phase == .removalStale {
            Text(L("email.removal_stale")).foregroundStyle(.secondary)
            Button(L("email.close_removal")) { Task { await model.cancelEmail(revision: value.viewRevision) } }
        }
    }
    private func deliveryTitle(_ delivery: NativeEmailDelivery) -> String {
        switch delivery {
        case .queued: return L("email.queued")
        case .sending: return L("email.sending")
        case .deferred: return L("email.deferred")
        case .accepted: return L("email.accepted")
        case .exhausted: return L("email.exhausted")
        }
    }
    private func title(_ action: ConfirmationAction?) -> String {
        switch action {
        case .removeEmail: return L("email.remove")
        case .factor(.disable): return L("security.disable")
        default: return L("security.regenerate")
        }
    }
    private func confirmationBody(_ action: ConfirmationAction?) -> String {
        switch action {
        case let .removeEmail(address): return address + "\n\n" + L("email.remove_body")
        case .factor(.disable): return L("security.disable_body")
        default: return L("security.regenerate_body")
        }
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
