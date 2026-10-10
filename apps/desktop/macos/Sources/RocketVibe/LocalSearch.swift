import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// Search across rooms, on the device (Rocket.Chat, Mattermost): the words of
/// every message stored here, newest first, each under its room's name. A
/// pick opens the room at the message, or the thread of a reply.
struct LocalSearchSheet: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) var dismiss
    @State private var query = ""
    @State private var hits: [LocalHit] = []
    /// The query whose hits are shown: "no result" only once it answered.
    @State private var answered: String?

    var body: some View {
        SheetFrame(title: L("local_search.title")) {
            VStack(alignment: .leading, spacing: 0) {
                TextField(L("local_search.placeholder"), text: $query)
                    .firstModalField()
                    .textFieldStyle(.roundedBorder)
                    .padding(.horizontal, 12)
                    .padding(.top, 12)
                Text(L("local_search.scope"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                List(hits, id: \.message.id) { hit in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(hit.roomName).font(.caption.bold()).foregroundStyle(Vibe.faint).lineLimit(1)
                        HStack {
                            Text(hit.message.authorLabel).fontWeight(.semibold)
                            Text("\(Formatting.day(hit.message.ts)) \(Formatting.time(hit.message.ts))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        BodyView(blocks: hit.message.body)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        dismiss()
                        Task { await app.open(hit: hit) }
                    }
                }
                .overlay {
                    let q = query.trimmingCharacters(in: .whitespaces)
                    if !q.isEmpty, answered == q, hits.isEmpty {
                        Text(L("local_search.none")).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .task(id: query) {
            let q = query.trimmingCharacters(in: .whitespaces)
            guard !q.isEmpty else {
                hits = []
                answered = nil
                return
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            let found = await app.searchLocal(q)
            guard !Task.isCancelled, query.trimmingCharacters(in: .whitespaces) == q else { return }
            hits = found
            answered = q
        }
    }
}
