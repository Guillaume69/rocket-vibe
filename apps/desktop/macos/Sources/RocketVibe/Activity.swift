import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// The Activity view (`rv_core::activity`): every signed-in account's
/// mentions of me, replies in my threads and reactions to my messages, read
/// from the stored messages, after the rooms whose unread mentions no stored
/// message shows. A pick opens its account at the message, the thread of a
/// reply, or the room.
struct ActivitySheet: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) var dismiss
    @State private var view: ActivityView?

    var body: some View {
        SheetFrame(title: L("activity.title")) {
            Group {
                if let view {
                    if view.rooms.isEmpty && view.items.isEmpty {
                        Text(L("activity.empty"))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(24)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        list(view)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .task { view = await app.activity() }
    }

    func list(_ view: ActivityView) -> some View {
        List {
            if !view.rooms.isEmpty {
                Section(L("activity.rooms")) {
                    // Two accounts may share ids: entries are told apart by position.
                    ForEach(Array(view.rooms.enumerated()), id: \.offset) { _, room in
                        VStack(alignment: .leading, spacing: 3) {
                            place(room.server, room.room, several: view.several)
                            Text(L("activity.room_mentions", count: Int(room.count))).fontWeight(.semibold)
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { go(room.account, room.rid, nil, nil) }
                    }
                }
            }
            if !view.items.isEmpty {
                Section(L("activity.recent")) {
                    ForEach(Array(view.items.enumerated()), id: \.offset) { _, item in
                        VStack(alignment: .leading, spacing: 3) {
                            place(item.server, item.room, several: view.several)
                            HStack {
                                Text(what(item)).fontWeight(.semibold)
                                if item.kind != .reaction { Text(item.author).foregroundStyle(.secondary) }
                                Text("\(Formatting.day(item.ts)) \(Formatting.time(item.ts))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Text(item.text).lineLimit(2)
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { go(item.account, item.rid, item.messageId, item.threadId) }
                    }
                }
            }
        }
    }

    func place(_ server: String, _ room: String, several: Bool) -> some View {
        Text(several ? "\(server) · \(room)" : room)
            .font(.caption.bold())
            .foregroundStyle(Vibe.faint)
            .lineLimit(1)
    }

    func what(_ item: ActivityItem) -> String {
        switch item.kind {
        case .mention: return L("activity.mention")
        case .reply: return L("activity.reply")
        case .reaction:
            return L("activity.reaction", ["names": item.reactors.joined(separator: ", "),
                                           "emojis": item.emojis.joined(separator: " ")])
        }
    }

    func go(_ account: String, _ rid: String, _ message: String?, _ thread: String?) {
        dismiss()
        Task { await app.openActivity(account: account, rid: rid, message: message, thread: thread) }
    }
}
