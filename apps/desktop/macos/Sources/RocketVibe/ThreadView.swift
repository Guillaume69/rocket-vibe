import RocketVibeKit
import SwiftUI

/// A thread beside its room: the root and its replies, and a composer of its own.
struct ThreadView: View {
    @Environment(AppModel.self) var app
    let model: RoomModel
    @State var staged: [URL] = []
    /// A follow or unfollow on its way: the bell waits for it.
    @State var following = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(L("thread.title")).font(.vibeTitle(17, .bold))
                Spacer()
                if model.supportsThreads, let root = model.threadId {
                    Button { Task { await follow(root) } } label: {
                        Image(systemName: model.followingThread ? "bell.fill" : "bell.slash")
                    }
                    .buttonStyle(.borderless)
                    .help(L(model.followingThread ? "thread.unfollow" : "thread.follow"))
                    .disabled(following)
                }
                Button { app.closeThread() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
            }
            .padding(12)
            Divider()
            if model.messages.isEmpty && !model.loading {
                Text(L("thread.not_found")).foregroundStyle(.secondary).frame(maxHeight: .infinity)
            } else {
                MessageList(model: model)
            }
            // This thread's files waiting to go, with Retry when refused.
            UploadsView(model: model)
            // For the next reply only: the model unchecks it once sent.
            if model.supportsAlsoInRoom && !model.room.readOnly {
                Toggle(L("thread.also_in_room"), isOn: Binding(get: { model.alsoInRoom }, set: { model.alsoInRoom = $0 }))
                    .toggleStyle(.checkbox)
                    .padding(.horizontal, 14)
                    .padding(.top, 6)
            }
            Composer(model: model, staged: $staged)
        }
        .background(Vibe.night)
    }

    /// Follows the thread or stops, by what the bell shows.
    func follow(_ root: String) async {
        let on = !model.followingThread
        following = true
        defer { following = false }
        do {
            try await model.followThread(root, on)
            app.notice = L(on ? "thread.followed" : "thread.unfollowed")
        } catch {
            app.notice = L("thread.follow_failed")
        }
    }
}
