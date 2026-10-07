# Notifications

The mobile app gets FCM push from Rocket.Chat even when killed, fetches the hidden content itself (`push.get`), and shows one grouped conversation notification per room with an inline reply. The desktop app has no push: while it runs it watches the live message stream and raises system notifications, and it shows an unread badge on the app icon. Neither ever shows ciphertext from an encrypted room.

## Mobile

### The push chain

1. **Token.** `lib/push.ts` creates the Android channel `default` (importance HIGH) **before** asking permission (otherwise the Android 13+ `POST_NOTIFICATIONS` prompt never shows), then reads the native FCM token with `getDevicePushTokenAsync()`. Never the Expo push token: no Expo service in the loop. On iOS that call returns an APNs token, which `modules/fcm-token` (Swift) hands to Firebase to get an FCM token.
2. **Registration.** `lib/pushToken.ts`: `POST push.token {type: 'gcm', value, appName: 'rocket-vibe'}`, nothing more (`additionalProperties: false`). iOS registers its FCM token as `gcm` too. `ui/sync.tsx` registers once per session at the first successful connection; a Play Services failure re-arms the attempt for the next connection, a refused permission does not (it would replay the system prompt on every network flap). `onTokenRotation` re-registers when FCM rotates the token mid-session. The token is remembered in the Keystore (`device-push-token`, moved from the pre-0016 `jeton-push-appareil` on first read) so that sign-out can remove it without asking FCM again.
3. **Sign-out.** `DELETE push.token {token}`; a 404 counts as success. If offline, `lib/deferredLogout.ts` keeps the token removal and the `logout` and replays them at next launch, otherwise the server would keep pushing to an account-less device.
4. **Server side.** Rocket.Chat 8.5 speaks only FCM HTTP v1 (`Push_enable_gateway = false`, service account JSON in `Push_google_api_credentials`). The gateway switch is global, so `docker/patch-push.mjs` patches the server bundle to route only `appName: rocket-vibe` tokens natively and keep the gateway for the official apps, and adds an `apns` block (`mutable-content: 1`). The server only pushes to **offline** users, and by default only for DMs and mentions. Details and pitfalls (`am force-stop` vs `am kill`, 2FA for settings): `docs/PUSH.md` and [../architecture/rocket-chat.md](../architecture/rocket-chat.md).

### Android: the native service

`plugins/with-fcm-deeplink.js` generates Kotlin into `android/` at prebuild (CNG, see [../architecture/mobile-native.md](../architecture/mobile-native.md)): `RocketVibeMessagingService`, a `FirebaseMessagingService` with a higher priority than expo-notifications', plus `PushCatchUpWorker` (unique work `push-catch-up-<messageId>`) and `NotificationReplyReceiver`. The pre-rename `RattrapagePushWorker` and `ReponseNotifReceiver` survive one release as empty subclasses, so a catch-up queued or a notification posted by the previous build still runs; a cancellation cancels both the new and the old `rattrapage-push-` work name.

- **Data-only.** Rocket.Chat sends a `notification` block; app killed, Firebase would auto-display it and wire the tap to its default intent, so the deep link never fired. `handleIntent` copies title/body into the data keys expo reads, points the channel at `default`, then strips every `gcm.notification.*` key so the message is handled as data-only even with the process dead.
- **Grouped per room.** A message push (an `ejson` with `rid`) is posted by the service itself as a `MessagingStyle` notification whose id is `rid.hashCode()`. The previous style is re-extracted from the active notification and appended to, so a room's messages accumulate in one notification. DMs have no conversation title; channels use the push title. A `username: ` prefix already carried by the sender `Person` is stripped. Other pushes fall through to expo unchanged.
- **Tap.** A `rocketvibe://room/<rid>?host=<server>` VIEW intent with only `FLAG_ACTIVITY_NEW_TASK` (no `CLEAR_TASK`, which recreated the activity and broke expo-image-picker's launchers; no `SINGLE_TOP`, which blocked navigation). See [sharing-and-links.md](sharing-and-links.md).
- **Hidden content (`message-id-only`).** The target server has `Push_request_content_from_server` active, so a push carries only `{host, messageId}`. The service reads the stored session without any JS runtime (expo-secure-store's `SharedPreferences "SecureStore"`, entry `key_v1-session-<hash>`, AES/GCM key in the AndroidKeyStore), then calls `GET /api/v1/push.get?id=<messageId>` (3 s timeout) and displays the returned title/text/payload. The content never transits through Google.
- **Origin guard.** `readSession` only accepts a session whose `baseUrl` has the same origin as the push's `host` (Kotlin twin of `lib/origin.ts`). An earlier fallback ("only one session, take it") would have sent `X-Auth-Token` to any host named in a forged push.
- **No session, no notification.** A push for a host with no stored session (signed out, server not yet told) is swallowed in both branches; before, it showed full content or an undismissable "New message".
- **Fetch failure.** The service posts a degraded "New message" notification at once (id `messageId.hashCode()`, tap opens the app), then enqueues `PushCatchUpWorker` (WorkManager, network constraint, linear backoff 30 s, 8 attempts, unique per messageId, `KEEP`). A 429 delays the first attempt by `x-ratelimit-reset` (capped at 60 s); `push.get` shares the 10 req/min REST limit, so a burst in a busy room degrades first. When the worker succeeds it replaces the degraded notification silently. A 401/403 is final: no retry.
- **Anti-duplicate.** FCM redelivers an unacknowledged push when the network returns, which also wakes the worker. A direct success cancels the degraded notification and the pending worker; `alreadyShown` is an atomic test-and-set in SharedPreferences (`rvpush-shown`, one hour retention, written with `commit()`; the previous build's `rvpush-affiches` is still read, so a push straddling the update is not shown twice) so one messageId produces at most one conversation entry. On any exception it answers "not shown": a duplicate beats a lost message.
- **Encrypted rooms.** `messageType: 'e2e'` replaces the text with `rv_push_encrypted_message` and drops the reply action.
- **Reply from the notification.** A `RemoteInput` action (key `rv_reply`, the old `rv_reponse` still read; mutable explicit `PendingIntent`) delivers the text to `NotificationReplyReceiver`, which reads the session with the same origin guard and posts `chat.sendMessage` (with `tmid` for a thread message) inside `goAsync()` (4 s timeouts). The notification is always reposted afterwards, with the reply appended as "You", or a "Reply not sent" subtext and the field kept for a retry.
- **Strings.** Five native strings in `res/values[-fr]/strings.xml`, generated by the plugin; the language follows the app's explicit choice (`key_v1-preferred-language`, else the pre-rename `key_v1-langue-preferee`) before the phone's locale.
- **Log.** Every step is appended to `files/rvpush.log` (technical ids only, no content), because logcat's buffer was too short for overnight incidents. The debug probe (a second `push.get` after a content push) runs only when the flag file `files/rvpush-probe` exists.

### iOS

Same route: FCM token as `gcm`, FCM relays to APNs with the `.p8` key set in the Firebase console. `plugins/ios-notification-service/NotificationService.swift` is a Notification Service Extension: it reads the session from the shared keychain group, calls `push.get`, rewrites title and body, sets `threadIdentifier` to the rid and stores `rid`/`host` in `ejson` for the tap. iOS limits: it cannot drop a push (no filtering entitlement), so without a session it shows "New message"; there is no deferred catch-up. Session and language are written `AFTER_FIRST_UNLOCK` so the extension can read them with the phone locked. Reply is an iOS text-input action on category `rv-message` (not for encrypted rooms), sent natively by `modules/notification-reply` (`chat.sendMessage`). `plugins/with-ios-push.js` wires the target, entitlements and pods. **Never built with Xcode** yet; checked under Linux only (`docs/PUSH.md`).

### In the app

`ui/notifications.tsx`:
- `setNotificationHandler` shows expo-handled notifications in the foreground (banner, no sound) and replaces those of encrypted rooms (`isRoomEncrypted`, `ui/notificationState.ts`) with `notifications.encryptedTitle` / `notifications.encryptedBody`.
- Taps on expo-posted notifications (and all taps on iOS) are routed to `/room/[rid]` with `host`, once per response, and `clearLastNotificationResponseAsync` is called so a stale response cannot reopen an old room on a later launch.
- **Badge**: the sum of `unread` over subscriptions, via `setBadgeCountAsync`.
- **Read means dismissed**: when a room's unread count drops to 0 (read here or on another device), its notification is removed. On Android this uses `roomNotificationId(rid)` (`lib/notificationId.ts`): `expo-notifications://foreign_notifications?id=<hash>`, where `hashCodeJava` reproduces `java.lang.String.hashCode` in 32-bit signed arithmetic, the only bridge from JS to a notification posted by Kotlin. On iOS it matches presented notifications by their `ejson.rid`.
- `forgetNotificationState` clears the encrypted-room set and the badge at sign-out.
- **Preference**: Settings writes `pushNotifications` (`all`, `mention`, `nothing`) with `users.setPreferences`, a per-account server setting; see [settings.md](settings.md). A diagnostic button shows the FCM token.

## Desktop

- **Source.** `Session::incoming` (`rv-core/src/session.rs`) inspects each `stream-room-messages` event: skipped if it is mine, an edit, a system message other than `e2e`, or already in the store. `rv-core/src/notify.rs` builds an `Incoming` (author, room, DM or not, `mentions_me` from the parsed `md` or the text, body without ciphertext) and filters it with the account's `desktopNotifications` preference: `all`, `nothing`, otherwise DMs and mentions (`@me`, `@all`, `@here`).
- **Suppression.** No notification when the window is active and already showing that room (`window.rs::notify`; the SwiftUI app checks `NSApp.isActive` and the open room).
- **Body.** `body_of` strips the quote permalink prefix, resolves emoji shortcodes, or names the file (📎) or image (🖼️). Encrypted: the `message.encrypted` string.
- **Linux** (`rv-gtk/src/notifier.rs`): D-Bus `org.freedesktop.Notifications`, one notification per room (`replaces_id`), category `im.received`, `desktop-entry` hint. If the server advertises `inline-reply` (KDE Plasma), the reply typed in the notification is sent to the room; otherwise (GNOME) a Reply button opens the message with the composer ready. Opening a room closes its notification (`withdraw`).
- **Windows and macOS** (no session bus): `rv-native` posts WinRT toasts (`toast_xml`, tag per room, inline reply box) or `UNUserNotificationCenter` notifications; clicks and replies come back through `rv_native::Event`. GLib notifications are the fallback when `rv-native` is unavailable (click only).
- **Badge** (`rv-gtk/src/badge.rs`, `rv-core/src/rooms.rs`): `attention` counts unread DMs plus mentions; plain unread chatter gives a dot. Windows taskbar and macOS dock through `rv-native` (`badge_text` caps at "99+"); on Linux the Unity `LauncherEntry` D-Bus signal (KDE, Dash to Dock, Plank), count only.
- **Running in the background** (`rv-gtk/src/background.rs`): on Windows and macOS closing the window keeps the app running (tray icon, dock), with optional start at login (`--background`); on Linux closing quits.
- **Settings**: the `desktopNotifications` preference, which backend shows notifications, a test notification, and a link to the OS notification settings.
- **SwiftUI** (`macos/Sources/RocketVibe/Notifier.swift`): `UNUserNotificationCenter` with a `message` category and a text-input Reply, one request per message grouped by `threadIdentifier = rid`, dock badge from `onAttention`. No background mode yet.

## Parity

The desktop equivalent of push only works while the app runs. Both apps: DMs and mentions by default, click opens the room, inline reply where the platform allows, no ciphertext, unread badge. Mobile only: delivery with the app killed, hidden-content fetch, deferred catch-up. Different preference keys: mobile edits `pushNotifications`, desktop `desktopNotifications`.

## Sources

- docs/PUSH.md
- docker/patch-push.mjs
- apps/mobile/plugins/with-fcm-deeplink.js
- apps/mobile/plugins/with-ios-push.js
- apps/mobile/plugins/ios-notification-service/NotificationService.swift
- apps/mobile/modules/fcm-token
- apps/mobile/modules/notification-reply/ios/NotificationReplyAppDelegate.swift
- apps/mobile/modules/notification-reply/ios/SessionPush.swift
- apps/mobile/lib/push.ts
- apps/mobile/lib/pushToken.ts
- apps/mobile/lib/deferredLogout.ts
- apps/mobile/lib/notificationId.ts
- apps/mobile/lib/origin.ts
- apps/mobile/lib/sessionStore.ts
- apps/mobile/lib/storageKeys.ts
- apps/mobile/ui/notifications.tsx
- apps/mobile/ui/notificationState.ts
- apps/mobile/ui/sync.tsx
- apps/mobile/ui/i18n.ts
- apps/mobile/ui/settingsSections.tsx
- apps/desktop/crates/rv-core/src/notify.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/rooms.rs
- apps/desktop/crates/rv-gtk/src/notifier.rs
- apps/desktop/crates/rv-gtk/src/badge.rs
- apps/desktop/crates/rv-gtk/src/background.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-gtk/src/settings.rs
- apps/desktop/crates/rv-native/src/lib.rs
- apps/desktop/crates/rv-native/src/windows_impl.rs
- apps/desktop/crates/rv-native/src/macos_impl.rs
- apps/desktop/macos/Sources/RocketVibe/Notifier.swift
- apps/desktop/macos/Sources/RocketVibe/RocketVibeApp.swift
