import RocketVibeKit
import SwiftUI

/// Destruction of old keys (E2EE_STORAGE.md): when the storage key was last
/// renewed, when it is next due, and renewing it now.
struct CryptoStorageControls: View {
    let model: CryptoModel
    let status: CryptoStorageStatus
    private func date(_ value: String?) -> String? {
        value.flatMap(TimeInterval.init).map {
            Date(timeIntervalSince1970: $0).formatted(date: .abbreviated, time: .omitted)
        }
    }
    var body: some View {
        Group {
            Text(L("crypto.storage_title")).font(.headline)
            Text(L("crypto.storage_explanation")).font(.caption).foregroundStyle(.secondary)
            if let renewed = date(status.rotatedAt) {
                Text("\(L("crypto.storage_renewed")) \(renewed)").font(.caption)
            } else {
                Text(L("crypto.storage_never")).font(.caption)
            }
            if let due = date(status.dueAt) {
                Text("\(L("crypto.storage_due")) \(due)").font(.caption).foregroundStyle(.secondary)
            }
            Button(L("crypto.storage_renew")) { Task { await model.renewStorage() } }
        }
    }
}
