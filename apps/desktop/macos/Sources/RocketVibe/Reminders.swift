import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// The Reminders list of the account menu: the account's pending ones,
/// soonest first, with when, the room, the author and the excerpt. A row
/// opens its message as its notification would; Cancel removes it. Drawn in
/// the window: a click outside closes it with nothing cancelled.
struct RemindersList: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) private var close

    var body: some View {
        let items = app.pendingReminders()
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L("reminders.title")).font(.headline)
                Spacer()
                Button { close() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
            }
            if items.isEmpty {
                Text(L("reminders.empty")).foregroundStyle(Vibe.muted)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(items, id: \.messageId) { item in row(item) }
                }
            }
        }
        .padding(20)
        .frame(width: 440)
        .frame(maxHeight: 480)
    }

    func row(_ item: ReminderItem) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Button { app.openReminder(item) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.when)
                        .font(.vibe(12.5, .bold))
                        .foregroundStyle(Vibe.violet)
                    Text("\(item.roomName) · \(item.author)")
                        .font(.vibe(12))
                        .foregroundStyle(Vibe.muted)
                        .lineLimit(1)
                    Text(item.excerpt)
                        .lineLimit(2)
                        .foregroundStyle(Vibe.text)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button(L("reminders.cancel")) { app.cancelReminder(item.messageId) }
        }
    }
}
