import Foundation
import UserNotifications

/**
 * iOS counterpart of RocketVibeMessagingService (plugins/with-fcm-deeplink.js).
 * Copied into ios/NotificationService/ by plugins/with-ios-push.js.
 *
 * The server (patched bundle, docker/patch-push.mjs) sets `mutable-content`:
 * iOS wakes this extension before showing each push. In "hidden content" mode,
 * the push carries only a messageId; we read the session from the keychain
 * shared with the app and ask `push.get` for the content.
 *
 * Two differences from Android, imposed by iOS:
 * - no notification can be suppressed (that needs the filtering entitlement,
 *   granted by Apple on application): without a session, we replace the text
 *   with a generic one instead of swallowing the push;
 * - no WorkManager: a failed fetch leaves "New message", with no catch-up.
 *   Opening the app resyncs anyway.
 *
 * The tap is routed by expo-notifications, which exposes `userInfo["body"]` as
 * the `data` of a remote push: we store `ejson` there (with `rid` and `host`),
 * the shape `notificationTarget` reads in ui/notifications.tsx.
 */
class NotificationService: UNNotificationServiceExtension {
  private var deliver: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?
  private var task: URLSessionDataTask?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    deliver = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    self.content = content

    guard
      let raw = request.content.userInfo["ejson"] as? String,
      let ejson = jsonObject(raw),
      let host = ejson["host"] as? String
    else {
      finish()
      return
    }
    let language = preferredLanguage()

    guard let session = readSession(host: host) else {
      content.body = LocalizedStrings.newMessage(language)
      finish()
      return
    }

    if ejson["notificationType"] as? String == "message-id-only" {
      guard let messageId = ejson["messageId"] as? String, !messageId.isEmpty else {
        finish()
        return
      }
      task = fetchContent(messageId: messageId, session: session) { [weak self] notification in
        guard let self, let content = self.content else { return }
        if let notification,
          let payload = notification["payload"] as? [String: Any],
          let rid = payload["rid"] as? String, !rid.isEmpty
        {
          apply(
            content,
            title: notification["title"] as? String ?? content.title,
            text: notification["text"] as? String ?? content.body,
            payload: payload,
            rid: rid,
            host: host,
            language: language
          )
        } else {
          content.body = LocalizedStrings.newMessage(language)
        }
        self.finish()
      }
      return
    }

    if let rid = ejson["rid"] as? String, !rid.isEmpty {
      apply(content, title: content.title, text: content.body, payload: ejson, rid: rid, host: host, language: language)
    }
    finish()
  }

  override func serviceExtensionTimeWillExpire() {
    DispatchQueue.main.async { [self] in
      task?.cancel()
      if let content, content.userInfo["body"] == nil {
        content.body = LocalizedStrings.newMessage(preferredLanguage())
      }
      finish()
    }
  }

  private func finish() {
    guard let deliver, let content else { return }
    self.deliver = nil
    deliver(content)
  }
}

private func apply(
  _ content: UNMutableNotificationContent,
  title: String,
  text initialText: String,
  payload: [String: Any],
  rid: String,
  host: String,
  language: String
) {
  var text = initialText
  if payload["messageType"] as? String == "e2e" {
    text = LocalizedStrings.encryptedMessage(language)
  }
  let sender = payload["sender"] as? [String: Any]
  let username = sender?["username"] as? String ?? ""
  let name = (sender?["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (username.isEmpty ? title : username)

  if payload["type"] as? String == "d" {
    content.title = name
    if !username.isEmpty, text.hasPrefix(username + ": ") {
      text = String(text.dropFirst(username.count + 2))
    }
  } else {
    content.title = title
  }
  content.body = text
  content.threadIdentifier = rid
  // The server would reject a plaintext reply in an encrypted room.
  if payload["messageType"] as? String != "e2e" {
    content.categoryIdentifier = messageCategory
  }

  var ejson = payload
  ejson["rid"] = rid
  ejson["host"] = host
  if let data = try? JSONSerialization.data(withJSONObject: ejson),
    let ejsonString = String(data: data, encoding: .utf8)
  {
    var userInfo = content.userInfo
    userInfo["body"] = ["ejson": ejsonString]
    content.userInfo = userInfo
  }
}

private enum LocalizedStrings {
  static func newMessage(_ language: String) -> String { language == "fr" ? "Nouveau message" : "New message" }
  static func encryptedMessage(_ language: String) -> String { language == "fr" ? "Message chiffré" : "Encrypted message" }
}

// MARK: - push.get

private func fetchContent(
  messageId: String,
  session: Session,
  completion: @escaping ([String: Any]?) -> Void
) -> URLSessionDataTask? {
  var components = URLComponents(string: session.baseUrl.trimmingSuffix("/") + "/api/v1/push.get")
  components?.queryItems = [URLQueryItem(name: "id", value: messageId)]
  guard let url = components?.url else {
    completion(nil)
    return nil
  }
  var request = URLRequest(url: url, timeoutInterval: 20)
  request.setValue(session.userId, forHTTPHeaderField: "X-User-Id")
  request.setValue(session.authToken, forHTTPHeaderField: "X-Auth-Token")
  request.setValue("application/json", forHTTPHeaderField: "Accept")
  let task = URLSession.shared.dataTask(with: request) { responseData, response, _ in
    var notification: [String: Any]?
    if (response as? HTTPURLResponse)?.statusCode == 200,
      let responseData,
      let json = (try? JSONSerialization.jsonObject(with: responseData)) as? [String: Any],
      json["success"] as? Bool == true,
      let data = json["data"] as? [String: Any]
    {
      notification = data["notification"] as? [String: Any]
    }
    let result = notification
    DispatchQueue.main.async { completion(result) }
  }
  task.resume()
  return task
}
