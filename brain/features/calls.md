# Calls

This page is the **Rocket.Chat** path. A RocketVibe server has no video conference since
2026-10-06: its rooms call through voice sessions, see [voice](voice.md).

Video calls use the conference provider configured on the Rocket.Chat server (Jitsi on the target server). Both apps only start and join calls over REST and render the provider's web page in an embedded browser locked to the call's origin: a full-screen WebView on mobile (the app's single WebView exception) and a dedicated call window on desktop.

## Server contract

- `POST video-conference.start {roomId}` creates the conference **and** posts the call message (`t: 'videoconf'`) in the room, returning `data.callId`. That message is how the other members learn of the call: mobile ringing (`VideoConf_Mobile_Ringing`) is off on the target server.
- `POST video-conference.join {callId[, state: {cam, mic}]}` returns the provider URL to open, with the Jitsi JWT in it when the server requires one.
- `GET video-conference.capabilities` is the availability probe: `400 no-videoconf-provider-app` when no provider is installed (the local Docker server), and the call buttons stay hidden.
- `GET video-conference.info {callId}` (GTK and mobile) gives the call's own URL, used for the shareable link, cut before its query and fragment so the joiner's `jwt` never leaves (GTK `call::meeting_link`, mobile `withoutToken` in `lib/call.ts`). Its record (`rid`, `status` 0 calling, 1 started, 2 expired, 3 ended, 4 declined, `endedAt`, `createdBy`, `users` who joined) is what ringing reads (below). An unknown call answers 400 `invalid-params` (probed on 8.5.1, 2026-10-10).
- `POST video-conference.cancel {callId}` declines a direct call still calling. On the bench without a provider it marks the call declined, then answers 400 `video-conf-provider-unavailable` (probed 2026-10-10): the answer does not say whether it worked.
- **Any member can post a `videoconf` message**: `chat.sendMessage` accepts `t: 'videoconf'` with any `video_conf` block and `callId` (probed on 8.5.1, 2026-10-10). The message proves nothing; the call's record does.
- No DDP method is involved: REST to act, as everywhere ([../architecture/rocket-chat.md](../architecture/rocket-chat.md)).

**Availability probe caching.** Both apps remember the answer per server for the session: a definite "no" (a 4xx other than 401) sticks, a network failure (`status 0`) or a refused token (401) is not remembered, so a later room opening retries. When unsure the button is hidden: a missing button beats one that fails on tap. Mobile: `probeCallAvailable` / `memoizedCallAvailable` in `lib/call.ts`, cleared by `forgetCallAvailability` at session end (the store is module-level, so it was per process before). Desktop: `Session::call_available`.

## Why a WebView

ROADMAP §4.2 forbids WebViews in the mobile app, with one bounded exception: the call screen. Jitsi is a web app; its native SDK (`@jitsi/react-native-sdk`) targets React Native ~0.79 and bundles `react-native-webrtc`, a fragile bet under the New Architecture on RN 0.86. The bounds are non-negotiable: **one route**, and **navigation locked to the origin the server named**. The reason for the lock: while in a call the app holds camera and microphone, and on Android `react-native-webview` grants a page's `getUserMedia` without a prompt whatever its origin, so navigation is the only lever. Video links elsewhere stay native cards. See [../decisions.md](../decisions.md).

The desktop applies the same exception with the same bounds (2026-09-30), and there camera and microphone are also granted per origin.

## Mobile

- **Entry points.** The room header's video call button (`ui/roomHeader.tsx`, the camera icon, as on the desktop) and the profile sheet's Call button (`app/profile.tsx`, which opens or creates the DM first) call `startConference`, then push `/call/[callId]` with the room name as title. A call message renders as `CallCard` (`ui/messageRow.tsx`) with a Join button when its `callId` was extracted from the message block (`callId`, `lib/normalize.ts`); older messages without it show only the label.
- **Call screen** `app/call/[callId].tsx`:
  - asks `CAMERA` and `RECORD_AUDIO` up front (Android) so the system prompt appears before the call, not in the middle; a refusal does not block the call;
  - calls `joinConference`; a URL whose origin cannot be read is refused rather than loaded unguarded;
  - appends `#config.disableDeepLinking=true` so `meet.jit.si` skips its "open in the app" interstitial, which tried an `intent://` link and failed with `ERR_UNKNOWN_URL_SCHEME`;
  - sends an ordinary mobile Chrome user agent (without `; wv`), because Jitsi restricts WebViews it identifies;
  - `originWhitelist={[origin]}` plus `onShouldStartLoadWithRequest` allowing only `about:blank` and `sameOrigin(url, origin)` (`lib/origin.ts`, a regex origin parser, because React Native's `URL` polyfill never throws and returns `''` for `origin`);
  - `setSupportMultipleWindows={false}` keeps `target=_blank` links in the view, `mediaPlaybackRequiresUserAction={false}`, iOS `mediaCapturePermissionGrantType="grant"`;
  - hanging up leads Jitsi to a `close` page, detected in `onNavigationStateChange` to return to the room; the End button is the guaranteed exit; load errors offer Retry.
- An expired session redirects to `/login`.

## Desktop

- **Entry points** (`rv-gtk/src/chat.rs`): the header call button (shown only for writable rooms whose server passes `call_available`), the profile dialog's Call button (opens the DM, then starts), and the call card's Join (`RowEvent::JoinCall`). `Session::start_call` chains start and join. The card also has an info action (`RowEvent::CallInfo`): `call_window::info` shows the meeting link without the joiner's token (`call::meeting_link` drops the query), to copy or open in the browser.
- **Origin rule** in `rv-core/src/call.rs`, a port of `origin.ts`: `allowed` admits the call's origin, `about:blank`, `about:srcdoc` and `blob:` URLs of that origin. The authority is compared as written, userinfo included, so `https://server@evil` never passes for `https://server`.
- **Windows** (`rv-native/src/windows_call.rs`): WebView2 in its own Win32 window. `PermissionRequested` allows camera and microphone only for an allowed, non-`about:` URI and denies everything else; `NavigationStarting` cancels a disallowed navigation and, if the user initiated it, opens it in the browser; `NewWindowRequested` is always handled by sending http(s) to the browser.
- **macOS** (`rv-native/src/macos_call.rs` for GTK, `macos/Sources/RocketVibe/CallWindow.swift` for SwiftUI through `callAllowed` from `rv-ffi`): WKWebView in an `NSWindow`, media capture granted per origin with the same rule, other navigations cancelled and opened with `NSWorkspace`. Info.plist carries the camera and microphone usage strings.
- **Linux** (`rv-gtk/src/call_window.rs`): no embedded engine, because distributions build WebKitGTK without WebRTC (`RTCPeerConnection` absent on Fedora 44 and Arch). The call opens as an app window (`--app=<url>`) of the first Chromium-family browser found in `PATH` (Chromium, Chrome, Brave, Edge, Vivaldi), with a dedicated profile under the user data dir and `--class=rocket-vibe-call`. Because the browser ignores `--class` on Wayland and derives an app id from the URL, `name_window` writes hidden `.desktop` entries (`call::app_window_id`, read from Chromium's `set_app_id`) so the window gets the app's icon, and removes stale ones. No such browser: the default browser takes the call and a toast says so.
- Any failure to open the window falls back to the browser with the `call.in_browser` toast.

## kChat (kMeet)

kChat calls are kMeet meetings its server opens (`docs/MATTERMOST.md` §6.5): `POST /conferences {channel_id}` starts one and posts its `custom_call`, `POST /conferences/<id>/answer` joins one, both answering the meeting's `url` and a `jwt`. Both apps work as on Rocket.Chat: the room header's call button starts, the call card's Join answers the post's `conference_id`, and the call view opens `url?jwt=`. Since any member can post a `custom_call` with any URL, only an answer's URL on `https://kmeet.infomaniak.com` is opened, so the view's origin lock holds kMeet's origin. Mobile: `Provider.calls` (`providers/mattermost/kmeet.ts`), bound by `lib/providerCalls.ts`; desktop: `Session::start_call`, `join_call`, `call_link` (`mattermost::actions::start_conference`, `answer_conference`). An ended call is "📞 Call · duration".

## Ringing

A call someone starts in a two-person direct room rings on Rocket.Chat and kChat, done by the client from the call message ([decisions](../decisions.md)): Rocket.Chat's own ringing is a licensed direct-call type driven by a DDP method, kChat's lives in its own apps.

- **Trigger.** A `videoconf` message (kChat: a `custom_call` post still `calling`) seen live, not from a catch-up, younger than 40 s (`RING_MS`, Rocket.Chat's direct-call timeout), in a room whose other member is the caller. Each message rings once; a second call while one rings is not shown.
- **The record decides.** On Rocket.Chat, `video-conference.info` names the caller (`createdBy`: an unlicensed server posts the message as its provider's app user, not the caller), must be in the same room, not over, not joined by me; it is read again every 5 s (`RING_CHECK_MS`) and the ring stops when the call is over or I joined it from another device. My own call, from any of my devices, never rings. kChat's post is the record: its edit to ended or missed stops the ring.
- **Answers.** Accept stops the ring and opens the call as the call card's Join does. Decline sends `video-conference.cancel` (Rocket.Chat; its refusal is ignored) or `POST /conferences/<id>/decline` (kChat). Incoming prompts require an explicit answer: Escape, Back and backdrop clicks leave the prompt and ringtone active. Remote endings and account teardown close them without accepting or declining ([voice](voice.md), [parity](../parity.md)).
- **Mobile.** `lib/callRing.ts` (`CallRinger`, Node-pure, `lib/callRing.test.ts`), fed by `Provider.callSignal`: Rocket.Chat reads the room's new `lastMessage` in `rooms-changed` (the rooms not open are not streamed) and the open room's stream, Mattermost/kChat the translated `posted` and `post_edited`. `ui/callRing.tsx` (`CallRingHost` in `_layout`) shows `IncomingCallPrompt` (`ui/voice.tsx`) with the voice module's ringtone; on Rocket.Chat only while the app is in front, since the push rings it otherwise. `conferenceCheck` and `declineConference` are in `lib/call.ts`.
- **Mobile push.** Android: the FCM service rings a `videoconf` push of a direct room over the lock screen with the voice ring's `VoiceRinging` (ring id `call:<callId>`), after `chat.getMessage` (the block's `callId`), `rooms.info` (two members) and `video-conference.info`; Accept opens `rocketvibe://call-ring/<callId>?rid=&host=` (`app/call-ring/[callId].tsx`), Decline goes through `NativeCallReceiver` and a WorkManager job. The shared `modules/voice/android/.../IncomingCallActivity.kt` blocks legacy and predictive Back; remote cancellation still finishes it. Current-source API 36 emulator instrumentation passes hardware Back, outside taps, explicit Decline and remote cancellation. Physical lock-screen and signed-in React Native screen qualification remain pending. iOS: the Notification Service Extension only makes it a time-sensitive "Incoming call" alert (no CallKit, no Accept or Decline), never built yet. kChat sends no push to this app: it rings while the app runs. See [notifications](notifications.md).
- **Desktop.** `rv-core/src/call_ring.rs` (`Rings`, tested there) and `Session::ring` / `incoming_call` / `dismiss_call` / `decline_call`, fed by `stream-room-messages` (`__my_messages__`) and Mattermost's `posted` / `post_edited` (`MmSync::call_signal`), announced by `SessionEvent::CallRing`. GTK: `chat_call_ring.rs` shows `widgets::incoming_call_alert` over the ringtone, with `can_close(false)` blocking Escape and the app's backdrop hook. Explicit responses retire the active ring before `force_close`, so both buttons and notification actions work; remote endings and account teardown remove the ring first and close without answering. `window.rs::on_call_ring` adds, while the window is not active, a notification (`Notifier::show_call`: Accept and Decline on `org.freedesktop.Notifications`, a click opening the call card elsewhere). SwiftUI: `RingingCallPrompt` (`Voice.swift`) over `AppModel.ringingCall`, the ringtone and the dock bouncing, and a `call` notification category with Accept and Decline (`Notifier.showCall`).
- **Desktop, accounts not on screen.** A call ringing on a background account (`supervisor::Notice::Call`, and RocketVibe's voice rings as `Notice::Voice`) shows its own prompt naming the server (`voice_session.incoming_on`), with the ringtone (silent in that account's do not disturb) and, while the window is behind, the call notification. Accept switches to that account, then joins (`Session::join_call` and the call window, or `ChatPage::accept_voice_ring` / `AppModel.answer` for a voice ring); Decline acts on the background session without switching. A second call while one rings is not shown; opening the account hands its ring to its own prompt. GTK: `AppWindow::ring_background` uses the same non-dismissible incoming alert and preserves remote/account force closure. SwiftUI: `BackgroundCallPrompt` over `AppModel.backgroundCall` passes `dismissible:false` to its modal overlay, as do `IncomingCall` and `RingingCallPrompt`. The shared `ModalStack` guards the actual Cancel callback, so backdrop and Escape cannot hide a call but programmatic remote/account removal still works. Its Kit regression covers the guard; actual macOS screen qualification remains pending.

## Parity

Start, join, call card with Join, profile Call: both apps ([parity](../parity.md) §12). Meeting info with the token-free link: GTK (dialog), mobile (the call card's "Meeting information", an alert with Copy and Open in the browser) and SwiftUI (the call card's info button). Ringing in a direct room in all three; delivery while the app is closed only on mobile, by the Rocket.Chat push. The origin lock is the same rule on Android, Windows and macOS; Linux delegates to a browser.

## Sources

- apps/desktop/crates/rv-core/src/supervisor.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/mobile/lib/call.ts
- apps/mobile/lib/callRing.ts
- apps/mobile/ui/callRing.tsx
- apps/mobile/app/call-ring/[callId].tsx
- apps/mobile/plugins/with-fcm-deeplink.js
- apps/mobile/modules/voice/android/src/main/java/com/rocketvibe/voice/IncomingCallActivity.kt
- apps/mobile/plugins/ios-notification-service/NotificationService.swift
- apps/mobile/lib/origin.ts
- apps/mobile/lib/normalize.ts
- apps/mobile/app/call/[callId].tsx
- apps/mobile/app/profile.tsx
- apps/mobile/ui/roomHeader.tsx
- apps/mobile/ui/messageRow.tsx
- apps/mobile/app.json
- apps/desktop/crates/rv-core/src/call.rs
- apps/desktop/crates/rv-core/src/actions.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/call_ring.rs
- apps/desktop/crates/rv-gtk/src/chat_call_ring.rs
- apps/desktop/crates/rv-gtk/src/widgets.rs
- apps/desktop/crates/rv-gtk/src/notifier.rs
- apps/desktop/macos/Sources/RocketVibe/Voice.swift
- apps/desktop/macos/Sources/RocketVibe/Modals.swift
- apps/desktop/macos/Sources/RocketVibeKit/Modals.swift
- apps/desktop/macos/Tests/RocketVibeKitTests/ModalsTests.swift
- apps/desktop/macos/Sources/RocketVibeKit/AppModel.swift
- apps/desktop/crates/rv-gtk/src/call_window.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-native/src/windows_call.rs
- apps/desktop/crates/rv-native/src/macos_call.rs
- apps/desktop/macos/Sources/RocketVibe/CallWindow.swift
- apps/desktop/data/macos/Info.plist
- ROADMAP.md
