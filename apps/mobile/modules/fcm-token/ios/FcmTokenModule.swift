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
public class FcmTokenModule: Module {
  private let relay = TokenRelay()

  public func definition() -> ModuleDefinition {
    Name("FcmToken")

    Events("tokenRefreshed")

    OnCreate {
      if FirebaseApp.app() == nil {
        FirebaseApp.configure()
      }
      relay.onToken = { [weak self] token in
        self?.sendEvent("tokenRefreshed", ["token": token])
      }
      Messaging.messaging().delegate = relay
    }

    AsyncFunction("getToken") { (apnsTokenHex: String, promise: Promise) in
      guard let apnsToken = dataFromHex(apnsTokenHex) else {
        promise.reject("E_APNS_TOKEN", "unreadable APNs token")
        return
      }
      let messaging = Messaging.messaging()
      messaging.setAPNSToken(apnsToken, type: .unknown)
      messaging.token { token, error in
        if let error {
          promise.reject("E_FCM_TOKEN", error.localizedDescription)
        } else if let token, !token.isEmpty {
          promise.resolve(token)
        } else {
          promise.reject("E_FCM_TOKEN", "empty FCM token")
        }
      }
    }
  }
}

private final class TokenRelay: NSObject, MessagingDelegate {
  var onToken: ((String) -> Void)?

  func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
    guard let fcmToken, !fcmToken.isEmpty else { return }
    onToken?(fcmToken)
  }
}

private func dataFromHex(_ hex: String) -> Data? {
  guard hex.count % 2 == 0, !hex.isEmpty else { return nil }
  var data = Data(capacity: hex.count / 2)
  var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
    data.append(byte)
    index = next
  }
  return data
}
