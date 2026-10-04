import Foundation
import Security

/**
 * The Rocket.Chat session and the language, read from the keychain without a JS
 * runtime. Single source: compiled into the NotificationReply pod, and copied into
 * the NotificationService target by plugins/with-ios-push.js. The extension and
 * the notification reply therefore read the same thing, with the same origin
 * guard.
 */

/// Category the extension sets on messages that can be replied to, and its
/// text input action, registered by NotificationReplyAppDelegate.
let messageCategory = "rv-message"
let replyAction = "rv-reply"

// MARK: - Keychain (expo-secure-store 57 format)

/// expo-secure-store stores each key as kSecClassGenericPassword, service
/// `app:no-auth`, account = the key in UTF-8. The shared access group is set
/// by plugins/with-ios-push.js on the app AND on the extension.
let secureStoreService = "app:no-auth"

func readKeychain(_ key: String) -> String? {
  let request: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: secureStoreService,
    kSecAttrAccount as String: Data(key.utf8),
    kSecMatchLimit as String: kSecMatchLimitOne,
    kSecReturnData as String: true,
  ]
  var result: CFTypeRef?
  guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
    let data = result as? Data
  else { return nil }
  return String(data: data, encoding: .utf8)
}

func keychainKeys() -> [String] {
  let request: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: secureStoreService,
    kSecMatchLimit as String: kSecMatchLimitAll,
    kSecReturnAttributes as String: true,
  ]
  var result: CFTypeRef?
  guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
    let elements = result as? [[String: Any]]
  else { return [] }
  return elements.compactMap { element in
    (element[kSecAttrAccount as String] as? Data).flatMap { String(data: $0, encoding: .utf8) }
  }
}

func preferredLanguage() -> String {
  if let chosen = readKeychain("preferred-language") ?? readKeychain("langue-preferee"), chosen == "fr" || chosen == "en" {
    return chosen
  }
  return Locale.preferredLanguages.first?.hasPrefix("fr") == true ? "fr" : "en"
}

struct Session {
  let baseUrl: String
  let userId: String
  let authToken: String
}

/// Same rule as `originOf` in the Kotlin and in lib/origin.ts: scheme +
/// authority, lowercased, userinfo included.
func originOf(_ url: String) -> String? {
  guard let regex = try? NSRegularExpression(pattern: "^(https?://[^/?#]+)", options: .caseInsensitive),
    let match = regex.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)),
    let range = Range(match.range(at: 1), in: url)
  else { return nil }
  return url[range].lowercased()
}

/// The session whose baseUrl has the SAME ORIGIN as the push host. The host
/// comes from the payload, which anyone who knows the token can forge: never
/// fall back to another session, or the token would go to their domain.
func readSession(host: String) -> Session? {
  guard let expected = originOf(host) else { return nil }
  for key in keychainKeys() where key.hasPrefix("session-") {
    guard let raw = readKeychain(key),
      let object = jsonObject(raw),
      let baseUrl = object["baseUrl"] as? String,
      let userId = object["userId"] as? String, !userId.isEmpty,
      let authToken = object["authToken"] as? String, !authToken.isEmpty,
      originOf(baseUrl) == expected
    else { continue }
    return Session(baseUrl: baseUrl, userId: userId, authToken: authToken)
  }
  return nil
}

func jsonObject(_ text: String) -> [String: Any]? {
  guard let data = text.data(using: .utf8) else { return nil }
  return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

extension String {
  func trimmingSuffix(_ suffix: Character) -> String {
    var result = self
    while result.last == suffix { result.removeLast() }
    return result
  }
}
