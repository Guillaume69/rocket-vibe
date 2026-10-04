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
/// et son action de saisie, enregistrée par ReponseNotifAppDelegate.
let categorieMessage = "rv-message"
let actionRepondre = "rv-repondre"

// MARK: - Trousseau (format d'expo-secure-store 57)

/// expo-secure-store range chaque clé en kSecClassGenericPassword, service
/// `app:no-auth`, compte = la clé en UTF-8. Le groupe d'accès partagé est posé
/// par plugins/with-ios-push.js sur l'app ET sur l'extension.
let serviceSecureStore = "app:no-auth"

func lireTrousseau(_ cle: String) -> String? {
  let requete: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: serviceSecureStore,
    kSecAttrAccount as String: Data(cle.utf8),
    kSecMatchLimit as String: kSecMatchLimitOne,
    kSecReturnData as String: true,
  ]
  var resultat: CFTypeRef?
  guard SecItemCopyMatching(requete as CFDictionary, &resultat) == errSecSuccess,
    let donnees = resultat as? Data
  else { return nil }
  return String(data: donnees, encoding: .utf8)
}

func clesTrousseau() -> [String] {
  let requete: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: serviceSecureStore,
    kSecMatchLimit as String: kSecMatchLimitAll,
    kSecReturnAttributes as String: true,
  ]
  var resultat: CFTypeRef?
  guard SecItemCopyMatching(requete as CFDictionary, &resultat) == errSecSuccess,
    let elements = resultat as? [[String: Any]]
  else { return [] }
  return elements.compactMap { element in
    (element[kSecAttrAccount as String] as? Data).flatMap { String(data: $0, encoding: .utf8) }
  }
}

func languePreferee() -> String {
  if let choisie = lireTrousseau("langue-preferee"), choisie == "fr" || choisie == "en" {
    return choisie
  }
  return Locale.preferredLanguages.first?.hasPrefix("fr") == true ? "fr" : "en"
}

struct Session {
  let baseUrl: String
  let userId: String
  let authToken: String
}

/// Même règle que `origineDe` du Kotlin et de lib/origin.ts : scheme +
/// autorité, en minuscules, userinfo compris.
func origineDe(_ url: String) -> String? {
  guard let regex = try? NSRegularExpression(pattern: "^(https?://[^/?#]+)", options: .caseInsensitive),
    let trouve = regex.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)),
    let plage = Range(trouve.range(at: 1), in: url)
  else { return nil }
  return url[plage].lowercased()
}

/// La session dont le baseUrl a la MÊME ORIGINE que le host du push. Le host
/// vient du payload, que quiconque connaît le jeton peut forger : jamais de
/// repli sur une autre session, sinon le jeton partirait vers son domaine.
func lireSession(host: String) -> Session? {
  guard let attendue = origineDe(host) else { return nil }
  for cle in clesTrousseau() where cle.hasPrefix("session-") {
    guard let brut = lireTrousseau(cle),
      let objet = objetJson(brut),
      let baseUrl = objet["baseUrl"] as? String,
      let userId = objet["userId"] as? String, !userId.isEmpty,
      let authToken = objet["authToken"] as? String, !authToken.isEmpty,
      origineDe(baseUrl) == attendue
    else { continue }
    return Session(baseUrl: baseUrl, userId: userId, authToken: authToken)
  }
  return nil
}

func objetJson(_ texte: String) -> [String: Any]? {
  guard let donnees = texte.data(using: .utf8) else { return nil }
  return (try? JSONSerialization.jsonObject(with: donnees)) as? [String: Any]
}

extension String {
  func trimmingSuffix(_ suffixe: Character) -> String {
    var resultat = self
    while resultat.last == suffixe { resultat.removeLast() }
    return resultat
  }
}
