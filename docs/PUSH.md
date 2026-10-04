# Push: kill gate verdict

**PASS on the emulator.** Full chain proven on 2026-07-10: Firebase → Rocket.Chat 8.5 → FCM HTTP v1 → emulator → system notification, **including with the process killed**.

Still to confirm on the Pixel 10 Pro (step 2.5b) for Doze and real-world conditions.

## The chain, as observed

1. `getDevicePushTokenAsync()` returns a native FCM token (`…:APA91b…`), not an Expo Push token.
2. `POST /api/v1/push.token` `{type:'gcm', value, appName}` → stored in the Mongo collection **`_raix_push_app_tokens`**, in the form `token: { gcm: '…' }`.
3. Server settings (`Admin → Push`, all changed through the API with 2FA):

| Setting | Value |
|---|---|
| `Push_enable` | `true` |
| `Push_enable_gateway` | `false` |
| `Push_google_api_credentials` | the **complete** service-account JSON, as a string |

4. When a DM reaches an **offline** user, the server emits:

```
POST https://fcm.googleapis.com/v1/projects/rocket-vibe/messages:send
{
  "message": {
    "notification": { "title": "admin", "body": "…" },
    "data": {
      "ejson": "{\"host\":\"…\",\"messageId\":\"…\",\"notificationType\":\"message\",
                 \"rid\":\"…\",\"sender\":{…},\"type\":\"d\",\"tmid\":null}",
      "msgcnt": "15", "notId": "…", "style": "inbox"
    },
    "android": { "priority": "HIGH" },
    "token": "…"
  }
}
```

The deep link's `rid` lives in `data.ejson`, not at the root.

## Patched server bundle

The gateway / native choice is GLOBAL to the server (`shouldUseGateway()` in `app/push/server/push.ts`): with the gateway off, the official apps' tokens go to our Firebase project, FCM answers `SENDER_ID_MISMATCH` and the server **deletes** them. The official apps get no more push on this server.

`docker/patch-push.mjs` edits the image's bundle (`/app/bundle/programs/server/app/app.js`, readable, not minified):

1. the gateway only serves tokens whose `appName` is not `rocket-vibe`: ours go native, the official apps keep the gateway. `Push_enable_gateway` can go back to `true`, `Push_google_api_credentials` stays filled in;
2. the FCM message carries an `apns` block (`mutable-content: 1`, `thread-id` = `notId`): an iOS FCM token registered as `gcm` wakes the Notification Service Extension. On the Firebase side, the APNs `.p8` key is uploaded in the console; nothing APNs-related on the Rocket.Chat side.

```sh
node docker/patch-push.mjs                  # tag read from docker/compose.yml -> docker/patched/app-<tag>.js
node docker/patch-push.mjs <image:tag>      # explicit image, for the production server
```

The compose file mounts `patched/app-${RC_VERSION}.js` with `create_host_path: false`: after a version upgrade, `up` fails until the script has been rerun. The script stops if an anchor does not appear exactly once (code changed upstream) and keeps the line count, so `app.js.map` stays aligned.

Checked on the 8.5.1 test bench: healthy startup on the patched bundle, shape of the FCM message checked by isolating `getFCMMessagesFromPushData`. **Not yet checked**: FCM's acceptance of the `apns` block (the bench has no service account) and the gateway branch (the bench is not registered on RC Cloud), to be confirmed on `chat.barrut.me`.

## iOS

Same path as Android: an **FCM** token registered as `gcm`, Rocket.Chat pushes to FCM, FCM relays to APNs with the `.p8` key uploaded in the Firebase console (project `rocket-vibe`, iOS app `com.rocketvibe.app`). No APNs setting on the Rocket.Chat side.

| Piece | Role |
|---|---|
| `apps/mobile/modules/fcm-token/` | Swift module: hands the APNs token (returned by `getDevicePushTokenAsync()`) to Firebase and returns the FCM token; emits `tokenRefreshed` on rotation. |
| `apps/mobile/plugins/with-ios-push.js` | `FirebaseAppDelegateProxyEnabled = false` (no swizzling against expo-notifications), Firebase pods as `modular_headers`, shared keychain group, `NotificationService` target. |
| `apps/mobile/plugins/ios-notification-service/NotificationService.swift` | Notification Service Extension, counterpart of the Kotlin service: reads the session from the keychain, `push.get`, rewrites title and body, `threadIdentifier` = rid, stores `ejson` (rid, host) in `userInfo["body"]`, which expo-notifications exposes as `data` on tap. |

What differs from Android, because of iOS constraints:

- the extension cannot **drop** a push (that would need the filtering entitlement, granted by Apple on application): without a session, it replaces the text with "New message" ("Nouveau message");
- no deferred catch-up: a failed or too slow (~30 s) `push.get` leaves "New message";
- the session and the language are written `AFTER_FIRST_UNLOCK` (`lib/sessionStore.ts`, `ui/i18n.ts`): with the `WHEN_UNLOCKED` default, the extension could not read them with the screen locked;
- the keychain group `$(AppIdentifierPrefix)com.rocketvibe.app` is FIRST among the app's groups, so that is where expo-secure-store writes by default;
- "Reply" is an iOS text-input action: the extension sets the `rv-message` category (except in an encrypted room), and `modules/notification-reply` sends the text through `chat.sendMessage` natively, with the app woken in the background, without going through JS. On failure, a "Reply not sent" ("Réponse non envoyée") notification offers the same action again. The session code (`SessionPush.swift`) is shared by both targets.

Checked under Linux: `expo prebuild --platform ios --no-install` (target, embedding, settings, Podfile, entitlements), `swiftc -parse` of both Swift files, typecheck of the extension against stand-ins for the Apple APIs, and its logic run against the 8.5.1 bench (real `push.get`, foreign origin refused, fallback, E2EE, DM). **Never compiled with Xcode.**

### First build on a Mac

```sh
cd apps/mobile
npx expo prebuild --platform ios      # regenerates ios/ and runs pod install
open ios/rocketvibe.xcworkspace
```

1. Xcode, targets `rocketvibe` **and** `NotificationService` → Signing & Capabilities: choose the team (or `ios.appleTeamId` in `app.json`, picked up by the plugin for both targets).
2. Build on a **real iPhone** (the simulator has no reliable remote push).
3. Log in, accept notifications; check in the logs that `push.token` is sent with an FCM token (form `…:APA91b…`), not 64 hexadecimal characters.
4. App killed, a DM from another account while offline: the notification must show the real text (proof that the extension ran), grouped by room; tapping opens the room.
5. Do it again with the phone locked, then in airplane mode during delivery ("New message" expected).

Things to watch at the first `pod install` / build: the list of pods under `modular_headers` if CocoaPods asks for one more module, and the FirebaseMessaging version (not pinned in `FcmToken.podspec`).

## Three pitfalls verified in the field

### `Push_UseLegacy` no longer does anything in 8.5

The setting is still declared in the 8.5.1 bundle, hidden, `false` by default, like `Push_gcm_api_key` and `Push_gcm_project_number` (a `TODO` plans their removal). Only the admin screen reads it, to grey out fields: no sending code consults it. The legacy FCM API was **entirely removed** from Rocket.Chat 8.x: the server only speaks FCM HTTP v1, there is nothing to set. The research file claimed the opposite.

### `am force-stop` ≠ swiping from recents

`adb shell am force-stop <pkg>` puts the app in Android's **stopped** state, where FCM **delivers nothing to it** until a manual relaunch. No notification arrives, and it is **not** a push failure.

The right equivalent of a swipe-kill is **`adb shell am kill <pkg>`** (process killed, no stopped state): the notification arrives, and FCM **wakes the process** (checked: a new pid appears).

A spike using `force-stop` would wrongly conclude that push is dead.

### Changing a privileged setting requires 2FA

`POST /api/v1/settings/<id>` answers `errorType: totp-required`, `details.method: "password"`. The name is misleading: this is the **password fallback**, and the expected code is the **SHA-256 of the password**, never the plaintext password.

```sh
SHA=$(printf '%s' "$MOTDEPASSE" | sha256sum | cut -d' ' -f1)
curl -X POST -H "x-2fa-code: $SHA" -H "x-2fa-method: password" …
```

This is the generic mechanism of step 3.2, validated ahead of time.

## Two defects found during the spike, fixed since

Both are fixed: the Kotlin service (`plugins/with-fcm-deeplink.js`) renders the notification itself on our `default` channel, at `HIGH`, created by `lib/push.ts`, and `ui/notifications.tsx` sets a `setNotificationHandler`. The original finding:

1. **Wrong notification channel.** The notification lands on `fcm_fallback_notification_channel` (importance `3` = DEFAULT), not on our `default` channel at `HIGH`, so no *heads-up* banner. Cause: the server payload carries no `android_channel_id`, and the manifest lacks the `com.google.firebase.messaging.default_notification_channel_id` metadata. `logcat` says so: *"Missing Default Notification Channel metadata in AndroidManifest"*.

2. **Nothing shows in the foreground.** A `notification`-type FCM message received while the app is open is handed to the app, not to the system; `expo-notifications` shows nothing without `setNotificationHandler`. This is not a push bug: my first test, with the app in the foreground, nearly made me believe it was.

Fixing both went through rendering the notification **in the app** (`data`-only on the client side), as 6.3 planned: grouping by room, `MessagingStyle`, and generic text for encrypted rooms (`Push_show_message = true` would otherwise expose ciphertext).

## Test users and email 2FA

Rocket.Chat enables email 2FA only on a **verified address**. A user seeded with `verified: true` can no longer log in in dev, for lack of a mail server to receive the code (`availableMethods: ["email"]`, `codeGenerated: false`). `scripts/seed.mjs` therefore creates users with `verified: false`. The administrator, whose address is not verified, was not affected: hence the asymmetry, puzzling at first sight.
