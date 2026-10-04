import RocketVibeCore
import RocketVibeKit
import SwiftUI

struct PeerIdentitySection: View {
    @Environment(AppModel.self) var app
    let user: String
    @State private var model: PeerIdentityModel?
    var body: some View {
        Section(L("crypto.peer_title")) {
            Text(L("crypto.peer_help")).font(.caption).foregroundStyle(.secondary)
            if let model {
                if model.busy { ProgressView(L("crypto.loading")) }
                if let value = model.value {
                    Text(peerTrustTitle(value.trust))
                    Text(value.fingerprint).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    if let approval = value.approval {
                        Text(approval.device).textSelection(.enabled)
                        Text(approval.fingerprint).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        Text(L("crypto.peer_device_help")).font(.caption)
                        Button(L("crypto.peer_approve")) { Task { await model.approve() } }
                    } else {
                        if value.trust == .unknown {
                            Button(L("crypto.peer_first")) { Task { await model.pin(.firstContact) } }
                        } else if value.trust == .unverified || value.trust == .changed {
                            if value.trust == .changed {
                                Text(L("crypto.peer_previous")).font(.caption)
                                Text(value.previousFingerprint).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                                TextField(L("crypto.peer_previous"), text: Binding(get: { model.previous }, set: { model.previous = $0 }))
                            }
                            TextField(L("crypto.peer_confirm"), text: Binding(get: { model.confirmed }, set: { model.confirmed = $0 }))
                            Button(L(value.trust == .changed ? "crypto.peer_replace" : "crypto.peer_verify")) {
                                Task { await model.pin(value.trust == .changed ? .replace : .verify) }
                            }
                            .disabled(model.confirmed != value.fingerprint || (value.trust == .changed && model.previous != value.previousFingerprint))
                        }
                        ForEach(value.devices, id: \.id) { device in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(device.id).textSelection(.enabled)
                                Text(device.fingerprint).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                                Text(L(device.approved ? "crypto.peer_approved" : "crypto.peer_pending")).font(.caption)
                                if !device.approved && (value.trust == .unverified || value.trust == .verified) {
                                    Button(L("crypto.peer_review")) { Task { await model.preview(device: device.id) } }
                                }
                            }
                        }
                    }
                } else { Text(L("crypto.peer_prepare")).font(.caption) }
                if let error = model.error { Text(error).foregroundStyle(.red) }
                Button(L("crypto.refresh")) { Task { await model.refresh() } }
            }
        }
        .disabled(model?.busy == true)
        .task(id: "\(app.sessionId)#\(user)") {
            model?.close(); let fresh = PeerIdentityModel(app: app, user: user); model = fresh; await fresh.refresh()
        }
        .onDisappear { model?.close() }
    }
}
