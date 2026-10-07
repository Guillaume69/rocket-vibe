# Voice

Discord-style voice on a **RocketVibe server** only: every room has a voice session, a
**voice channel** is a room you enter by selecting it (and can still write in), any other
room joins its session from the call button, and a call in a direct room **rings** the
other member. Audio flows through the operator's **LiveKit SFU**; the RocketVibe server
mints join tokens and mirrors who is connected. It replaced the native server's Jitsi
meetings ([calls](calls.md) stays the Rocket.Chat path). Camera (off by default) and one
screen share per room are in the protocol and on Android; the desktop is audio only. In an
encrypted room the frames are end-to-end encrypted under a key from the room's MLS group.

## Server contract

The wire contract is `docs/protocol/VOICE.md`; the essentials:

- **Capability** `voice`, announced when `RV_LIVEKIT_CONFIG_FILE` is set
  (`docker/compose.voice.yml` runs LiveKit on the bench). `calls` stays `false`.
- **Join**: `POST /api/v1/rooms/{id}/voice/join {membership_version, data_epoch, ring?}`
  → `VoiceGrant {url, token, can_publish, ring?}`. The token lives 5 minutes, names the
  LiveKit room `rv:{epoch}:{room}`, and its identity is the **account id**: one voice
  connection per account, joining elsewhere moves it (LiveKit closes the older one with
  `duplicate_identity`; the server evicts it from the previous room). Microphone and camera
  only; a plain member of a read-only room listens.
- **Encrypted rooms**: the join must say `e2ee: true` (else `403 voice_encrypted_room`) and
  the grant answers `e2ee: true`; the session is its own LiveKit room `rve:{epoch}:{room}`,
  so plaintext and encrypted participants never meet (the worker evicts one left from before
  the group existed; `voice_sessions.e2ee`). The key never reaches the server: each device
  exports it from the room's MLS group at the current epoch
  (`rv_crypto::groups::Coordinator::voice_key`, label `rocketvibe voice v1`, 32 bytes) and
  gives LiveKit its standard base64 as the **shared key, index 0**, with LiveKit's defaults
  (PBKDF2, salt `LKFrameEncryptionKey`), the same bytes on Android and in Rust. A device
  behind the server's group head (a change not accepted yet, not welcomed) has no key and
  is told so (`voice_key_unavailable`); a new epoch replaces the key, polled every 15 s
  while connected.
- **Who is connected** is not reported by clients: a server worker polls LiveKit every 2 s
  (Twirp `ListRooms` / `ListParticipants`), keeps `voice_sessions`, evicts identities with no
  right to be there and aligns their publish permissions. Each live room carries
  `voice: [{user, muted, deafened, camera, screen}]`. **Who speaks** never transits the
  server: a connected client reads LiveKit's active speakers.
- **Deafen** is a participant attribute, `rv.deafened = "1"`, that the worker reads.
- **Rings**: `ring: true` in a direct room creates a ring and a `call_started` row; the
  callee's devices get a `voice_ring` data push (none when busy); accept / decline / leave
  or 30 s resolve it (`answered`, `declined`, `missed`, `cancelled`), and the row's
  `Message.call` carries the outcome and, once both left, the duration.
- **Screen share**: `POST /api/v1/voice/screen` claims the room's one share, which widens
  the participant's LiveKit sources; `DELETE` or leaving releases it.

## Mobile

- **Engine**: the local Expo module `modules/voice` (Android, Kotlin) wraps the LiveKit
  Android SDK, not `react-native-webrtc` ([decisions](../decisions.md)). `VoiceEngine` is a
  process singleton holding the one `Room`; `VoiceService` is a microphone foreground
  service (media playback when the microphone was refused) with an ongoing `CallStyle`
  notification whose Mute and Leave act without JS. It reports one `change` event carrying
  the whole snapshot (state, room, microphone, deafened, route, participants with
  `speaking`). Deafen disables remote tracks at the SFU and locally, cuts the microphone and
  sets the attribute. Sounds (`assets/sounds`, copied into the module's raw resources by
  its Gradle task) are played natively: join, leave, mute, unmute, the ringback while a call
  rings and the in-app ringtone.
- **Controller**: `lib/voice.ts` (Node-pure, `lib/voice.test.ts`) asks the server for a
  grant then connects the engine, adopts a call the engine kept across a JS reload, stops
  the ringback when the callee arrives, hangs up an outgoing call that was declined or
  missed, and never tells the server to leave when LiveKit closed the session because
  another device took it. `NativeChat` gains `joinVoice`, `leaveVoice`, `voiceRing`,
  `acceptRing`, `declineRing`; `createRoom` takes `voice`, remembered in the idempotent
  creation form (`native_room_creations.voice`, migration 0019, which also adds
  `rooms.voice` and drops the retired `native_meeting_intents`).
- **UI** (`ui/voice.tsx`): `VoiceOccupants` under every room row of the list (the ring of an
  avatar lights up while the person speaks in your session), `VoiceBar` at the foot of the
  list ("Voice connected", mute, deafen, leave), `useJoinVoice` (asks the microphone,
  Bluetooth and notification permissions at the first join, opens the voice screen),
  `VoiceRingHost` mounted once in `_layout` (incoming ring modal with the ringtone, feeds
  outgoing rings to the controller, says why a session ended). A voice channel shows 🔊 and
  joins on tap (`app/index.tsx`); the room header's 📞 joins the room's voice and rings in a
  DM (`ui/roomHeader.tsx`). `app/voice/[rid].tsx` is the call screen: a card per person
  whose border glows while they speak (Reanimated), chat button, controls. Call rows
  (`rv-call-<state>`, from `Message.call`) show the outcome and offer join or call back
  (`ui/messageRow.tsx`, `lib/systemMessages.ts`). `app/new-room.tsx` creates rooms and voice
  channels.
- **Ringing in the background**: the FCM service's RocketVibe branch
  (`plugins/native-push-source.js`) reads the ring authenticated, then
  `VoiceRinging.show` posts an incoming `CallStyle` notification with a ringtone channel and
  a full-screen intent to `IncomingCallActivity`, shown over the lock screen; MainActivity
  never is. Accept opens `rocketvibe://voice-ring/<id>` (`app/voice-ring/[id].tsx` answers
  for the matching account only); Decline goes through `NativeVoiceReceiver` and a
  WorkManager job. `voice_ring_end` cancels the ring.
- **Camera and screen**: `VoiceVideoView` (native view over LiveKit's renderer) shows a
  camera in the person's card and the room's one screen share on a stage above the cards.
  The camera asks its permission at the first use and is off at every join; sharing claims
  the room's share from the server first (`409 screen_taken`), then asks Android
  (MediaProjection, LiveKit's capture service), and gives the claim back when refused or
  stopped, the system's projection notification included (`lib/voice.ts` `shareScreen`).
- **Encrypted rooms**: `NativeChat.voiceKey` reads the key through the crypto bridge's
  `voice_key` action (`providers/rocketvibe/cryptoGroups.ts` `voiceKey`, null when this
  device is behind the server's epoch) and the join says `e2ee`; the engine builds a
  `BaseKeyProvider` after creating the room (its constructor needs WebRTC loaded) and sets
  `Room.e2eeOptions` before connecting. The controller refuses a grant that says `e2ee`
  without a key, follows new epochs every 15 s (`refreshKey`, `setE2eeKey`), and the voice
  screen shows "🔒 … end-to-end encrypted". Android pauses the poll in the background: a
  rotation then waits for the app to come back.

## Desktop

- **Sidecar**: the audio runs in `rv-voice` (`apps/desktop/voice`, its own cargo workspace)
  on the `livekit` crate with the platform audio devices, so WebRTC's echo cancellation,
  noise suppression and gain control apply. It is a separate process because libwebrtc
  exists only for MSVC on Windows (the GTK app builds with MSYS2) and must stay out of
  rv-ffi's static library. Linux builds it in ubuntu:22.04 with clang 21 (glibc floor
  2.35); Windows needs the static C runtime and a short target path
  (`apps/desktop/voice/README.md`). JSON lines both ways (`crates/rv-voice-protocol`):
  connect (with the encrypted room's key), set key, microphone, deafen, devices; state,
  participants (speaking, level), devices, why it ended. Protocol version 2: a version 1
  sidecar would ignore the key and connect in clear, so the app refuses it.
  `RV_VOICE_FAKE_AUDIO=sine` replaces the devices for tests; LiveKit's per-participant
  encryption state goes to stderr (a key mismatch silences someone without another trace).
- **rv-core**: `voice.rs` (`VoiceController`, one sidecar per connection, found through
  `RV_VOICE_BIN` or next to the executable; `available()` gates the feature);
  `native/voice.rs` (`NativeSession`: join with membership and epoch checks, leave, rings,
  each room's participants and the rings from the live cache, `create_room(.., voice)`).
  `store::RoomRow.voice` marks voice channels. `connect_voice` / `answer_ring` take the
  app's `VoiceKeys` source; in an encrypted room they fetch the key first and the controller
  follows new epochs every 15 s (`voice.rs` `follow`). The key comes from the delivery
  worker (`rv_crypto::delivery::Worker::voice_key`, compared with the server's group head),
  through the room's crypto access (`native/crypto/enrollment/rooms.rs` `voice_key`), which
  GTK opens once per session (`chat_voice.rs` `voice_keys`).
  The native store presents a call row's `Message.call` as mobile does: `rv-call-<state>`, the
  duration in seconds as its parameter (`rv-call` before an outcome); `i18n::call_summary` says
  it ("📞 Missed call", "📞 Call · 12 min").
- **GTK** (`rv-gtk/src/chat_voice.rs`, only when `voice_supported()`): a voice channel shows a
  speaker icon and joins on selection; the people in any room's session are listed under its
  row, the ring of their avatar lit while they speak in your session (a CSS class toggled per
  account, no rebuild per speaking tick); the voice page (a card per person glowing while they
  speak, "Open the chat", Join, controls); the "Voice connected" panel above the account bar
  (mute, deafen, leave, a click opens the page). The header's call button joins the open room's
  voice and rings in a DM nobody is in yet; a profile's Call opens the DM and rings. An incoming
  ring opens an Accept / Decline dialog over the ringtone (the window is presented if hidden),
  the caller hears the ringback, cues mark join, leave, mute and a missed call (`sounds.rs`
  plays `assets/sounds` through GStreamer). Call rows show the outcome (missed in red) with
  Join while the call goes on or Call back once it ended (rings in a DM), and the room list
  previews the outcome. Toasts say why a session ended (another device took it, removed,
  interrupted). Settings gain a "Voice" group (shown when the sidecar ships) choosing the
  microphone and speakers, kept in the config dir (`voice-input`, `voice-output`) and handed to
  each session's controller (`settings/voice.rs`). The create-room dialog has a "Voice channel"
  switch, and an owner edits it in the room settings when the server announces voice
  (`details/native_rooms.rs` sends `UpdateRoom.voice` only then).
- **Packaging**: every desktop package carries `rv-voice` next to the app (`desktop.yml` calls
  `desktop-voice.yml`); see [desktop-gtk](../architecture/desktop-gtk.md#packaging).
- **SwiftUI**: not yet; the plan is LiveKit's Swift SDK in the macOS-only target.

## Sources

- docs/protocol/VOICE.md
- docs/protocol/E2EE_REVIEW.md
- apps/server/src/voice.rs
- crates/rv-crypto/src/groups.rs
- crates/rv-crypto/src/delivery.rs
- crates/rv-crypto-mobile/src/groups.rs
- apps/mobile/providers/rocketvibe/cryptoGroups.ts
- apps/mobile/modules/voice/android/src/main/java/com/rocketvibe/voice/VoiceVideoView.kt
- apps/desktop/crates/rv-core/src/native/crypto/enrollment/rooms.rs
- apps/server/src/livekit.rs
- apps/server/src/live.rs
- apps/server/migrations/0049_voice.sql
- docker/compose.voice.yml
- assets/sounds/README.md
- scripts/sounds/generate.mjs
- apps/mobile/modules/voice/android/src/main/java/com/rocketvibe/voice/VoiceEngine.kt
- apps/mobile/modules/voice/android/src/main/java/com/rocketvibe/voice/VoiceService.kt
- apps/mobile/modules/voice/android/src/main/java/com/rocketvibe/voice/VoiceRinging.kt
- apps/mobile/modules/voice/android/src/main/java/com/rocketvibe/voice/IncomingCallActivity.kt
- apps/mobile/modules/voice/index.ts
- apps/mobile/lib/voice.ts
- apps/mobile/ui/voice.tsx
- apps/mobile/app/voice/[rid].tsx
- apps/mobile/app/voice-ring/[id].tsx
- apps/mobile/app/new-room.tsx
- apps/mobile/plugins/native-push-source.js
- apps/mobile/providers/rocketvibe/chat.ts
- apps/desktop/voice/src/main.rs
- apps/desktop/crates/rv-voice-protocol/src/lib.rs
- apps/desktop/crates/rv-core/src/voice.rs
- apps/desktop/crates/rv-core/src/native/voice.rs
- apps/desktop/crates/rv-core/src/native/store.rs
- apps/desktop/crates/rv-gtk/src/chat_voice.rs
- apps/desktop/crates/rv-gtk/src/sounds.rs
- apps/desktop/crates/rv-gtk/src/cards.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-gtk/src/settings/voice.rs
- apps/desktop/crates/rv-gtk/src/details/native_rooms.rs
- .github/workflows/desktop-voice.yml
