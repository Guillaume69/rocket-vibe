import ExpoModulesCore
import ExpoNotifications
import UIKit
import UserNotifications

/**
 * « Répondre » depuis une notification iOS, pendant de ReponseNotifReceiver
 * (plugins/with-fcm-deeplink.js) : le texte part par `chat.sendMessage` depuis
 * le natif, sans attendre le JS.
 *
 * Abonné au DÉMARRAGE de l'app, pas à la création des modules : iOS peut
 * relancer l'app en arrière-plan juste pour livrer la réponse, et un délégué
 * inscrit après coup la manquerait si celui d'expo l'avait déjà consommée.
 */
public class ReponseNotifAppDelegate: ExpoAppDelegateSubscriber {
  private let gestion = GestionReponse()

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NotificationCenterManager.shared.addDelegate(gestion)
    enregistrerCategorie()
    return true
  }
}

private func enregistrerCategorie() {
  let fr = languePreferee() == "fr"
  let action = UNTextInputNotificationAction(
    identifier: actionRepondre,
    title: fr ? "Répondre" : "Reply",
    options: [],
    textInputButtonTitle: fr ? "Envoyer" : "Send",
    textInputPlaceholder: "Message"
  )
  let categorie = UNNotificationCategory(identifier: categorieMessage, actions: [action], intentIdentifiers: [], options: [])
  let centre = UNUserNotificationCenter.current()
  centre.getNotificationCategories { existantes in
    centre.setNotificationCategories(existantes.filter { $0.identifier != categorieMessage }.union([categorie]))
  }
}

private final class GestionReponse: NotificationDelegate {
  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    guard response.actionIdentifier == actionRepondre,
      let saisie = response as? UNTextInputNotificationResponse
    else { return false }

    let contenu = response.notification.request.content
    let texte = saisie.userText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !texte.isEmpty,
      let corps = contenu.userInfo["body"] as? [String: Any],
      let brut = corps["ejson"] as? String,
      let ejson = objetJson(brut),
      let rid = ejson["rid"] as? String,
      let host = ejson["host"] as? String
    else { return true }
    let tmid = (ejson["tmid"] as? String).flatMap { $0.isEmpty ? nil : $0 }

    // expo rend la main au système dès notre retour : sans tâche de fond, iOS
    // pourrait suspendre l'app avant la fin de la requête.
    let application = UIApplication.shared
    var tacheFond = UIBackgroundTaskIdentifier.invalid
    let finir = {
      guard tacheFond != .invalid else { return }
      application.endBackgroundTask(tacheFond)
      tacheFond = .invalid
    }
    tacheFond = application.beginBackgroundTask(withName: "rv-reponse", expirationHandler: finir)

    guard let session = lireSession(host: host) else {
      signalerEchec(contenu)
      finir()
      return true
    }
    envoyerReponse(session: session, rid: rid, tmid: tmid, texte: texte) { envoye in
      DispatchQueue.main.async {
        if !envoye { signalerEchec(contenu) }
        finir()
      }
    }
    return true
  }
}

/// POST <baseUrl>/api/v1/chat.sendMessage, avec la session lue au trousseau.
private func envoyerReponse(session: Session, rid: String, tmid: String?, texte: String, quand: @escaping (Bool) -> Void) {
  guard let url = URL(string: session.baseUrl.trimmingSuffix("/") + "/api/v1/chat.sendMessage") else {
    quand(false)
    return
  }
  var message: [String: Any] = ["rid": rid, "msg": texte]
  if let tmid { message["tmid"] = tmid }
  var requete = URLRequest(url: url, timeoutInterval: 20)
  requete.httpMethod = "POST"
  requete.httpBody = try? JSONSerialization.data(withJSONObject: ["message": message])
  requete.setValue(session.userId, forHTTPHeaderField: "X-User-Id")
  requete.setValue(session.authToken, forHTTPHeaderField: "X-Auth-Token")
  requete.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
  requete.setValue("application/json", forHTTPHeaderField: "Accept")
  URLSession.shared.dataTask(with: requete) { donnees, reponse, _ in
    guard (reponse as? HTTPURLResponse)?.statusCode == 200,
      let donnees,
      let json = (try? JSONSerialization.jsonObject(with: donnees)) as? [String: Any]
    else {
      quand(false)
      return
    }
    quand(json["success"] as? Bool == true)
  }.resume()
}

/// La réponse n'est pas partie : une notification le dit, dans le même fil et
/// avec la même action, pour réessayer d'un geste.
private func signalerEchec(_ origine: UNNotificationContent) {
  guard let contenu = origine.mutableCopy() as? UNMutableNotificationContent else { return }
  contenu.body = languePreferee() == "fr" ? "Réponse non envoyée" : "Reply not sent"
  contenu.sound = nil
  let requete = UNNotificationRequest(identifier: UUID().uuidString, content: contenu, trigger: nil)
  UNUserNotificationCenter.current().add(requete)
}
