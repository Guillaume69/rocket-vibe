# WhatsApp on Android: design

Status: built (see `brain/features/whatsapp.md`, `## Mobile`). Since 2026-10-24 the engine is the desktop's Rust one (`crates/rv-whatsapp`, as `librv_whatsapp.so` from `crates/rv-whatsapp/android`), not the Go engine on whatsmeow this design reused: the layers and the order below stand, the Go paths are history. Design written 2026-10-12. The desktop account it follows is described in `brain/features/whatsapp.md`; the protocol facts and the verification record are in `docs/WHATSAPP_HANDOFF.md`. This page decides how the Android app gets the same account, and in what order.

## Goal

A personal WhatsApp account linked to the phone as a WhatsApp linked device, living in the app like any other account (rail, room list, timeline, composer, notifications), with the desktop's first-release feature set: names, photos, reactions, quoted replies, edits and deletions, unread counts shared with the primary phone, delivered/read state, new conversations, photos, voice notes, videos and documents both ways, typing, notifications with reply and react, unlink. Calls stay out, as on desktop (the DMA interoperability route, `brain/decisions.md`).

## One engine, three layers

The desktop's Go engine (whatsmeow from the fork `boubou666/whatsmeow`, the sealed in-memory SQLite vault, the event queue, the frame vocabulary) is reused as is. Nothing about WhatsApp is reimplemented in Kotlin or TypeScript.

1. **Go, a C shared library** (done). The module splits into:
   - `engine/`: everything but the transport, exported by `engine/api.go`: `Open(path string, key []byte, sink Sink) (*Device, error)`, `(*Device).Connect()`, `Handle(line string) bool`, `Cancel()`, `Close()`, `Sink interface { Frame(frame string) }`, `ErrBusy`;
   - the module root: the desktop helper (`main.go`), unchanged on the wire (JSON lines over stdin/stdout);
   - `mobile/`: `librv_whatsapp.so`, four C functions (`rvwa_open` with the frame callback, answering a handle, -1 when another engine holds the state, -2 otherwise; `rvwa_connect`; `rvwa_handle`, 1 while running; `rvwa_close`), driven by `mobile/testdata/harness.c` the way Kotlin drives it.
   Chosen over `gomobile bind`: it follows `crypto-native` (a `.so` loaded through JNA, built by a Gradle `Exec` task with the NDK's clang) and needs no gomobile toolchain nor `golang.org/x/mobile` in the module.
   The frames stay JSON strings, so the mobile side parses exactly the vocabulary `rv-core/src/whatsapp.rs` parses (`message`, `names`, `avatar`, `reaction`, `reload`, `chat`, `account`, `found`, `file`, `typing`, `qr`, `pairing_code`, `status`, `error`, `sent`) and skips unknown ones. The `replay` command (done) re-emits the cached projection after a `reload` frame, for a JS side that attaches to an engine already running. Once two apps depend on it, the module moves out of `apps/desktop/` to a shared root directory, like `crates/`.
2. **Kotlin, `modules/whatsapp/`** (local Expo module, autolinked like `modules/voice/`):
   - `WhatsAppEngines`, a process singleton holding one engine per state id. The engine takes an exclusive file lock (`engine.go` `flock`), so JS and the service must share this one instance. It outlives JS reloads, account switches and `SyncProvider` cleanup; only unlink, logout and the user's "stop" end it.
   - `WhatsAppService`, a foreground service that keeps the engines alive in the background (see Background).
   - The module API to JS (done, `modules/whatsapp/index.ts`): `newState()`, `running()`, `start(state)`, `handle(state, command)`, `stop(state)`, `forget(state)`, and an `Events("frame")` event carrying `{state, frame}`, the pattern of `VoiceModule.kt`; failures reach JS as `whatsapp_busy`, `whatsapp_key_missing`, `whatsapp_start_failed` only.
   - Notifications posted from Kotlin, from frames, while JS is not attached (see Notifications).
3. **TypeScript, `packages/provider-whatsapp/`** on the template of `providers/vibez/index.ts`: the provider owns its runner, fakes the `Listener` (state from the engine's `status`), has no-op catch-ups and `reconcile`, and a store that writes the shared tables from frames. `ProviderKind` gains `whatsapp` (`packages/provider-api/src/provider.ts`), with a clause in `providers/index.ts`, `lib/sessionTransport.ts` (resume is a no-op, logout sends `logout`), `ui/serverRail.tsx` (unread from the engine's `chat` frames) and `ui/sync.tsx` (a branch beside the RocketVibe one).

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

- Received: a native file source `wa-media:<message id>` in the registry of `lib/nativeFiles.ts` whose `read` sends `download` and resolves on the `file` frame's path; `NativeAttachment` (`ui/messageRow.tsx`) renders images, audio and video from it, the path Vibez files already take.
- Sent: the `FileOutbox` copies into private storage (`ui/nativeFiles.ts`), then sends `upload` (`path`, `mime`, `voice` for a recorded note, as on desktop); the `uploads` row drives the pending UI, `sent` or a refused `error` with the id ends it.

## Build

- The Gradle `Exec` task `buildWhatsAppNative` (`modules/whatsapp/android/build.gradle`) runs `modules/whatsapp/build-android.mjs`: `go build -buildmode=c-shared -tags sqlite_unlock_notify ./mobile` (the vault panics without the tag, `engine/tags.go`) per ABI of `reactNativeArchitectures` (`arm64-v8a,x86_64`), `CC` = the NDK's clang with `--target=<triple><minSdk>`, into `build/generated/jniLibs`. Go is required on the build machine (`go.mod`'s version; `GOTOOLCHAIN=auto` fetches it); on Windows, Go installed by winget builds with the Windows NDK.
- 16 KB pages: `-extldflags=-Wl,-z,max-page-size=16384,-soname,librv_whatsapp.so`; `llvm-readelf -l` shows `0x4000` alignment on both ABIs.
- CI (`mobile.yml`) sets up Go from `go.mod` and watches `apps/desktop/whatsapp/**`. The licence notice (`licenses.sh`) still has to ship in the APK's assets, reachable from About.
- Size, measured: about 18 MB per ABI (`arm64-v8a` 18.4 MB, `x86_64` 19.4 MB, stripped), before APK compression.
- Proof: `WhatsAppEngineTest` (androidTest of the module) runs the real library and Keystore on an emulator: a new state loads, reaches WhatsApp until it offers a QR (never logged), replays, stops, reopens with the unwrapped key, and is erased with its key.

## Risks

- **Account bans.** A third-party client breaches WhatsApp's terms; Meta can ban the number. The link sheet says so before linking, as the desktop's experimental label does.
- **Play policy.** The foreground service type needs a Play Console declaration with a video; a WhatsApp client may draw extra review. The APK is sideloaded today (`app-updater`), which defers it.
- **Engine lifetime bugs.** Two owners of one state would fight over the lock; the singleton is the only owner, JS only attaches.
- **Battery.** A permanent connection costs; hence opt-in, and the persistent notification makes it visible.

## Milestones

1. **Engine split** (Go), done: the `engine/` package and its API, the `replay` command; the desktop helper unchanged on the wire.
2. **Library and module, in front only**: the `.so`, the Expo module and the Keystore key are done (above); left: linking by number, the provider, the room list and text timeline, the account in the rail.
3. **Conversation**: send, reactions, replies, edits and deletions, read state, typing, new conversations.
4. **Media** both ways.
5. **Background**, done: the service, Kotlin notifications with Reply and Mark as read, boot restart. Left: muting when the official app is present, React from the notification.
6. **Lifecycle and parity**: unlink, several accounts, the licence notice, `brain/features/whatsapp.md` `## Mobile` and the `brain/parity.md` row.

## Sources

- crates/rv-whatsapp/engine/src/engine.rs
- crates/rv-whatsapp/engine/src/actions.rs
- crates/rv-whatsapp/android/src/lib.rs
- apps/mobile/modules/whatsapp/build-android.mjs
- apps/desktop/crates/rv-core/src/whatsapp.rs
- apps/desktop/crates/rv-gtk/src/whatsapp_link.rs
- packages/provider-api/src/provider.ts
- apps/mobile/providers/index.ts
- apps/mobile/providers/vibez/index.ts
- apps/mobile/lib/sessionTransport.ts
- apps/mobile/ui/sync.tsx
- apps/mobile/ui/serverRail.tsx
- apps/mobile/lib/nativeFiles.ts
- apps/mobile/lib/notificationId.ts
- apps/mobile/ui/qrCode.tsx
- apps/mobile/modules/voice/
- apps/mobile/modules/crypto-native/android/build.gradle
- apps/mobile/plugins/with-fcm-deeplink.js
