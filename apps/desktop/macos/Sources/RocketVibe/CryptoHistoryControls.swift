import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// History recovery between devices of the account: the new device asks and
/// imports; another device compares the request fingerprint, sees the rooms
/// and shares. Every secret and recovered message stays in Rust.
struct CryptoHistoryControls: View {
    @Environment(AppModel.self) var app
    let model: CryptoModel
    @State private var confirm = false
    private func roomName(_ id: String) -> String {
        app.rooms.first(where: { $0.rid == id })?.name ?? id
    }
    private func count(_ documents: String) -> String {
        L("crypto.history_messages", count: Int(documents) ?? Int.max)
    }
    private var confirmation: String {
        guard let preview = model.historyPreview else { return "" }
        let rooms = preview.periods.map { roomName($0.room) + " · " + count($0.documents) }.joined(separator: "\n")
        return [L("crypto.history_share_body"), preview.device, preview.fingerprint, rooms].joined(separator: "\n\n")
    }
    var body: some View {
        Group {
            Text(L("crypto.history_title")).font(.headline)
            Text(L("crypto.history_explanation")).font(.caption).foregroundStyle(.secondary)
            Text(model.history.title).font(.caption)
            if let fingerprint = model.history.fingerprint {
                Text(fingerprint).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            }
            Button(L("crypto.history_request")) { Task { await model.requestHistory() } }
            Button(L("crypto.history_import")) { Task { await model.importHistory() } }
            Button(L("crypto.history_offers")) { Task { await model.reviewHistoryRequests() } }
            Button(L("crypto.history_resume")) { Task { await model.resumeHistoryShare() } }
            if let offers = model.historyOffers {
                ForEach(offers.offers) { offer in
                    Text(L("crypto.history_offer", ["device": offer.device]))
                    Text(offer.fingerprint).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    Button(L("crypto.history_review")) { Task { await model.previewHistory(offer) } }
                }
            }
            if let preview = model.historyPreview {
                if preview.periods.isEmpty {
                    Text(L("crypto.history_nothing")).font(.caption)
                } else {
                    Text(preview.fingerprint).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    ForEach(preview.periods) { period in
                        Text(roomName(period.room) + " · " + count(period.documents)).font(.caption)
                    }
                    Button(L("crypto.history_share")) { confirm = true }
                }
                Button(L("actions.cancel")) { Task { await model.refresh() } }
            }
        }
        .alert(L("crypto.history_share"), isPresented: $confirm) {
            Button(L("actions.cancel"), role: .cancel) {}
            Button(L("crypto.history_share")) { Task { await model.shareHistory() } }
            if model.historyPreview?.canDelegate == true {
                Button(L("crypto.history_share_delegate"), role: .destructive) { Task { await model.shareHistory(delegate: true) } }
            }
        } message: {
            Text(model.historyPreview?.canDelegate == true ? confirmation + "

" + L("crypto.history_delegate_body") : confirmation)
        }
        .onDisappear { confirm = false }
    }
}
