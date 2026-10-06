# ROADMAP: rocket-vibe

Third-party **Rocket.Chat** mobile client. Android first, **100% local** builds (`expo prebuild` + Gradle, no EAS), **native React Native primitives by default**, iOS opened up later without a rewrite.

Product goal: a client **faster and more reliable** than the official app, for personal use on a self-hosted server.

An execution document, not a specification. Calibrated for **one experienced part-time developer** (about 10-15 h/week); estimates are in calendar weeks at that pace.

---

## 1. Feasibility verdict

**The project is realistic, and the risk I thought was existential is gone.**

Hard point number one was push notifications for an unofficial client. It is **resolved positively**: Rocket.Chat migrated to the **FCM HTTP v1** API (PR #32208, present since 6.8, so in 8.6). A self-hosted server can push directly to **our own Firebase project**, with no self-hosted gateway and no Rocket.Chat Cloud. Since you are the server's sole administrator, the five required conditions are all under your control.

| Difficulty | Topics |
|---|---|
| **Easy** | Password login, room list (`subscriptions.get` + `rooms.get`), markdown rendering (the server provides the AST in `msg.md`), sending messages, local Gradle build chain. |
| **Medium** | DDP mini-client, reconnection and catch-up, performant inverted list, 2FA, two-step upload, offline-first. |
| **Under control** | Direct FCM push: chain known end to end, but **to be proven by a spike** before investing in the UI. The residual uncertainty is operational (waking a killed app, vendor skins), not architectural. |

### What your environment changes

Your machine is already exactly at the required level. The `@react-native-community/template@0.86.0` template requires `buildToolsVersion 36.0.0`, `compileSdk`/`targetSdk` 36, `minSdk` 24, `ndkVersion 27.1.12297006`, Gradle 9.3.1, and React Native pins `sourceCompatibility = JavaVersion.VERSION_17`. You have **build-tools 36.0.0, `platforms/android-36`, NDK 27.1.12297006 exactly, and Temurin 17.0.19**. **JDK 21 is not required**: JDK 17 runs Gradle 9.3.1 (which accepts Java 17→24) and satisfies `sourceCompatibility`.

Only two environment variables are missing. Nothing to install.

### The entry cost, plainly

A Firebase project (free), a service account with the *Firebase Cloud Messaging API Admin* role, admin access to the server (already there), and **a physical Android phone**. The emulator reproduces neither Doze nor process kill: it cannot validate push. It is the only indispensable hardware.

---

## 2. Locked decisions

Taken explicitly, they are not reopened along the way.

| Decision | Choice | Reason |
|---|---|---|
| v1 platform | **Android only** | No Mac. iOS in phase 7. |
| Build | **Local**: `expo prebuild` + `./gradlew` | Never EAS for Android. |
| Distribution | **Sideload `adb install`** | No Play Store, no review, no trademark risk. |
| DDP client | **Our own, minimal** | Zero license ambiguity, zero dependency on `core-typings`. |
| Server | **Self-hosted, admin** | Makes push feasible. Real target: `chat.barrut.me`, Rocket.Chat **8.5** (LTS). |
| Source of truth | **Local SQLite** | The UI is a projection, not a mirror of the network. |
| Actions / listening | **REST to act, DDP to listen** | DDP method calls are deprecated (8.0), removed in 9.0. |
| E2EE | **Out of scope, with careful degradation**; since superseded: both apps read and write encrypted rooms (§6.6) | `E2E_Enable=true` on the target server, but **1 encrypted room out of 25** (measured). Several weeks of crypto for 4% of usage: a bad trade. Degradation remains the behaviour as long as the key is not unlocked. |

### Why the in-house DDP client is smaller than announced

`@rocket.chat/ddp-client` is technically excellent (144 KB of JS, no Node module, injectable `WebSocket`, reconnection written), but its `package.json` carries **no `license` field** and the bundled `LICENSE` is the Rocket.Chat **Enterprise Edition** one, which forbids redistribution. The text does contain a clause putting back under MIT everything *"compiled into client-side JavaScript"*, which probably covers it, but "probably" is no foundation for a project.

And since **DDP method calls are deprecated** and REST is the official way to act, our client only needs: `connect`, `login` (resume, to authenticate the socket), `sub`, `unsub`, and routing of `added` / `changed` / `removed` / `ready` / `nosub` / `ping`. No `call`, no Meteor collection management. **We aim for 200 lines, not 300.** We write it from the (public) DDP specification and from observing the traffic; we do not copy the EE-licensed code.

Stream names and event keys are interface facts, already recorded: `stream-room-messages`, `stream-notify-user` (`<uid>/subscriptions-changed`, `/rooms-changed`, `/notification`, `/message`, `/userData`), `stream-notify-room` (`<rid>/user-activity`, `<rid>/deleteMessage`), `stream-notify-logged` (`user-status`, `roles-change`, `permissions-changed`), `stream-user-presence`.

> `@rocket.chat/message-parser` (explicitly MIT) remains an accepted dependency: the server already sends the markdown AST in `msg.md`, re-parsing it would be absurd.

---

## 3. Out of scope for v1

| Excluded | Reason |
|---|---|
| **E2EE** | Measured on the target server: `E2E_Enable=true`, but **a single encrypted room out of 25** (`p:laprivitude`). High cost (`react-native-quick-crypto` for RSA-OAEP, `expo-crypto` does no RSA) for 4% of usage. v1 **degrades cleanly**: padlock in the list, `lastMessage` preview hidden, `t='e2e'` messages replaced by a placeholder, composer disabled, generic notification. See §6.6. **Delivered since** in both apps (`apps/mobile/lib/e2e/`, `apps/desktop/crates/rv-core/src/e2e.rs`): messages and files, decrypted and encrypted; the degradation stays in place while the key is locked. |
| **Audio/video calls** | Not part of the motivation. This is what pulls in `@rocket.chat/media-signaling`; we avoid it. **Delivered since** through the server's Jitsi video conferencing, without `media-signaling`: `apps/mobile/app/call/[callId].tsx`, `apps/desktop/crates/rv-core/src/call.rs` (see the WebView exception, §4.2). On a RocketVibe server, **voice sessions** over a self-hosted LiveKit SFU replace it (2026-10-06): voice channels, calls in every room, ringing DMs (`brain/features/voice.md`). |
| **Server administration** | A consumer client, not an admin console. |
| **Apps / interactive UiKit blocks** | We render `attachments` and `md`, and cleanly ignore unknown `blocks`. |
| **Omnichannel / LiveChat** | Enterprise use case. |
| **OTR** | **Removed in 8.0.0.** Do not implement it. |
| **iOS at launch** | No Mac. Architecture kept platform-agnostic (phase 7). |
| **EAS Update (OTA)** | We reinstall the APK via `adb`. |

These are **accepted debts**, documented to prevent scope creep.

---

## 4. Target architecture

```
┌───────────────────────────────────────────────────────────────┐
│  UI: RN primitives (View/Text/Pressable/TextInput/Modal…)      │
│       + inverted FlashList + justified exceptions (§4.2)       │
├───────────────────────────────────────────────────────────────┤
│  Reactive projection, useCoalescedLiveQuery: the UI OBSERVES   │
├───────────────────────────────────────────────────────────────┤
│  SOURCE OF TRUTH: SQLite (expo-sqlite + Drizzle, WAL)          │
│  Server · Room · Subscription · Message · Outbox · Upload       │
│  · SyncState            (ONE database per server, account)     │
├────────────────────────────┬──────────────────────────────────┤
│  Sync engine               │  Secrets: expo-secure-store       │
│  (idempotent upserts,      │  (authToken/userId per host,      │
│   dedup by _id)            │   Android Keystore)               │
├──────────────┬─────────────┴──────────────────────────────────┤
│  REST fetch  │  In-house DDP mini-client (native RN WebSocket)  │
│  → ACT       │  → LISTEN: sub/unsub only                        │
├──────────────┴──────────────────────────────────────────────── ┤
│  Direct FCM push (expo-notifications): wakes the killed app     │
└────────────────────────────────────────────────────────────────┘
```

**Guiding principle**: the WebSocket and REST do **upserts** into SQLite; the UI is a **reactive projection**. The real-time stream is never kept in an in-memory store. This is the direct remedy to the documented complaints against the official app (piled-up subscriptions, duplicated messages, stuck sends).

### 4.1 Stack

| Layer | Choice | Justification |
|---|---|---|
| Runtime | **Expo SDK 57** (`expo@57.0.4`), RN 0.86, React 19.2, Hermes | The major of the `expo` package = the SDK number. **New Architecture mandatory and impossible to disable** since RN 0.82: `newArchEnabled=false` no longer has any effect. Do not count on it as a safety net. |
| Build | CNG: `android/` **gitignored**, everything goes through config plugins | In SDK 57 `expo prebuild` **wipes and regenerates by default** (`--no-clean` to avoid it): a manual edit of the folder would be lost. |
| Navigation | `expo-router` (57.x) on `react-native-screens` | Native deep link from the notification, typed routes, native stack, **native bottom sheets** via `presentation: 'formSheet'`. |
| Persistence | `expo-sqlite` + `drizzle-orm` | `useCoalescedLiveQuery` (`ui/liveQuery.ts`), a `useLiveQuery` from `drizzle-orm/expo-sqlite` that coalesces bursts of writes into a single refresh, with **`enableChangeListener: true`** mandatory when opening the database. |
| Key-value | ~~`react-native-mmkv` 4.x~~ not adopted | Planned for drafts and preferences. Drafts ended up living in SQLite (table `drafts`), the package is not installed. |
| Real time | **In-house DDP mini-client** | See §2. |
| List | **`@shopify/flash-list` 2.3.2, `inverted`** | See §6.3. |
| Markdown | `@rocket.chat/message-parser` + in-house rendering as nested `<Text>` | MIT. The AST comes from the server. |
| Push | `expo-notifications` 57.x, `getDevicePushTokenAsync()` | Native FCM token, **without the Expo Push service**. |
| Secrets | `expo-secure-store` | Android Keystore, key per host. |

Rejected: **`@notifee/react-native`** (archived on April 7, 2026, no New Architecture, incompatible with RN 0.86); **WatermelonDB** (last release July 2025, RN 0.86 support undocumented); `@rocket.chat/sdk` and `simpleddp` (dead). `@react-native-firebase/messaging@25.1.0` remains a **fallback** if `expo-notifications` disappoints on data-only messages in a killed app.

### 4.2 The "exceptions that make sense"

Your constraint is *"only native components as long as possible, except for an exception that makes sense"*. We classify each dependency, so as not to claim "two exceptions" while pulling in eight.

| Level | Dependencies | Status |
|---|---|---|
| **0: Pure RN primitives** | `View`, `Text`, `Pressable`, `ScrollView`, `TextInput`, `Modal`, `Image` | No justification required. |
| **1: Native bindings** (expose an OS capability, not a design system) | `react-native-screens` (native stack **and native bottom sheets**), `react-native-safe-area-context` (edge-to-edge enforced by targetSdk 36), `react-native-gesture-handler`, `expo-haptics` | Justified: each maps a native Android capability, none imposes a look. `expo-image` and `@react-native-menu/menu`, planned here, were not installed in the end. |
| **1b: Native SDK in a local module** | **`io.livekit:livekit-android`** inside `modules/voice` (Kotlin): the RocketVibe voice engine (WebRTC audio, LiveKit signalling). Not `react-native-webrtc`, a fragile bet under the New Architecture; no JS media, no view. About +6.5 MB compressed per ABI. Its screen-capture service is removed from the manifest. | Justified (2026-10-06): voice needs WebRTC, and this is the platform SDK of the chosen SFU. |
| **2: Accepted exceptions** | **`@shopify/flash-list`**: native view recycling, indispensable for thousands of messages. **`react-native-keyboard-controller`**: `KeyboardAvoidingView` is mediocre on Android; this lib subscribes to `WindowInsetsAnimationCallback` for a composer synchronised frame by frame. **`@rocket.chat/message-parser`**: a pure JS parser, not UI. **`react-native-webview`**: the Jitsi call screen, and it alone; see the box below. | Four exceptions, each motivated. |

**Bottom sheets are native, no dependency to add.** `react-native-screens` 4.25 ships an Android implementation built on Material's `BottomSheetBehavior` (`android/src/main/java/com/swmansion/rnscreens/bottomsheet/`, dependency `com.google.android.material:material:1.13.0`), and the native `UISheetPresentationController` on iOS. `expo-router` exposes it directly:

```tsx
<Stack.Screen
  name="message-actions"
  options={{
    presentation: 'formSheet',
    sheetAllowedDetents: [0.4, 0.9],
    sheetGrabberVisible: true,
    sheetCornerRadius: 16,
    sheetInitialDetentIndex: 0,
    sheetLargestUndimmedDetentIndex: 0,
  }}
/>
```

This is what we will use for the action sheet on a message, the emoji picker and the attachment chooser.

**Firm bans**: any UI kit (NativeBase, Tamagui, gluestack, RN Paper), any **WebView** outside the bounded exception below, `react-native-markdown-display`, `react-native-render-html`, and **`@gorhom/bottom-sheet`**: it is a JS/Reanimated reimplementation of a component the platform already provides.

> **The WebView exception: the call screen, and nothing else** (recorded in workstream 16, delivered
> on 2026-07-12, `61fc7d4`). Jitsi video conferencing is a **web app**: the native alternative,
> `@jitsi/react-native-sdk`, targets RN ~0.79 and bundles `react-native-webrtc`, a fragile New
> Architecture bet against our RN 0.86. `apps/mobile/app/call/[callId].tsx` therefore loads the URL returned
> by `video-conference.join` (JWT included) in a full-screen WebView. The bounds, and they are not
> negotiable: **a single route**; **origin locked** to the one the server designated
> (`originWhitelist` + `onShouldStartLoadWithRequest`, primitives from `apps/mobile/lib/origin.ts`),
> because the app holds the camera and microphone during the call and Android cannot arbitrate those
> permissions per origin, so navigation is the only lock. Everywhere else, the ban holds:
> inline playback of video links, for example, stays a native card (`apps/mobile/ui/embedCard.tsx`).
>
> **On desktop, the same exception, with the same bounds** (2026-09-30): the call opens in a
> window of the app and nowhere else, WebView2 on Windows (`apps/desktop/crates/rv-native/src/windows_call.rs`),
> WKWebView on macOS (`macos_call.rs`, and `CallWindow.swift` in the SwiftUI app). The origin is
> locked by the same rule, written once in Rust (`apps/desktop/crates/rv-core/src/call.rs`,
> a port of `origin.ts`): navigation outside the origin is cancelled and handed to the browser, and
> this time the camera and microphone are also arbitrated per origin, which WebView2 and WKWebView
> allow. On Linux, no embedded engine: distributions build WebKitGTK without WebRTC
> (checked on Fedora 44 and Arch, `RTCPeerConnection` missing), so the call opens an application
> window of a Chromium browser (`--app`) when there is one, otherwise the browser.
>
> **Desktop has a second use, with no mobile equivalent**: YouTube, Dailymotion and Vimeo cards
> play inside the card, through an embedded web engine (WebKitGTK on Linux, WebView2 on Windows,
> WKWebView on macOS: `apps/desktop/crates/rv-gtk/src/player.rs`, `rv-native/src/*_player.rs`,
> `Player.swift`). The main frame stays on a page of the app (`rv-core/src/player.rs`) that
> contains the provider's embed; a click that leaves the player goes to the browser.

> **Cross-cutting trap, and it is unavoidable**: `react-native-reanimated` increases RAM by 25 to 30% since RN 0.85 (a Hermes change), even when unused. Checked after installation: **`expo-router@57.0.4` depends on it directly**, as well as on `react-native-worklets`. No template choice avoids it. Doing without it would mean dropping `expo-router` for bare `react-navigation`, probably not worth it. To be watched during profiling rather than fought.

---

## 5. The phases

Order: **de-risk first, then deliver value fast**. Each phase produces an APK installable via `adb`.

### Phase 0: Foundation: local build, dev server, clearing the uncertainties (*1 to 2 wk*)

**Goal**: prove the Android build chain end to end and check the points the research left open.

**Deliverables**
- `JAVA_HOME`, `ANDROID_HOME`, `PATH` exported; `java -version` → 17.0.19; `adb devices` OK.
- `docker compose`: Rocket.Chat 8.5.1 (the target server's version, not 8.6) + MongoDB as **replica set `rs0`** (mandatory, otherwise RC refuses to start). **`ROOT_URL` on the LAN IP**, not `10.0.2.2`: phase 1 requires a physical phone, and `ROOT_URL` drives the push payloads and deep links. For the emulator, `adb reverse tcp:3000 tcp:3000`.
- Admin account, Personal Access Token, test data (`users.create`, `channels.create`, `im.create`, `chat.postMessage`, a thread).
- Expo SDK 57 app + `expo-dev-client` + `expo-router` + strict TypeScript; `npx expo prebuild` then `./gradlew app:assembleDebug` → APK on the `duogo_test` AVD; a "server" screen showing `GET /api/v1/info` and `settings.public`.
- **Uncertainty sheet** (§7) filled in.

**Done when**: a home-built APK installed by `adb` shows real data from the local server, and the uncertainty sheet is filled in.

**Risks**: Mongo without a replica set → RC does not start. Misaligned `ROOT_URL` → login and CORS broken. Cleartext HTTP blocked by default on Android → `expo-build-properties` with `usesCleartextTraffic` **scoped to dev**.

---

### Phase 1: THROWAWAY SPIKE: third-party push (kill gate) (*about 1 wk*)

**Goal**: prove in a **binary** way that a self-compiled APK receives a notification **when the app is killed**. Throwaway code, zero UI.

**Protocol** (the order matters, and two traps make the test falsely negative):

1. Firebase project, Android app whose `package_name` **is exactly** the APK's `applicationId` (the GMS Gradle plugin fails otherwise: *"No matching client found for package name"*). `google-services.json` at the root, declared in `app.json` via `expo.android.googleServicesFile`.
2. Firebase service account, role **Firebase Cloud Messaging API Admin**, *Firebase Cloud Messaging API (V1)* API enabled in Google Cloud.
3. `npx expo prebuild --clean` → `./gradlew assembleDebug` → `adb install`. **First checkpoint**: the build passes (validates `com.google.gms:google-services` × Gradle 9.3.1).
4. In the app: `setNotificationChannelAsync('default', { importance: HIGH })` **before** `requestPermissionsAsync()`, otherwise the `POST_NOTIFICATIONS` prompt (Android 13+) never appears. Then `getDevicePushTokenAsync()`, log `.data`.
5. Server, Admin → Push, **then restart the workspace**: `Push_enable_gateway = false`, `Push_UseLegacy = false`, paste the service account JSON into `Push_google_api_credentials`.
6. Register the token: `POST /api/v1/push.token`, body `{ type: 'gcm', value: <token>, appName: <applicationId> }`, headers `X-Auth-Token` / `X-User-Id`. *(`gcm` is legacy naming: the value really is an FCM v1 token.)*
7. Trigger: admin button **"Send a test push to my user"**, then a **real direct message** from another account.

> ⚠️ **Trap no. 1: the false failure.** Rocket.Chat pushes **only to offline users**, and by default **only for a DM or a mention**. An ordinary channel message, or a test account left "online", triggers **no** push, whatever the configuration. A naive spike would wrongly conclude failure on the gate that decides the project.
>
> ⚠️ **Trap no. 2: the `SENDER_ID_MISMATCH`.** The app's token and the server's service account must belong to the **same Firebase project**. Otherwise FCM returns 403 and the server **silently deletes the token**. It is the most frequent failure.

**Done when (binary)**: a **visible** notification arrives **twice in a row**, app **swipe-killed**, on a **physical device**, within a few seconds. The tap opens the right route.

**What the spike settles**: the local prebuild/build chain, the `SENDER_ID_MISMATCH`, the behaviour of the double `notification` + `data` block, and the reality of waking a killed app.

**Plan B** if the failure only occurs on an OEM device after battery settings: the verdict stays "FCM viable", and we document the per-device settings (Autostart, battery optimisation disabled). See §6.1 for the real plans B and C.

---

### Phase 2: Core: login (2FA included), rooms, real time (*6 to 9 wk*)

**Goal**: the first real value. **An APK useful day to day.**

2FA is here, not later: on a server where `Accounts_TwoFactorAuthentication_Enabled` is on, a "simple login" does not even let you authenticate.

**Deliverables**
- Discovery: `GET /api/v1/settings.public` and `settings.oauth` (unauthenticated) to adapt the UI.
- Login `POST /api/v1/login`; `authToken` + `userId` in `expo-secure-store`, key per host.
- **2FA**: intercept `errorType = totp-required`, read `details.method` / `details.availableMethods`, replay the **same** request with `x-2fa-code` and `x-2fa-method`. For the `password` method, send the **SHA-256** of the password, never the plain text. `POST /api/v1/users.2fa.sendEmailCode` for the email code.
- **DDP mini-client**: `connect` → `login {resume}` → ping/pong → `sub` / `unsub` → routing of `added` / `changed` / `removed` (payload in `fields.args[0]`, key in `fields.eventName`, EJSON dates `{"$date": epochMs}`) → **SQLite upserts**.
- **Permanent debug screen** from now on: active subscriptions, ping/pong RTT, detected duplicates, sync gaps. It will not be thrown away.
- **Complete Drizzle schema**: `Server`, `Room`, `Subscription` (joined by `rid`), `Message` (index `(rid, ts)`, `tmid`), `Outbox` (`pending`/`sent`/`failed`), `Upload`, `SyncState`. **One database per host.** (Delivered: one database per server, account pair.)
- Room list: `subscriptions.get` + `rooms.get` merged by `rid`; subscription to `stream-notify-user/<uid>/subscriptions-changed` and `/rooms-changed`; `fname`, `lastMessage` preview, `unread` badge, sorting by activity.
- Room screen: initial history (`channels.history` / `groups.history` / `im.history` depending on `t`); `FlashList` `inverted`; in-house markdown rendering of `msg.md` (falling back to `parse()` if absent); system messages (`t = uj/ul/rm/r/...`); `sub` on `stream-room-messages/<rid>` on open and **`unsub` on close**; **dedup by `_id`**.
- Sending via the **Outbox**: 24-hex `_id` generated client-side **before** display → `pending` insert → `POST /api/v1/chat.sendMessage` → reconciliation when the stream echoes it back. The server deduplicates on `_id`, so a resend after a crash creates no duplicate.

**Done when**: on the AVD **and** on a physical device: I log in (2FA included), I see my rooms with unread counts, I open a room, I read the history, I receive live, I send with immediate display. Kill the app with a `pending` message → resent, no duplicate.

**Risks**: piled-up subscriptions if an `unsub` is forgotten. `md` absent on old messages → the `parse()` fallback is mandatory, not optional. Recursive markdown rendering covering every AST token is a sub-workstream in its own right; it is the main reason for the wide range.

---

### Phase 3: Resilience, catch-up, multi-server, starting a conversation (*3 to 4 wk*)

**Deliverables**
- Reconnection: exponential backoff with jitter (1 s → 30 s). On **every new socket**: reconnection, re-login, **re-subscription of all streams**. A subscription never survives a reconnection.
- Catch-up driven by `SyncState`, on `AppState 'active'` and on reconnection. **Mind the cost**: `chat.syncMessages` handles **one room at a time** and REST is rate-limited. Do not loop over all rooms: a single `subscriptions.get?updatedSince=` + `rooms.get?updatedSince=` for the bulk, and `syncMessages` **only** on open or recently active rooms.
- Token lifecycle: 401 → `resume` attempt → otherwise back to login. `POST /api/v1/logout`. Delivered differently: a 401 with a Rocket.Chat envelope on a non-anonymous call clears the session and returns to the login screen, with no `resume` attempt (`apps/mobile/lib/rest.ts`, `ui/session.tsx`).
- Multi-server: `Server` registry, tokens isolated per host, SQLite database isolated per (server, account) pair.
- **Starting a conversation**: `GET /api/v1/spotlight?query=` then `POST /api/v1/im.create` (new DM) or `POST /api/v1/channels.join`. Without it the app only lists what exists, yet "channels" and "private messages" imply opening new ones.

**Done when (torture test)**: cut Wi-Fi for 30 s ten times, switch background/foreground twenty times, send fifty rapid messages → **local state == server state**: zero duplicates, zero missing messages, zero ghost subscriptions, measured on the debug screen.

---

### Phase 4: Integrated push (*about 2 wk*)

Builds on the spike. Token registration on login, unregistration on logout. Clean WebSocket close on `AppState 'background'`, reopening and resync on `'active'`. Notification handler → `expo-router` deep link to the room. Android notification channels, badge consistent with `subscription.unread`.

**Done when**: app closed, a DM notifies me; the tap opens the right room and resyncs; logout removes the token.

---

### Phase 5: Uploading documents, images, voice messages (*2 to 3 wk*)

**Careful, the API changed**: `POST /api/v1/rooms.upload` was **removed in 8.0.0**, not deprecated, removed. The flow has two steps.

- `POST /api/v1/rooms.media/:rid` then `POST /api/v1/rooms.mediaConfirm/:rid/:fileId`. **`rooms.media` alone posts no message**: forgetting the `mediaConfirm` leaves an orphan file.
- Android upload: `expo-file-system/legacy` `createUploadTask` in `MULTIPART`, `fieldName: 'file'`, progress via `totalBytesSent`. *(The `legacy` API is deprecated; upload parity comes back in the new `File` API, a migration to plan.)* Integrated into the `Outbox` via the `Upload` table.
- Picking: `expo-document-picker`, `expo-image-picker`; compression with `expo-image-manipulator`; validation of `FileUpload_MaxFileSize` and `FileUpload_MediaTypeWhiteList` read from `settings.public` **before** the upload.
- Voice messages: `expo-audio`, `.m4a` AAC, `mimeType: audio/mp4`.
- Protected reads: if `FileUpload_ProtectFiles`, add `rc_uid` / `rc_token` as query on `/file-upload/:id/:name`; `expo-image` for inline display.

---

### Phase 6: Offline-first, actions, presence, search (*4 to 6 wk*)

Unread (`subscriptions.read`, "new messages" bar via `ls`). Message actions (`chat.update`, `chat.delete`, `chat.react`, `chat.pinMessage`) with the **display decision centralised in a pure function** `(message, currentUser, subscription.roles, permissions, settings)`: the edit window comes from the **settings** (`Message_AllowEditing_BlockEditInMinutes`), not from the permissions. Threads (`tmid`, `tcount`) and discussions. Presence via `users.presence?from=` and `stream-user-presence`, with **graceful degradation**: `Presence_broadcast_disabled` turns itself on beyond about 200 connections, the UI must never depend on it. Search with `chat.search`. Typing indicator via `stream-notify-room/<rid>/user-activity`, **not** `/typing`, which is deprecated. Local drafts in MMKV. Maestro E2E suite.

---

### Phase 7: iOS, later (*2 to 3 wk on macOS*)

iOS `prebuild` from the same config plugins. APNs push with a **Notification Service Extension**. Keychain access groups. Build on a Mac, `expo prebuild --platform ios` then Xcode, never EAS (`docs/PUSH.md`). Apple Developer account at $99/year.

### Schedule

| Phase | Content | Estimate |
|---|---|---|
| 0 | Foundation + server + uncertainties | 1-2 wk |
| 1 | **Push spike (kill gate)** | about 1 wk |
| 2 | **Core: first useful APK** | 6-9 wk |
| 3 | Resilience + multi-server | 3-4 wk |
| 4 | Integrated push | about 2 wk |
| 5 | Upload | 2-3 wk |
| 6 | Offline-first + polish | 4-6 wk |
| 7 | iOS | 2-3 wk |

**First truly useful APK**: end of phase 2, i.e. **8 to 12 weeks**. **Full daily driver**: end of phase 6, i.e. **19 to 27 weeks** (5 to 7 months part time).

---

## 6. The hard points

### 6.1 FCM push for a third-party client

**Problem.** The public gateway `gateway.rocket.chat` requires registration on Rocket.Chat Cloud and only relays to the official app-ids. The docs say so: *"When you white-label the mobile app, the default push notification gateway is unavailable."*

**Chosen solution.** **Direct** FCM push, five conditions: `Push_UseLegacy=false` (default), `Push_enable_gateway=false`, a **service account JSON** in `Push_google_api_credentials` (not an API key), **the same Firebase project on both sides**, and **Google Play Services present on the device** (no installation through the Play Store is required: an `adb install` APK receives push).

**Plan B: Foreground Service + persistent WebSocket.** Feasible in Expo via a config plugin, but **bad**: since Android 15 the `dataSync` type is **capped at 6 cumulative hours per 24 h**, then `Service.onTimeout()`, and starting it from `BOOT_COMPLETED` is forbidden. No FGS type is legitimate for a permanent WebSocket. Add a permanent non-dismissible notification and the battery. Reserve it for de-Googled ROMs.

**Plan C: local notifications triggered by the WebSocket.** **Structurally insufficient**: the JS socket only exists while the process runs. App killed, no notification possible. Covers the foreground only.

**The real day-to-day reliability factor**, once push is wired, is not the code: it is the vendor skins (MIUI first). On each device you must enable Autostart and disable battery optimisation. You are admin of the server, not of the phones.

### 6.2 DDP mini-client, reconnection, catch-up

**Problem.** Subscriptions do not survive a reconnection, and forgetting an `unsub` blows up the number of subscriptions and duplicates.

**Solution.** In-house listen-only client (§2). Backoff with jitter. On every socket: re-connect, re-login, **full re-sub**. Minimal subscriptions: two to four on `stream-notify-user`, plus `stream-room-messages/<rid>` **only for the open room** (delivered: mobile also keeps the last 3 rooms left subscribed, as an LRU, `apps/mobile/ui/hotRooms.ts`). REST catch-up driven by `SyncState`. Torture test as an acceptance criterion.

**Plan B.** Adopt `@rocket.chat/ddp-client`, accepting its weight and its licensing fuzziness. As a last resort, pure REST polling: degraded but functional.

### 6.3 Inverted message list

`@shopify/flash-list` **2.3.2** in `inverted`. The prop had been removed early in v2 (mid-2025) then **reintroduced in 2.3.0** (March 2026): I checked it in `FlashListProps.d.ts` of the published package, and field experience confirms it. We rely on `maintainVisibleContentPosition`, which is properly implemented natively on Android in RN 0.86 (`MaintainVisibleScrollPositionHelper.kt` is present in `ReactAndroid`).

Keyset pagination (`WHERE rid = ? ORDER BY ts DESC`), and **debouncing of incoming messages**: head insertions closer together than ~200 ms make the scroll jump.

**Plan B**: `@legendapp/list` v3.

### 6.4 Optimistic UI and send queue

24-hex `_id` generated **before** display (`expo-crypto`) → `pending` insert → `chat.sendMessage` → reconciliation when the same `_id` comes back through the stream. The `Outbox` is a first-class table, with automatic retry when the network returns and an actionable `failed` status. **Kill-and-relaunch** test → zero duplicates. This is the remedy to the official app's "stuck messages".

### 6.5 2FA

The mechanism is **generic and its name is misleading**: `errorType = totp-required` also covers `email` and `password`. Always read `details.method` and `details.availableMethods`. Replay with `x-2fa-code` / `x-2fa-method`. For `password`, send `digestStringAsync(SHA256, password)`. Back off on 429s: the login rate limiter is more aggressive than generic REST, never loop on `sendEmailCode`.

### 6.6 E2EE: one room out of twenty-five

**The measured fact.** On `chat.barrut.me`: `E2E_Enable = true`, `E2E_Allow_Unencrypted_Messages = false`, `E2E_Enabled_Default_PrivateRooms = false`, and **a single encrypted room out of 25** (`p:laprivitude`). New private rooms are therefore not encrypted by default.

**The server's behaviour.** It **actively rejects** a plain-text message in an `encrypted` room (`error-not-allowed`), a guard also applied to `chat.sendMessage`. Good news: a client without E2EE **cannot corrupt** an encrypted room, it is simply unable to post in it. A non-decrypting client sees `t='e2e'` and an opaque base64 `msg`.

**The chosen solution: degrade cleanly, in three places.** This has remained the behaviour of an encrypted room as long as the key is not unlocked; plan B was delivered on top.

1. **Room list**: padlock on `room.encrypted`, and **`lastMessage` preview hidden**: it contains ciphertext. Never render the blob.
2. **Room screen**: `t === 'e2e'` messages become "🔒 Message chiffré, non pris en charge" ("Encrypted message, not supported"). The composer is disabled with the explanation, since the server would refuse the send anyway.
3. **Notifications**: `Push_show_message = true` on this server, so the body of a notification from an encrypted room is ciphertext. Replace it with a generic text client-side.

That room can be read from the web or the official app. Cost of the degradation: less than a day.

**Plan B: implement it (optional step 10, off the critical path).** RSA-OAEP 2048/SHA-256 for the user key pair, **AES-GCM 256** for new messages (`rc.v2.aes-sha2`, and not AES-CBC, which is kept only for `rc.v1` history), PBKDF2-SHA256, the iteration count read from the private key envelope (`iterations`). `expo-crypto` **does no RSA**: it would take `react-native-quick-crypto` (New-Arch only, via `react-native-nitro-modules`). Count several weeks, and the real risk of making messages permanently unreadable.

**Delivered: plan B, in both apps** (`apps/mobile/lib/e2e/` via `react-native-quick-crypto`, `apps/desktop/crates/rv-core/src/e2e.rs`). Unlocking with the E2E password, key kept on the device, messages and files decrypted and encrypted. No creation of encrypted rooms, no creation of key pairs.

**Plan C: disable encryption on that room.** You own it: switching it to plain text makes everything accessible, at the cost of encryption for all clients.

---

## 7. Uncertainties to clear in phase 0

What the research did **not** settle. Each one is a task, not an assumption.

| # | Uncertainty | How to clear it |
|---|---|---|
| 1 | Does `POST /api/v1/login` in 8.6 still accept a `code` field in the body, or does it require the `x-2fa-*` headers? | A `curl` against the dev server with 2FA enabled. |
| 2 | Do private streams require an authenticated DDP session (`login {resume}`) on top of REST auth? | Subscribe to `stream-notify-user` without a DDP login and observe. |
| 3 | Expected value of `appName` in `push.token`, and existence of a `DELETE /api/v1/push.token`. | Read `apps/meteor/app/api/server` at tag `8.6.0`. *(The dedicated research folder failed.)* |
| 4 | Does `expo prebuild` actually add `POST_NOTIFICATIONS` to the manifest? | `grep POST_NOTIFICATIONS android/app/src/main/AndroidManifest.xml` after prebuild. |
| 5 | Compatibility of `com.google.gms:google-services` × Gradle 9.3.1. | The first local build is the proof. |
| 6 | Double display of `notification` + `data` on Android. | Capture the real payload during the spike. |
| 7 | Exact response schema of `rooms.mediaConfirm`. | A test upload. |
| 8 | Exact RN 0.86 compatibility of `react-native-mmkv@4.3.2` and `react-native-keyboard-controller` (1.21.9 installed). | Each lib's compatibility table, then a build. |

---

## 8. First batch of work

```sh
# 1. Environment (put in ~/.zshrc)
export JAVA_HOME=/home/guillaume/android-build/jdk-17.0.19+10
export ANDROID_HOME=/home/guillaume/Android/Sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

# 2. Check
java -version          # 17.0.19
adb devices
emulator -list-avds    # duogo_test
```

3. **Dev server**: `docker compose` with Rocket.Chat 8.5.1 and MongoDB as replica set `rs0` (`rs.initiate()`). `ROOT_URL` on the machine's **LAN IP**, not `10.0.2.2`. Create the admin, generate a Personal Access Token, seed a few channels and a DM.

4. **Expo skeleton**: `npx create-expo-app@latest rocket-vibe-app --template default`, then `expo-dev-client`, `expo-router`, strict TypeScript, `expo-sqlite` + `drizzle-orm` (with `enableChangeListener: true`), `expo-secure-store`. Gitignore `android/` and `ios/`.

5. **First local build**: `npx expo prebuild --platform android` then `./gradlew app:assembleDebug` then `adb install`. A single screen showing the dev server's `GET /api/v1/info`. **This is the first verifiable milestone.**

6. **DDP spike** (one evening, throwaway): open a `WebSocket` on `ws://<IP_LAN>:3000/websocket`, send `{"msg":"connect","version":"1","support":["1"]}`, then `login` with the resume token, then `sub` on `stream-room-messages`. Post a message from the web and check that it arrives. **This answers uncertainty no. 2 at the same time.**

7. **Push spike** (phase 1): do not start it before points 3 to 5 are green.

---

## 9. Main sources

- Server push: `apps/meteor/app/push/server/fcm.ts` and `apps/meteor/server/settings/push.ts` (`RocketChat/Rocket.Chat` repository), PR #32208 (FCM HTTP v1 migration), <https://developer.rocket.chat/docs/configuring-push-notifications>
- Client push: <https://docs.expo.dev/versions/latest/sdk/notifications/>, <https://firebase.google.com/docs/android/android-play-services>
- Upload: <https://developer.rocket.chat/apidocs/upload-media-files-to-a-room>, issue #34956
- Deprecations: <https://docs.rocket.chat/docs/deprecated-and-phasing-out-features>, release 8.0.0
- E2EE: `apps/meteor/app/lib/server/methods/sendMessage.ts` at tag `8.6.0`
- New Architecture: <https://docs.expo.dev/guides/new-architecture/>
- CNG: <https://docs.expo.dev/workflow/continuous-native-generation/>
- Android 15+ foreground services: <https://developer.android.com/develop/background-work/services/fgs/service-types>

---

*Facts checked in July 2026. Rocket.Chat 8.6.0, Expo SDK 57, React Native 0.86.*
