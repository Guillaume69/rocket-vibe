import RocketVibeCore
import RocketVibeKit
import SwiftUI

struct CryptoRoomSection: View {
    @Environment(AppModel.self) var app
    let room: String
    @State private var model: CryptoRoomModel?
    var body: some View {
        Section(L("crypto.group_title")) {
            Text(L("crypto.group_help")).font(.caption).foregroundStyle(.secondary)
            if let model {
                if model.busy { ProgressView(L("crypto.loading")) }
                if let value = model.value {
                    Text(groupPhaseTitle(value.phase))
                    if value.needsCredentialUpdate {
                        Text(L("crypto.group_credential_update")).font(.caption).foregroundStyle(.secondary)
                    }
                    if !value.epoch.isEmpty { LabeledContent(L("crypto.group_epoch"), value: value.epoch) }
                    if let review = value.review {
                        Text(L("crypto.group_review_fingerprint")).font(.caption)
                        fingerprint(review.fingerprint)
                        Text(L("crypto.group_preview")).font(.headline)
                        ForEach(review.recipients, id: \.id) { person in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(person.name); Text(person.device).font(.caption)
                                fingerprint(person.incarnation); fingerprint(person.rootFingerprint); fingerprint(person.fingerprint)
                            }
                        }
                        Button(L("crypto.group_confirm")) { Task { await model.confirm() } }
                    } else {
                        if !value.fingerprint.isEmpty { fingerprint(value.fingerprint) }
                        Button(L("crypto.group_prepare")) { Task { await model.prepareDevice() } }
                        Text(L("crypto.group_select")).font(.headline)
                        ForEach(value.devices, id: \.id) { device in
                            VStack(alignment: .leading, spacing: 4) {
                                if device.eligible {
                                    let replacing = value.participants.contains(where: { $0.user == device.user && $0.device == device.device })
                                    Toggle(replacing ? "\(device.name) · \(L("crypto.group_replace"))" : device.name, isOn: Binding(
                                        get: { model.included.contains(device.id) },
                                        set: { model.includeDevice(device, selected: $0) }
                                    ))
                                    if device.trust == .unverified { Text(peerTrustTitle(device.trust)).font(.caption) }
                                } else {
                                    Text(device.name)
                                    let included = value.participants.contains(where: { $0.user == device.user && $0.device == device.device && $0.incarnation == device.incarnation })
                                    Text(L(device.own ? "crypto.group_own" : included ? "crypto.group_included" : device.trust == .changed ? "crypto.peer_changed" : "crypto.group_blocked")).font(.caption)
                                }
                                if !device.device.isEmpty { Text(device.device).font(.caption) }
                                if !device.fingerprint.isEmpty { fingerprint(device.fingerprint) }
                            }
                        }
                        if !value.participants.isEmpty {
                            Text(L("crypto.group_members")).font(.headline)
                            Text(L("crypto.group_remove")).font(.caption)
                            ForEach(value.participants, id: \.id) { person in
                                VStack(alignment: .leading, spacing: 4) {
                                    if value.devices.contains(where: { $0.own && $0.user == person.user && $0.device == person.device && $0.incarnation == person.incarnation }) {
                                        Text(person.name); Text(L("crypto.group_own")).font(.caption)
                                    } else {
                                        Toggle(person.name, isOn: Binding(
                                            get: { model.removed.contains(person.id) },
                                            set: { model.removeDevice(person, selected: $0) }
                                        ))
                                    }
                                    fingerprint(person.fingerprint)
                                    Text(person.device).font(.caption)
                                }
                            }
                        }
                        if value.canCreate && value.phase == .empty {
                            Text(L("crypto.group_need_empty")).font(.caption)
                            Button(L("crypto.group_create")) { Task { await model.create() } }
                        }
                        if value.phase == .acknowledged { Button(L("crypto.group_change")) { Task { await model.change() } } }
                        if value.hasEvent { Button(L("crypto.group_accept")) { Task { await model.reviewEvent() } } }
                        if value.phase == .pending {
                            Button(L("crypto.group_resume")) { Task { await model.resume() } }
                            Button(L("crypto.group_cancel"), role: .destructive) { Task { await model.cancel() } }
                        }
                    }
                } else { Text(L("crypto.group_need_empty")).font(.caption) }
                if let error = model.error { Text(error).foregroundStyle(.red) }
                Button(L("crypto.refresh")) { Task { await model.refresh() } }
            }
        }
        .disabled(model?.busy == true)
        .task(id: "\(app.sessionId)#\(room)") {
            model?.close(); let fresh = CryptoRoomModel(app: app, room: room); model = fresh; await fresh.refresh()
        }
        .onDisappear { model?.close() }
    }
    private func fingerprint(_ value: String) -> some View {
        Text(value).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
    }
}
