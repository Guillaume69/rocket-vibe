import Foundation
import Security

/**
 * La session Rocket.Chat et la langue, lues au trousseau sans runtime JS.
 * Source unique : compilée dans le pod ReponseNotif, et copiée dans la cible
 * NotificationService par plugins/with-ios-push.js. L'extension et la réponse
 * depuis la notification lisent donc la même chose, avec la même garde
 * d'origine.
 */

/// Catégorie posée par l'extension sur les messages auxquels on peut répondre,
/// et son action de saisie, enregistrée par NotificationReplyAppDelegate.
let messageCategory = "rv-message"
let replyAction = "rv-reply"

// MARK: - Trousseau (format d'expo-secure-store 57)

/// expo-secure-store range chaque clé en kSecClassGenericPassword, service
/// `app:no-auth`, compte = la clé en UTF-8. Le groupe d'accès partagé est posé
/// par plugins/with-ios-push.js sur l'app ET sur l'extension.
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
  if let chosen = readKeychain("langue-preferee"), chosen == "fr" || chosen == "en" {
    return chosen
  }
  return Locale.preferredLanguages.first?.hasPrefix("fr") == true ? "fr" : "en"
}

struct Session {
  let baseUrl: String
  let userId: String
  let authToken: String
}

/// Même règle que `originOf` du Kotlin et de lib/origin.ts : scheme +
/// autorité, en minuscules, userinfo compris.
func originOf(_ url: String) -> String? {
  guard let regex = try? NSRegularExpression(pattern: "^(https?://[^/?#]+)", options: .caseInsensitive),
    let match = regex.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)),
    let range = Range(match.range(at: 1), in: url)
  else { return nil }
  return url[range].lowercased()
}

/// La session dont le baseUrl a la MÊME ORIGINE que le host du push. Le host
/// vient du payload, que quiconque connaît le jeton peut forger : jamais de
/// repli sur une autre session, sinon le jeton partirait vers son domaine.
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
