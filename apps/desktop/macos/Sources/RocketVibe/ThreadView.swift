import RocketVibeKit
import SwiftUI

/// A thread beside its room: the root and its replies, and a composer of its own.
struct ThreadView: View {
    @Environment(AppModel.self) var app
    let model: RoomModel
    @State var staged: [URL] = []

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(L("thread.title")).font(.vibeTitle(17, .bold))
                Spacer()
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
            Composer(model: model, staged: $staged)
        }
        .background(Vibe.night)
    }
}
