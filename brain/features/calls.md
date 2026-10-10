# Calls

This page is the **Rocket.Chat** path. A RocketVibe server has no video conference since
2026-10-06: its rooms call through voice sessions, see [voice](voice.md).

Video calls use the conference provider configured on the Rocket.Chat server (Jitsi on the target server). Both apps only start and join calls over REST and render the provider's web page in an embedded browser locked to the call's origin: a full-screen WebView on mobile (the app's single WebView exception) and a dedicated call window on desktop.

## Server contract

- `POST video-conference.start {roomId}` creates the conference **and** posts the call message (`t: 'videoconf'`) in the room, returning `data.callId`. That message is how the other members learn of the call: mobile ringing (`VideoConf_Mobile_Ringing`) is off on the target server.
- `POST video-conference.join {callId[, state: {cam, mic}]}` returns the provider URL to open, with the Jitsi JWT in it when the server requires one.
- `GET video-conference.capabilities` is the availability probe: `400 no-videoconf-provider-app` when no provider is installed (the local Docker server), and the call buttons stay hidden.
- `GET video-conference.info {callId}` (GTK and mobile) gives the call's own URL, used for the shareable link, cut before its query and fragment so the joiner's `jwt` never leaves (GTK `call::meeting_link`, mobile `withoutToken` in `lib/call.ts`).
- No DDP method is involved: REST to act, as everywhere ([../architecture/rocket-chat.md](../architecture/rocket-chat.md)).

**Availability probe caching.** Both apps remember the answer per server for the session: a definite "no" (a 4xx other than 401) sticks, a network failure (`status 0`) or a refused token (401) is not remembered, so a later room opening retries. When unsure the button is hidden: a missing button beats one that fails on tap. Mobile: `probeCallAvailable` / `memoizedCallAvailable` in `lib/call.ts`, cleared by `forgetCallAvailability` at session end (the store is module-level, so it was per process before). Desktop: `Session::call_available`.

## Why a WebView

ROADMAP §4.2 forbids WebViews in the mobile app, with one bounded exception: the call screen. Jitsi is a web app; its native SDK (`@jitsi/react-native-sdk`) targets React Native ~0.79 and bundles `react-native-webrtc`, a fragile bet under the New Architecture on RN 0.86. The bounds are non-negotiable: **one route**, and **navigation locked to the origin the server named**. The reason for the lock: while in a call the app holds camera and microphone, and on Android `react-native-webview` grants a page's `getUserMedia` without a prompt whatever its origin, so navigation is the only lever. Video links elsewhere stay native cards. See [../decisions.md](../decisions.md).

The desktop applies the same exception with the same bounds (2026-09-30), and there camera and microphone are also granted per origin.

## Mobile

- **Entry points.** The room header's 📞 button (`ui/roomHeader.tsx`) and the profile sheet's Call button (`app/profile.tsx`, which opens or creates the DM first) call `startConference`, then push `/call/[callId]` with the room name as title. A call message renders as `CallCard` (`ui/messageRow.tsx`) with a Join button when its `callId` was extracted from the message block (`callId`, `lib/normalize.ts`); older messages without it show only the label.
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

## Parity

Start, join, call card with Join, profile Call: both apps ([parity](../parity.md) §12). Meeting info with the token-free link: GTK (dialog), mobile (the call card's "Meeting information", an alert with Copy and Open in the browser) and SwiftUI (the call card's info button). The origin lock is the same rule on Android, Windows and macOS; Linux delegates to a browser.

## Sources

- apps/mobile/lib/call.ts
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
- apps/desktop/crates/rv-gtk/src/call_window.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-native/src/windows_call.rs
- apps/desktop/crates/rv-native/src/macos_call.rs
- apps/desktop/macos/Sources/RocketVibe/CallWindow.swift
- apps/desktop/data/macos/Info.plist
- ROADMAP.md
