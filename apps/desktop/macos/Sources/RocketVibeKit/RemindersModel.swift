import Foundation
import RocketVibeCore

/// "Remind me" (brain/features/reminders.md): reminders kept on the device by
/// rv-ffi (`reminders.rs`), in the directory the GTK app shares on a Mac.
extension ChatProvider {
    func setReminder(_ draft: ReminderDraft, due: Int64) throws -> String {
        switch self {
        case let .rocketChat(chat): return try chat.setReminder(draft: draft, due: due)
        case let .rocketVibe(chat): return try chat.setReminder(draft: draft, due: due)
        }
    }
    func reminder(_ messageId: String) -> ReminderItem? {
        switch self {
        case let .rocketChat(chat): return chat.reminder(messageId: messageId)
        case let .rocketVibe(chat): return chat.reminder(messageId: messageId)
        }
    }
    func reminders() -> [ReminderItem] {
        switch self {
        case let .rocketChat(chat): return chat.reminders()
        case let .rocketVibe(chat): return chat.reminders()
        }
    }
    func cancelReminder(_ messageId: String) throws -> String {
        switch self {
        case let .rocketChat(chat): return try chat.cancelReminder(messageId: messageId)
        case let .rocketVibe(chat): return try chat.cancelReminder(messageId: messageId)
        }
    }
}

extension RoomModel {
    /// Any sent message that is not a system line can carry a reminder.
    public func canRemind(_ message: MessageItem) -> Bool {
        active && message.delivery == .sent && message.system == nil && !message.id.isEmpty
    }
}

extension AppModel {
    /// Fires reminders: the missed ones now (those more than 7 days late are
    /// dropped by rv-ffi), then each at its time, every account's.
    public func startReminders() {
        reminderTimer?.cancel()
        reminderTimer = Task { [weak self] in
            while !Task.isCancelled {
                guard let wait = self?.fireDueReminders() else { return }
                try? await Task.sleep(nanoseconds: wait * 1_000_000_000)
            }
        }
    }

    /// Hands what is due to `onReminder`; answers the seconds until the next look.
    func fireDueReminders() -> UInt64 {
        let due = client.takeDueReminders()
        for reminder in due { onReminder?(reminder) }
        if !due.isEmpty { remindersRevision += 1 }
        return max(1, client.reminderWaitSeconds())
    }

    /// The open account's pending reminders, soonest first.
    public func pendingReminders() -> [ReminderItem] {
        _ = remindersRevision
        return provider?.reminders() ?? []
    }

    /// The pending reminder about a message, for its menu.
    public func reminder(for messageId: String) -> ReminderItem? {
        _ = remindersRevision
        return provider?.reminder(messageId)
    }

    /// Sets (or moves) the reminder about `message` and says when it will come.
    public func remind(_ message: MessageItem, roomName: String, due: Int64) {
        guard let provider else { return }
        let draft = ReminderDraft(
            rid: message.rid, roomName: roomName, messageId: message.id, threadId: message.threadId,
            author: message.authorLabel, text: message.text,
            hasAttachment: !message.files.isEmpty || !message.images.isEmpty)
        do { notice = try provider.setReminder(draft, due: due) } catch { notice = error.localizedDescription }
        remindersRevision += 1
        // A reminder a minute away must not wait for the timer's next look.
        startReminders()
    }

    public func cancelReminder(_ messageId: String) {
        guard let provider else { return }
        do { notice = try provider.cancelReminder(messageId) } catch { notice = error.localizedDescription }
        remindersRevision += 1
    }

    /// A row of the list: the account, the room and the message, as its notification opens them.
    public func openReminder(_ item: ReminderItem) {
        remindersShown = false
        guard let link = item.link else { return }
        Task { await openLink(link) }
    }
}
