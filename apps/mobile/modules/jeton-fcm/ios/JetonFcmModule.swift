import ExpoModulesCore
import FirebaseCore
import FirebaseMessaging

/**
 * Le jeton FCM de l'appareil iOS, celui que Rocket.Chat attend en `gcm`.
 *
 * `getDevicePushTokenAsync()` rend le jeton APNs brut : FCM le refuse, et le
 * serveur supprimerait l'enregistrement. On le remet à Firebase, qui le troque
 * contre un jeton FCM. Le swizzling de Firebase est coupé
 * (`FirebaseAppDelegateProxyEnabled = false`, plugins/with-ios-push.js) pour ne
 * pas disputer l'AppDelegate à expo-notifications : c'est ce module qui lui
 * passe le jeton APNs.
 */
public class JetonFcmModule: Module {
  private let relais = RelaisJeton()

  public func definition() -> ModuleDefinition {
    Name("JetonFcm")

    Events("jetonRenouvele")

    OnCreate {
      if FirebaseApp.app() == nil {
        FirebaseApp.configure()
      }
      relais.quand = { [weak self] jeton in
        self?.sendEvent("jetonRenouvele", ["jeton": jeton])
      }
      Messaging.messaging().delegate = relais
    }

    AsyncFunction("obtenir") { (jetonApnsHex: String, promise: Promise) in
      guard let jetonApns = donneesDepuisHex(jetonApnsHex) else {
        promise.reject("E_JETON_APNS", "jeton APNs illisible")
        return
      }
      let messaging = Messaging.messaging()
      messaging.setAPNSToken(jetonApns, type: .unknown)
      messaging.token { jeton, erreur in
        if let erreur {
          promise.reject("E_JETON_FCM", erreur.localizedDescription)
        } else if let jeton, !jeton.isEmpty {
          promise.resolve(jeton)
        } else {
          promise.reject("E_JETON_FCM", "jeton FCM vide")
        }
      }
    }
  }
}

private final class RelaisJeton: NSObject, MessagingDelegate {
  var quand: ((String) -> Void)?

  func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
    guard let fcmToken, !fcmToken.isEmpty else { return }
    quand?(fcmToken)
  }
}

private func donneesDepuisHex(_ hex: String) -> Data? {
  guard hex.count % 2 == 0, !hex.isEmpty else { return nil }
  var donnees = Data(capacity: hex.count / 2)
  var index = hex.startIndex
  while index < hex.endIndex {
    let suivant = hex.index(index, offsetBy: 2)
    guard let octet = UInt8(hex[index..<suivant], radix: 16) else { return nil }
    donnees.append(octet)
    index = suivant
  }
  return donnees
}
