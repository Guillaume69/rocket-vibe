# WhatsApp on Android: design

Status: design, nothing built yet (2026-10-12). The desktop account it follows is described in `brain/features/whatsapp.md`; the protocol facts and the verification record are in `docs/WHATSAPP_HANDOFF.md`. This page decides how the Android app gets the same account, and in what order.

## Goal

A personal WhatsApp account linked to the phone as a WhatsApp linked device, living in the app like any other account (rail, room list, timeline, composer, notifications), with the desktop's first-release feature set: names, photos, reactions, quoted replies, edits and deletions, unread counts shared with the primary phone, delivered/read state, new conversations, photos, voice notes, videos and documents both ways, typing, notifications with reply and react, unlink. Calls stay out, as on desktop (the DMA interoperability route, `brain/decisions.md`).

## One engine, three layers

The desktop's Go engine (whatsmeow from the fork `boubou666/whatsmeow`, the sealed in-memory SQLite vault, the event queue, the frame vocabulary) is reused as is. Nothing about WhatsApp is reimplemented in Kotlin or TypeScript.

1. **Go, `gomobile bind`.** The engine is `package main` today (`apps/desktop/whatsapp/engine/engine.go`), with `open` and `handle` unexported. It splits into:
   - `engine/` (done): everything but the transport, exporting only gomobile-legal types (`engine/api.go`): `Open(path string, key []byte, sink Sink) (*Device, error)`, `(*Device).Connect()`, `Handle(line string) bool`, `Cancel()`, `Close()`, and `Sink interface { Frame(frame string) }`. gomobile binds this package directly into the AAR;
   - the module root: the desktop helper (`main.go`), unchanged on the wire (JSON lines over stdin/stdout).
   The frames stay JSON strings, so the mobile side parses exactly the vocabulary `rv-core/src/whatsapp.rs` parses (`message`, `names`, `avatar`, `reaction`, `reload`, `chat`, `account`, `found`, `file`, `typing`, `qr`, `pairing_code`, `status`, `error`, `sent`) and skips unknown ones. The `replay` command (done) re-emits the cached projection after a `reload` frame, for a JS side that attaches to an engine already running. Once two apps depend on it, the module moves out of `apps/desktop/` to a shared root directory, like `crates/`.
2. **Kotlin, `modules/whatsapp/`** (local Expo module, autolinked like `modules/voice/`):
   - `WhatsAppEngines`, a process singleton holding one engine per state id. The engine takes an exclusive file lock (`engine.go` `flock`), so JS and the service must share this one instance. It outlives JS reloads, account switches and `SyncProvider` cleanup; only unlink, logout and the user's "stop" end it.
   - `WhatsAppService`, a foreground service that keeps the engines alive in the background (see Background).
   - The module API to JS: `start(stateId)`, `handle(stateId, command)`, `stop(stateId)`, and an `Events("frame")` event carrying `{stateId, json}`, the pattern of `VoiceModule.kt`.
   - Notifications posted from Kotlin, from frames, while JS is not attached (see Notifications).
3. **TypeScript, `providers/whatsapp/`** on the template of `providers/rocketvibe/index.ts`: the provider owns its runner, fakes the `Listener` (state from the engine's `status`), has no-op catch-ups and `reconcile`, and a store that writes the shared tables from frames. `ProviderKind` gains `whatsapp` (`lib/provider.ts`), with a clause in `providers/index.ts`, `lib/sessionTransport.ts` (resume is a no-op, logout sends `logout`), `ui/serverRail.tsx` (unread from the engine's `chat` frames) and `ui/sync.tsx` (a branch beside the RocketVibe one).

## Identity and storage

- Account: `baseUrl = whatsapp://<state id>`, `userId` = own JID, `kind = whatsapp`, `authToken = ""`, the same shape as the desktop's `account_info`. It is stored in SecureStore like every session and listed in `known-servers`.
- `normalizeProviderKind` must stop mapping an unknown kind to `rocketchat` (and `parseSession` must skip it): an older build that met a `whatsapp://` session would otherwise talk Rocket.Chat REST to it.
- State: `<filesDir>/whatsapp/<state id>/state.bin`, its media beside it (`media.go` writes under the state directory).
- Vault key: 32 random bytes generated in Kotlin, wrapped by an AndroidKeyStore AES-GCM key (precedent: `modules/crypto-native/.../AndroidProtectedKeystore.kt`) and stored in the module's own preferences. It never crosses into JS, and is never logged; neither is a QR payload or a pairing code.
- Database: one per account like the others (`db/client.ts`), filled by the store: `rooms` (rid = chat JID, `d` or `p`), `subscriptions` (`unread` from `chat` frames, `open` true), `messages` (RC-shaped attachments; reactions keyed by shortcode, so the frame's glyph is mapped through the emoji table), `users` (from `names`). `reload` purges the account's rooms, subscriptions and messages before the replay that follows.

## Linking without a camera

On a phone the QR is the wrong default: the primary WhatsApp is usually on the same device, which cannot scan its own screen. The link sheet (`app/whatsapp-link.tsx`, a native `formSheet`, closes on a tap outside and then erases the half-made state like the desktop dialog) therefore opens on **link with a phone number**:

1. the number in international format (a country prefix picker plus the national number, digits only sent);
2. the engine's `pair_phone` (desktop `whatsapp/engine/pairing.go`, whatsmeow `PairPhone` with the push to the phone) answers a `pairing_code`, shown as `XXXX-XXXX` with a copy button;
3. WhatsApp on the phone shows a notification asking for the code; failing that, Linked devices, Link a device, Link with phone number instead;
4. `account` then `connected` save the session and open the account.

The QR stays available behind "Link from another phone", drawn with the existing native QR view (`ui/qrCode.tsx`; `ui/totpQr.ts` generalised beyond `otpauth://`). `phone_invalid` and `pairing_code_failed` are inline errors that re-enable the button; the QR attempt runs on regardless.

## Background

WhatsApp sends no push to a linked device: without a live connection nothing arrives. The mobile rule "background closes the socket, push takes over" (`ui/sync.tsx`) cannot hold here, so:

- **Opt-in "Receive in the background"**, off by default on the first link and offered right after it. On: `WhatsAppService` runs as a foreground service with a low-importance persistent notification ("WhatsApp connected", a Stop action), type `remoteMessaging` (API 34+, "transferring text messages between devices", the closest fit; `dataSync` is capped at 6 h per day on Android 15). Restarted after boot if it was on (`RECEIVE_BOOT_COMPLETED`; whether `remoteMessaging` may start from boot on Android 15 is to verify).
- Off: the engine runs while the app is in front and some seconds after, then closes. WhatsApp queues for the linked device, so the messages arrive at the next opening (the `reload`/offline sync path the desktop already handles).
- Presence follows the desktop rule: online only while the app is in front, because WhatsApp holds the primary phone's notifications back while a device is online. The service connects unavailable.
- Doze and OEM battery killers: measured on real devices before promising anything; a battery-optimisation exemption request is a restricted Play permission, kept as a last resort.

## Notifications

- From Kotlin, reusing the `MessagingStyle` code of the FCM service (`plugins/with-fcm-deeplink.js`), with reply and react actions answered by the engine directly (no JS start).
- Notification key namespaced `whatsapp:<state id>:<chat JID>` (`lib/notificationId.ts`), since JIDs repeat across accounts; the deep link carries the account and URL-encodes the JID's `@`.
- When the official WhatsApp is installed on the same phone, both notify. The account settings offer to mute RocketVibe's WhatsApp notifications, on by default when the official app is detected.
- While JS is attached, the in-app path of `ui/notifications.tsx` applies, as for other accounts.

## Media

- Received: a native file source `wa-media:<message id>` in the registry of `lib/nativeFiles.ts` whose `read` sends `download` and resolves on the `file` frame's path; `NativeAttachment` (`ui/messageRow.tsx`) renders images, audio and video from it, the path RocketVibe files already take.
- Sent: the `FileOutbox` copies into private storage (`ui/nativeFiles.ts`), then sends `upload` (`path`, `mime`, `voice` for a recorded note, as on desktop); the `uploads` row drives the pending UI, `sent` or a refused `error` with the id ends it.

## Build

- A Gradle `Exec` task in `modules/whatsapp/android/build.gradle` runs `gomobile bind -target=android/arm64,android/amd64 -androidapi 24 -tags sqlite_unlock_notify` (the vault panics without the tag, `tags.go`) against the NDK already pinned for `crypto-native`, following `reactNativeArchitectures` (`arm64-v8a,x86_64`), and the AAR is consumed with `implementation files(...)`.
- 16 KB pages: `-ldflags=-extldflags=-Wl,-z,max-page-size=16384`, checked with `llvm-readelf -l` in CI.
- CI (`mobile.yml`) adds Go (from `go.mod`, which asks 1.26) and gomobile; the licence notice (`licenses.sh`) ships in the APK's assets and is reachable from About.
- Size: whatsmeow, protobuf and SQLite are estimated at 15 to 25 MB per ABI; measured at the first AAR before going further.

## Risks

- **Account bans.** A third-party client breaches WhatsApp's terms; Meta can ban the number. The link sheet says so before linking, as the desktop's experimental label does.
- **Play policy.** The foreground service type needs a Play Console declaration with a video; a WhatsApp client may draw extra review. The APK is sideloaded today (`app-updater`), which defers it.
- **Engine lifetime bugs.** Two owners of one state would fight over the lock; the singleton is the only owner, JS only attaches.
- **Battery.** A permanent connection costs; hence opt-in, and the persistent notification makes it visible.

## Milestones

1. **Engine split** (Go), done: the `engine/` package and its API, the `replay` command; the desktop helper unchanged on the wire.
2. **AAR and module, in front only**: the Expo module, the key in AndroidKeyStore, linking by number, the room list and text timeline; the account in the rail.
3. **Conversation**: send, reactions, replies, edits and deletions, read state, typing, new conversations.
4. **Media** both ways.
5. **Background**: the service, Kotlin notifications with reply and react, boot restart, mute when the official app is present.
6. **Lifecycle and parity**: unlink, several accounts, the licence notice, `brain/features/whatsapp.md` `## Mobile` and the `brain/parity.md` row.

## Sources

- apps/desktop/whatsapp/engine/engine.go
- apps/desktop/whatsapp/engine/pairing.go
- apps/desktop/whatsapp/engine/store.go
- apps/desktop/whatsapp/engine/media.go
- apps/desktop/crates/rv-core/src/whatsapp.rs
- apps/desktop/crates/rv-gtk/src/whatsapp_link.rs
- apps/mobile/lib/provider.ts
- apps/mobile/providers/index.ts
- apps/mobile/providers/rocketvibe/index.ts
- apps/mobile/lib/sessionTransport.ts
- apps/mobile/ui/sync.tsx
- apps/mobile/ui/serverRail.tsx
- apps/mobile/lib/nativeFiles.ts
- apps/mobile/lib/notificationId.ts
- apps/mobile/ui/qrCode.tsx
- apps/mobile/modules/voice/
- apps/mobile/modules/crypto-native/android/build.gradle
- apps/mobile/plugins/with-fcm-deeplink.js
