import ExpoModulesCore
import FirebaseCore
import FirebaseMessaging

/**
 * The iOS device's FCM token, the one Rocket.Chat expects as `gcm`.
 *
 * `getDevicePushTokenAsync()` returns the raw APNs token: FCM rejects it, and the
 * server would delete the registration. We hand it to Firebase, which exchanges it
 * for an FCM token. Firebase swizzling is off
 * (`FirebaseAppDelegateProxyEnabled = false`, plugins/with-ios-push.js) so as not
 * to fight expo-notifications over the AppDelegate: this module is what passes
 * it the APNs token.
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
