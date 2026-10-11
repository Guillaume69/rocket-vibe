import RocketVibeCore
import RocketVibeKit
import SwiftUI

/// Restarts the scheduled list when the room changes or "Send later" comes or goes.
struct ScheduleKey: Hashable {
    let model: ObjectIdentifier
    let supported: Bool
}

/// "Send later", the chevron by the send button: in 1 hour, tomorrow at
/// 08:00, or a time to pick. A click outside closes the menu.
struct SendLaterMenu: View {
    let model: RoomModel
    let schedule: (Int64) -> Void
    let pick: () -> Void

    var body: some View {
        Menu {
            Button(L("scheduled.in_hour")) { if let times = model.scheduleTimes() { schedule(times.inOneHour) } }
            Button(L("scheduled.tomorrow_morning")) { if let times = model.scheduleTimes() { schedule(times.tomorrowMorning) } }
            Button(L("scheduled.pick"), action: pick)
        } label: {
            Image(systemName: "chevron.up").foregroundStyle(Vibe.muted)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(L("scheduled.send_later"))
        .padding(.bottom, 11)
    }
}

/// "N scheduled", above the composer: opens the list.
struct ScheduledChip: View {
    let count: Int
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            Text(L("scheduled.chip", count: count))
                .font(.vibe(12.5, .bold))
                .foregroundStyle(Vibe.soft)
                .padding(.horizontal, 12)
                .padding(.vertical, 3)
                .background(Vibe.card, in: Capsule())
                .overlay(Capsule().strokeBorder(Vibe.line))
        }
        .buttonStyle(.plain)
        .help(L("scheduled.title"))
    }
}

/// The room's (or thread's) scheduled messages: when, the text, and Cancel;
/// a failed one says it could not be sent, and why, and offers Remove. Drawn
/// in the window: a click outside closes it with nothing cancelled.
struct ScheduledList: View {
    @Environment(AppModel.self) var app
    @Environment(\.closeModal) private var close
    let model: ScheduledModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L("scheduled.title")).font(.headline)
                Spacer()
                Button { close() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
            }
            if model.items.isEmpty {
                Text(L("scheduled.empty")).foregroundStyle(Vibe.muted)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(model.items, id: \.id) { item in row(item) }
                }
            }
        }
        .padding(20)
        .frame(width: 440)
        .frame(maxHeight: 480)
        .task { await model.refresh() }
    }

    func heading(_ item: ScheduledItem) -> String {
        if item.failed {
            guard let reason = item.reason else { return L("scheduled.failed") }
            return "\(L("scheduled.failed")): \(reason)"
        }
        return item.threadReply && model.root == nil ? "\(item.when) · \(L("scheduled.thread"))" : item.when
    }

    func row(_ item: ScheduledItem) -> some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(heading(item))
                    .font(.vibe(12.5, .bold))
                    .foregroundStyle(item.failed ? Color.red : Vibe.violet)
                Text(item.text)
                    .lineLimit(2)
                    .foregroundStyle(Vibe.text)
            }
            Spacer()
            Button(L(item.failed ? "scheduled.remove" : "scheduled.cancel")) {
                Task { if let refusal = await model.cancel(item.id) { app.notice = refusal } }
            }
        }
    }
}

/// "Pick a time": a date and a time, at least a minute ahead and at most
/// 30 days (a scheduled message) or a year (a reminder). Cancel, Escape and a
/// click outside choose nothing.
struct PickTimeCard: View {
    @Environment(\.closeModal) private var close
    let heading: String
    let hint: String
    let cancel: String
    let confirm: String
    let latest: Date
    let chosen: (Int64) -> Void
    @State private var date: Date

    init(times: ScheduleTimes, chosen: @escaping (Int64) -> Void) {
        self.init(heading: L("scheduled.pick"), hint: L("scheduled.pick_hint"), cancel: L("scheduled.cancel"),
                  confirm: L("scheduled.schedule"), initial: times.inOneHour, latest: times.latest, chosen: chosen)
    }

    /// A reminder's.
    init(reminder times: ReminderTimes, chosen: @escaping (Int64) -> Void) {
        self.init(heading: L("reminders.pick"), hint: L("reminders.pick_hint"), cancel: L("reminders.cancel"),
                  confirm: L("reminders.remind_me"), initial: times.inOneHour, latest: times.latest, chosen: chosen)
    }

    init(heading: String, hint: String, cancel: String, confirm: String, initial: Int64, latest: Int64,
         chosen: @escaping (Int64) -> Void) {
        self.heading = heading
        self.hint = hint
        self.cancel = cancel
        self.confirm = confirm
        self.latest = Date(timeIntervalSince1970: TimeInterval(latest))
        self.chosen = chosen
        _date = State(initialValue: Date(timeIntervalSince1970: TimeInterval(initial)))
    }

    /// The minute chosen, its seconds dropped.
    var instant: Int64 { Int64(date.timeIntervalSince1970) / 60 * 60 }
    var valid: Bool {
        let now = Int64(Date().timeIntervalSince1970)
        return instant >= now + 60 && instant <= Int64(latest.timeIntervalSince1970)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(heading).font(.headline)
            Text(hint).foregroundStyle(Vibe.muted)
            DatePicker(L("scheduled.date"), selection: $date, in: Date()...latest, displayedComponents: [.date])
                .datePickerStyle(.graphical)
            DatePicker(L("scheduled.time"), selection: $date, displayedComponents: [.hourAndMinute])
            HStack {
                Spacer()
                Button(cancel) { close() }
                Button(confirm) {
                    chosen(instant)
                    close()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!valid)
            }
        }
        .padding(20)
        .frame(width: 360)
    }
}
