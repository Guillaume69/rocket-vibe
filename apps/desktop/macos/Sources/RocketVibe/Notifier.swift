import AppKit
import RocketVibeCore
import RocketVibeKit
import UserNotifications

/// The system's notifications: a click opens the message, Reply answers in place.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    static let category = "message"
    static let replyAction = "reply"

    var onOpen: ((String, String) -> Void)?
    var onReply: ((String, String) -> Void)?

    /// Unbundled (a bare `swift run`), there is no notification center to ask.
    var center: UNUserNotificationCenter? {
        Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
    }

    func start() {
        guard let center else { return }
        center.delegate = self
        let reply = UNTextInputNotificationAction(
            identifier: Self.replyAction, title: L("notify.reply"), options: [],
            textInputButtonTitle: L("notify.reply"), textInputPlaceholder: L("notify.reply_placeholder"))
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.category, actions: [reply], intentIdentifiers: [])
        ])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func show(_ incoming: Incoming) {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = incoming.direct ? incoming.author : incoming.roomName
        let body = incoming.body.map { replaceShortcodes(text: $0) } ?? L("rooms.encrypted")
        content.body = incoming.direct ? body : "\(incoming.author): \(body)"
        content.sound = .default
        content.categoryIdentifier = Self.category
        content.threadIdentifier = incoming.rid
        content.userInfo = ["rid": incoming.rid, "id": incoming.id]
        center.add(UNNotificationRequest(identifier: incoming.id, content: content, trigger: nil))
    }

    func test() {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = "rocket-vibe"
        content.body = L("notify.test_body")
        center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    /// Clears what was shown for a room once it is read.
    func withdraw(rid: String) {
        guard let center else { return }
        center.getDeliveredNotifications { delivered in
            let ids = delivered.filter { $0.request.content.threadIdentifier == rid }.map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let rid = info["rid"] as? String, let id = info["id"] as? String else { return }
        let reply = (response as? UNTextInputNotificationResponse)?.userText
        await MainActor.run {
            if let reply, !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                onReply?(rid, reply)
            } else {
                onOpen?(rid, id)
            }
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
