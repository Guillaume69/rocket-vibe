import Foundation
import Security
import UserNotifications

/**
 * Pendant iOS de RocketVibeMessagingService (plugins/with-fcm-deeplink.js).
 * Copié dans ios/NotificationService/ par plugins/with-ios-push.js.
 *
 * Le serveur (bundle patché, docker/patch-push.mjs) pose `mutable-content` :
 * iOS réveille cette extension avant d'afficher chaque push. En mode « contenu
 * masqué », le push ne porte qu'un messageId ; on lit la session dans le
 * trousseau partagé avec l'app et on demande le contenu à `push.get`.
 *
 * Deux différences avec Android, imposées par iOS :
 * - aucune notification ne peut être supprimée (il faudrait l'entitlement de
 *   filtrage, sur dossier Apple) : sans session, on remplace le texte par un
 *   générique au lieu d'avaler le push ;
 * - pas de WorkManager : un fetch raté laisse « Nouveau message », sans
 *   rattrapage. L'ouverture de l'app resynchronise de toute façon.
 *
 * Le tap est routé par expo-notifications, qui expose `userInfo["body"]` comme
 * `data` d'un push distant : on y range `ejson` (avec `rid` et `host`), la
 * forme que lit `cibleDeNotification` dans ui/notifications.tsx.
 */
class NotificationService: UNNotificationServiceExtension {
  private var livrer: ((UNNotificationContent) -> Void)?
  private var contenu: UNMutableNotificationContent?
  private var tache: URLSessionDataTask?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    livrer = contentHandler
    guard let contenu = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    self.contenu = contenu

    guard
      let brut = request.content.userInfo["ejson"] as? String,
      let ejson = objetJson(brut),
      let host = ejson["host"] as? String
    else {
      terminer()
      return
    }
    let langue = languePreferee()

    guard let session = lireSession(host: host) else {
      contenu.body = Chaines.nouveauMessage(langue)
      terminer()
      return
    }

    if ejson["notificationType"] as? String == "message-id-only" {
      guard let messageId = ejson["messageId"] as? String, !messageId.isEmpty else {
        terminer()
        return
      }
      tache = recupererContenu(messageId: messageId, session: session) { [weak self] notification in
        guard let self, let contenu = self.contenu else { return }
        if let notification,
          let payload = notification["payload"] as? [String: Any],
          let rid = payload["rid"] as? String, !rid.isEmpty
        {
          appliquer(
            contenu,
            titre: notification["title"] as? String ?? contenu.title,
            texte: notification["text"] as? String ?? contenu.body,
            payload: payload,
            rid: rid,
            host: host,
            langue: langue
          )
        } else {
          contenu.body = Chaines.nouveauMessage(langue)
        }
        self.terminer()
      }
      return
    }

    if let rid = ejson["rid"] as? String, !rid.isEmpty {
      appliquer(contenu, titre: contenu.title, texte: contenu.body, payload: ejson, rid: rid, host: host, langue: langue)
    }
    terminer()
  }

  override func serviceExtensionTimeWillExpire() {
    DispatchQueue.main.async { [self] in
      tache?.cancel()
      if let contenu, contenu.userInfo["body"] == nil {
        contenu.body = Chaines.nouveauMessage(languePreferee())
      }
      terminer()
    }
  }

  private func terminer() {
    guard let livrer, let contenu else { return }
    self.livrer = nil
    livrer(contenu)
  }
}

private func appliquer(
  _ contenu: UNMutableNotificationContent,
  titre: String,
  texte texteInitial: String,
  payload: [String: Any],
  rid: String,
  host: String,
  langue: String
) {
  var texte = texteInitial
  if payload["messageType"] as? String == "e2e" {
    texte = Chaines.messageChiffre(langue)
  }
  let sender = payload["sender"] as? [String: Any]
  let username = sender?["username"] as? String ?? ""
  let nom = (sender?["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (username.isEmpty ? titre : username)

  if payload["type"] as? String == "d" {
    contenu.title = nom
    if !username.isEmpty, texte.hasPrefix(username + ": ") {
      texte = String(texte.dropFirst(username.count + 2))
    }
  } else {
    contenu.title = titre
  }
  contenu.body = texte
  contenu.threadIdentifier = rid

  var ejson = payload
  ejson["rid"] = rid
  ejson["host"] = host
  if let donnees = try? JSONSerialization.data(withJSONObject: ejson),
    let chaine = String(data: donnees, encoding: .utf8)
  {
    var userInfo = contenu.userInfo
    userInfo["body"] = ["ejson": chaine]
    contenu.userInfo = userInfo
  }
}

private enum Chaines {
  static func nouveauMessage(_ langue: String) -> String { langue == "fr" ? "Nouveau message" : "New message" }
  static func messageChiffre(_ langue: String) -> String { langue == "fr" ? "Message chiffré" : "Encrypted message" }
}

// MARK: - Trousseau (format d'expo-secure-store 57)

/// expo-secure-store range chaque clé en kSecClassGenericPassword, service
/// `app:no-auth`, compte = la clé en UTF-8. Le groupe d'accès partagé est posé
/// par plugins/with-ios-push.js sur l'app ET sur l'extension.
private let serviceSecureStore = "app:no-auth"

private func lireTrousseau(_ cle: String) -> String? {
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

private func clesTrousseau() -> [String] {
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

private func languePreferee() -> String {
  if let choisie = lireTrousseau("langue-preferee"), choisie == "fr" || choisie == "en" {
    return choisie
  }
  return Locale.preferredLanguages.first?.hasPrefix("fr") == true ? "fr" : "en"
}

private struct Session {
  let baseUrl: String
  let userId: String
  let authToken: String
}

/// Même règle que `origineDe` du Kotlin et de lib/origine.ts : scheme +
/// autorité, en minuscules, userinfo compris.
private func origineDe(_ url: String) -> String? {
  guard let regex = try? NSRegularExpression(pattern: "^(https?://[^/?#]+)", options: .caseInsensitive),
    let trouve = regex.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)),
    let plage = Range(trouve.range(at: 1), in: url)
  else { return nil }
  return url[plage].lowercased()
}

/// La session dont le baseUrl a la MÊME ORIGINE que le host du push. Le host
/// vient du payload, que quiconque connaît le jeton peut forger : jamais de
/// repli sur une autre session, sinon le jeton partirait vers son domaine.
private func lireSession(host: String) -> Session? {
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

// MARK: - push.get

private func recupererContenu(
  messageId: String,
  session: Session,
  quand: @escaping ([String: Any]?) -> Void
) -> URLSessionDataTask? {
  var composants = URLComponents(string: session.baseUrl.trimmingSuffix("/") + "/api/v1/push.get")
  composants?.queryItems = [URLQueryItem(name: "id", value: messageId)]
  guard let url = composants?.url else {
    quand(nil)
    return nil
  }
  var requete = URLRequest(url: url, timeoutInterval: 20)
  requete.setValue(session.userId, forHTTPHeaderField: "X-User-Id")
  requete.setValue(session.authToken, forHTTPHeaderField: "X-Auth-Token")
  requete.setValue("application/json", forHTTPHeaderField: "Accept")
  let tache = URLSession.shared.dataTask(with: requete) { donnees, reponse, _ in
    var notification: [String: Any]?
    if (reponse as? HTTPURLResponse)?.statusCode == 200,
      let donnees,
      let json = (try? JSONSerialization.jsonObject(with: donnees)) as? [String: Any],
      json["success"] as? Bool == true,
      let data = json["data"] as? [String: Any]
    {
      notification = data["notification"] as? [String: Any]
    }
    let resultat = notification
    DispatchQueue.main.async { quand(resultat) }
  }
  tache.resume()
  return tache
}

private func objetJson(_ texte: String) -> [String: Any]? {
  guard let donnees = texte.data(using: .utf8) else { return nil }
  return (try? JSONSerialization.jsonObject(with: donnees)) as? [String: Any]
}

private extension String {
  func trimmingSuffix(_ suffixe: Character) -> String {
    var resultat = self
    while resultat.last == suffixe { resultat.removeLast() }
    return resultat
  }
}
