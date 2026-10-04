import ExpoModulesCore
import ExpoNotifications
import UIKit
import UserNotifications

/**
 * "Reply" from an iOS notification, counterpart of NotificationReplyReceiver
 * (plugins/with-fcm-deeplink.js): the text goes out through `chat.sendMessage`
 * from native code, without waiting for JS.
 *
 * Subscribed at app STARTUP, not at module creation: iOS may relaunch the app
 * in the background just to deliver the reply, and a delegate registered later
 * would miss it if expo's had already consumed it.
 */
public class NotificationReplyAppDelegate: ExpoAppDelegateSubscriber {
  private let replyHandler = ReplyHandler()

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NotificationCenterManager.shared.addDelegate(replyHandler)
    registerCategory()
    return true
  }
}

private func registerCategory() {
  let fr = preferredLanguage() == "fr"
  let action = UNTextInputNotificationAction(
    identifier: replyAction,
    title: fr ? "Répondre" : "Reply",
    options: [],
    textInputButtonTitle: fr ? "Envoyer" : "Send",
    textInputPlaceholder: "Message"
  )
  let category = UNNotificationCategory(identifier: messageCategory, actions: [action], intentIdentifiers: [], options: [])
  let center = UNUserNotificationCenter.current()
  center.getNotificationCategories { existing in
    center.setNotificationCategories(existing.filter { $0.identifier != messageCategory }.union([category]))
  }
}

private final class ReplyHandler: NotificationDelegate {
  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    guard [replyAction, legacyReplyAction].contains(response.actionIdentifier),
      let textResponse = response as? UNTextInputNotificationResponse
    else { return false }

    let content = response.notification.request.content
    let text = textResponse.userText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty,
      let body = content.userInfo["body"] as? [String: Any],
      let raw = body["ejson"] as? String,
      let ejson = jsonObject(raw),
      let rid = ejson["rid"] as? String,
      let host = ejson["host"] as? String
    else { return true }
    let tmid = (ejson["tmid"] as? String).flatMap { $0.isEmpty ? nil : $0 }

    // expo hands control back to the system as soon as we return: without a
    // background task, iOS could suspend the app before the request finishes.
    let application = UIApplication.shared
    var backgroundTask = UIBackgroundTaskIdentifier.invalid
    let finish = {
      guard backgroundTask != .invalid else { return }
      application.endBackgroundTask(backgroundTask)
      backgroundTask = .invalid
    }
    backgroundTask = application.beginBackgroundTask(withName: "rv-reply", expirationHandler: finish)

    guard let session = readSession(host: host) else {
      reportFailure(content)
      finish()
      return true
    }
    sendReply(session: session, rid: rid, tmid: tmid, text: text) { sent in
      DispatchQueue.main.async {
        if !sent { reportFailure(content) }
        finish()
      }
    }
    return true
  }
}

/// POST <baseUrl>/api/v1/chat.sendMessage, with the session read from the keychain.
private func sendReply(session: Session, rid: String, tmid: String?, text: String, completion: @escaping (Bool) -> Void) {
  guard let url = URL(string: session.baseUrl.trimmingSuffix("/") + "/api/v1/chat.sendMessage") else {
    completion(false)
    return
  }
  var message: [String: Any] = ["rid": rid, "msg": text]
  if let tmid { message["tmid"] = tmid }
  var request = URLRequest(url: url, timeoutInterval: 20)
  request.httpMethod = "POST"
  request.httpBody = try? JSONSerialization.data(withJSONObject: ["message": message])
  request.setValue(session.userId, forHTTPHeaderField: "X-User-Id")
  request.setValue(session.authToken, forHTTPHeaderField: "X-Auth-Token")
  request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
  request.setValue("application/json", forHTTPHeaderField: "Accept")
  URLSession.shared.dataTask(with: request) { data, response, _ in
    guard (response as? HTTPURLResponse)?.statusCode == 200,
      let data,
      let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else {
      completion(false)
      return
    }
    completion(json["success"] as? Bool == true)
  }.resume()
}

/// The reply did not go out: a notification says so, in the same thread and
/// with the same action, to retry in one gesture.
private func reportFailure(_ original: UNNotificationContent) {
  guard let content = original.mutableCopy() as? UNMutableNotificationContent else { return }
  content.body = preferredLanguage() == "fr" ? "Réponse non envoyée" : "Reply not sent"
  content.sound = nil
  let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
  UNUserNotificationCenter.current().add(request)
}
