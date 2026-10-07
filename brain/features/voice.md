# Voice

Discord-style voice on a **RocketVibe server** only: every room has a voice session, a
**voice channel** is a room you enter by selecting it (and can still write in), any other
room joins its session from the call button, and a call in a direct room **rings** the
other member. Audio flows through the operator's **LiveKit SFU**; the RocketVibe server
mints join tokens and mirrors who is connected. It replaced the native server's Jitsi
meetings ([calls](calls.md) stays the Rocket.Chat path). Camera (off by default) and one
screen share per room, a new share replacing the current one, with the computer's sound
but not the call's voices (an option adds them); while someone shares, the screen takes
most of the page and the people a narrow column at its right, and it goes full screen.
As in Discord: a menu beside the microphone (devices, volumes, the microphone's level, the
noise remover, deafen), each person's volume here or a mute for oneself, the people as tiles
sharing the page, a picker of what to share (screen or window) and its quality, and a direct
call that ends for both when one leaves. The microphone goes through **RNNoise** on both
apps, and who speaks is told from the sound itself, a whisper included. In an encrypted
room the frames are end-to-end encrypted under a key from the room's MLS group.

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
  server: a connected client tells it from the sound itself (its microphone after
  RNNoise, each remote track's level), since LiveKit's active speakers miss a whisper.
- **Deafen** is a participant attribute, `rv.deafened = "1"`, that the worker reads.
- **Rings**: `ring: true` in a direct room creates a ring and a `call_started` row; the
  callee's devices get a `voice_ring` data push (none when busy); accept / decline / leave
  or 30 s resolve it (`answered`, `declined`, `missed`, `cancelled`), and the row's
  `Message.call` carries the outcome and, once both left, the duration.
- **Screen share**: `POST /api/v1/voice/screen` claims the room's one share, which widens
  the participant's LiveKit sources; claiming while someone else shares **takes it over**:
  their claim goes and their screen sources are revoked at once (the worker repeats it).
  `DELETE` or leaving releases the caller's own claim only.

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
- **Listening and the noise remover** (the engine, for the process): each person's volume
  (`RemoteAudioTrack.setVolume`, times the speakers' volume) or a mute for this side only;
  every microphone buffer goes through `voiceAndScreen` on the audio thread: RNNoise when
  on and the capture is 48 kHz mono (`Denoiser.kt` over JNI, `crates/rv-voice-mobile` built
  by `modules/voice/build-android.mjs` from the module's Gradle task, as the crypto module
  builds its library, with the same voice gate; WebRTC's own suppression stays on), the input volume, the level (a
  `level` event ten times a second) and whether it speaks (RNNoise's voice probability).
  Remote microphones are read through LiveKit sinks for their level; `speaking` is that or
  LiveKit's active speakers, refreshed by a 100 ms tick. The share's quality sets LiveKit's
  screen capture size (the screen's shorter side at the chosen lines) and bitrate.
- **Controller**: `lib/voice.ts` (Node-pure, `lib/voice.test.ts`) asks the server for a
  grant then connects the engine, adopts a call the engine kept across a JS reload, stops
  the ringback when the callee arrives, hangs up an outgoing call that was declined or
  missed, and never tells the server to leave when LiveKit closed the session because
  another device took it. It keeps the listening choices (`Listening`: volumes, people muted
  here, noise remover, share quality) in SecureStore (`voice-listening`, written 400 ms after
  the last change) and hands them to the engine at start. A direct call (`JoinOptions.direct`,
  rings included) hangs up 2 s after the other person left (`DIRECT_GRACE_MS`), and the view
  keeps `direct` so the screen gives the chat back. `NativeChat` gains `joinVoice`,
  `leaveVoice`, `voiceRing`,
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
  DM (`ui/roomHeader.tsx`). `app/voice/[rid].tsx` is the call screen: a tile per person
  sharing all the screen (`lib/voiceGrid.ts`: the cells that hold the largest picture
  between 2:3 and 16:9, so a phone held upright stacks two people), whose border glows
  while they speak (Reanimated), chat button, controls; a long press on someone opens
  `app/voice/person.tsx` (their volume, mute for me), as on the list's occupants (🔕 when
  muted here). The ⌃ beside the microphone opens `app/voice/menu.tsx`: output route (the
  microphone follows it), input volume and level meter, output volume, noise remover,
  deafen, share quality; both are native sheets, the sliders `ui/slider.tsx` (gesture
  handler and Reanimated). A direct call over gives its chat back (`router.dismissTo`). Call rows
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
- **Camera and screen**: `VoiceVideoView` (native view over LiveKit's renderer, laid out
  at the frame's proportions since the renderer stretches: letterboxed for `contain`,
  clipped for `cover`) shows a camera in the person's card. While someone shares, the
  screen fills the page and the people go in a narrow column at its right (`MiniCard`,
  cameras as thumbnails); a tap on it shows it full screen (a `Modal`, both orientations).
  What to share is the system's choice: Android 14 and later offer one app or the whole
  screen in the consent dialog. The camera asks its permission at the first use and is off at
  every join; sharing claims the room's share from the server first, then asks Android
  (MediaProjection, LiveKit's capture service), and gives the claim back when refused or
  stopped, the system's projection notification included (`lib/voice.ts` `shareScreen`).
  Another participant's share stops this one: the engine stops on its screen track
  unpublished or its permission losing `SCREEN_SHARE`. **The screen's sound** (Android 10
  and later, with the microphone permission): LiveKit's `ScreenAudioCapturer` over the
  same MediaProjection mixes what apps let capture (media, games) into the microphone
  track, the one recorded track Android publishes; Android never captures
  voice-communication audio, so the call's voices are never in it and the option to add
  them does not exist here. While it flows the microphone track stays on and a mute only
  zeroes the voice samples (`voiceAndScreen`), so the room sees the sharer unmuted.
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
  on the `livekit` crate. It plays and captures the call's sound itself (`voice/src/audio.rs`)
  rather than through libwebrtc's device module, which leaves no way to change a person's
  volume or the samples: cpal opens the devices (WASAPI, CoreAudio, and on Linux
  PulseAudio's protocol in pure Rust, which PipeWire serves; device ids are cpal's, PulseAudio
  monitors left out). Capture: the device's rate to 48 kHz mono, 10 ms frames, WebRTC's audio
  processing module (echo cancellation against what plays, high-pass; its own noise
  suppression only while RNNoise is off), **RNNoise** (`nnnoiseless`) and a **voice gate**
  (shut while RNNoise's voice probability stays under 0.6, held 300 ms after a voice, fading
  out over about 100 ms: a keyboard between words, which RNNoise only softens), then
  WebRTC's gain control in a second module, last so that it never raises the noise RNNoise
  removes, the input volume, then LiveKit. `RV_VOICE_DEBUG`, `RV_VOICE_RECORD` and
  `RV_VOICE_TEST_TONE` are diagnostics (`audio.rs`). Playout: each remote audio track as 48 kHz stereo into a buffer
  (primed at 40 ms, cut back past 200 ms), mixed at each person's gain (muted here: 0) and
  the output volume; the mix is the echo canceller's reference. **Who speaks** comes from the
  sound: this side from RNNoise's voice probability above a floor (the level without
  RNNoise), others from their track's level above -52 dBFS (screen sound excluded), 350 ms
  hangover; a 100 ms tick sends the participants and `InputLevel`. Devices are opened by
  their id, the default included: on WASAPI a stream on "the default" dies at every
  default-device notification, which a virtual surround headset's driver sends in bursts
  (it reopened ten times a second and crackled); a real change of default is followed every
  3 s instead, and a stream that dies reopens the chosen devices at most every 2 s
  (`device_lost`). It is a separate process because libwebrtc
  exists only for MSVC on Windows (the GTK app builds with MSYS2) and must stay out of
  rv-ffi's static library. Linux builds it in ubuntu:22.04 with clang 21 (glibc floor
  2.35); Windows needs the static C runtime and a short target path
  (`apps/desktop/voice/README.md`). JSON lines both ways (`crates/rv-voice-protocol`):
  connect (with the encrypted room's key), set key, microphone, deafen, devices, a person's
  volume and mute, input and output volumes, noise remover, share sources; state,
  participants (speaking, level), devices, screens, input level, why it ended. Protocol
  version 2: a version 1
  sidecar would ignore the key and connect in clear, so the app refuses it.
  `RV_VOICE_FAKE_AUDIO=sine` replaces the devices for tests; LiveKit's per-participant
  encryption state goes to stderr (a key mismatch silences someone without another trace).
- **Video in the sidecar** (`voice/src/video.rs`): the camera through `nokhwa` (V4L2 on
  Linux, Media Foundation on Windows; none on macOS, whose camera permission belongs to an
  app bundle), MJPEG decoded by `image`'s pure-Rust JPEG; the screen through libwebrtc's
  desktop capturer: `ListScreens` names the screens and the titled windows (ids
  `screen:<n>`, `window:<handle>`) and sends each one's thumbnail on the frame stream
  (identity `thumbnail:<id>`); `StartScreenShare` takes one (the portal's picker on Wayland,
  the first screen without) and a `ScreenQuality` (lines, frames a second; 1080 at 15 by
  default) whose bitrate is about 0.08 bit per pixel and frame, 1.5 to 12 Mbit/s; `build.rs`
  links GLib for the portal. Remote cameras are asked at
  LiveKit's medium simulcast layer, screens at the high one. Every frame the app shows (the
  room's tracks, this side's previews) is converted to RGBA by libyuv, fitted (cameras 640
  by 480, screens 1920 by 1080), at most 15 a second per track, and streamed to the app over
  a **loopback TCP** connection the app listens on with a random token (`Command::Video`,
  `rv_voice_protocol::frames`): latest frame per track, stale ones dropped, never an end
  marker. `RV_VOICE_FAKE_VIDEO=pattern` replaces the camera and the screen.
- **The screen's sound** (`voice/src/screen_audio.rs`), published beside the screen as its
  own `ScreenshareAudio` track (no echo cancellation, gain or noise suppression, 96 kb/s).
  "The call" is the sidecar's playout and the app's own sounds (cues, ringtone): rv-core
  passes the app's process id in `RV_VOICE_APP_PID`. Windows: WASAPI process loopback of
  everything but the app's process tree, the sidecar included (the `wasapi` crate, safe
  code), or with `StartScreenShare.with_call` plain loopback of the default output; a shared
  window carries its program's process tree only (`GetWindowThreadProcessId`). Linux:
  the helper **`rv-screen-audio`** (`voice/screen-audio`, its own binary because
  libwebrtc defines weak stubs of PipeWire's C functions that would take the place of
  libpipewire's inside rv-voice) creates a PipeWire capture node and links it, port by
  port, to every `Stream/Output/Audio` node but those of the excluded processes (a node's
  process from its bound info, else its client's), all of them with the call; raw PCM on
  its stdout, which rv-voice reads; it leaves when rv-voice stops it or dies. It builds on
  Ubuntu 24.04 (its bindings need PipeWire headers newer than 22.04's) and runs on 22.04's
  PipeWire 0.3.48 (checked). macOS shares no sound. The fake video mode adds a 660 Hz tone (`RV_VOICE_SCREEN_AUDIO=capture`
  keeps the real capture); `RV_VOICE_LEVELS=1` prints the captured level.
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
  `set_share_call` / `share_call` hold the option to put the call's voices in a screen's
  sound (off by default), sent with each `StartScreenShare`. `Listening` (each person's
  volume and mute here, input and output volumes, noise remover) is sent to each sidecar as
  it starts; `screens()` lists what to share, `input_level()` reads the meter apart from the
  snapshot; several callers may wait for the device list at once.
  Video: `VoiceController` listens for each sidecar's frame stream and keeps the latest frame
  per track (`frame(identity, source)`); `set_camera`, `start_screen_share`,
  `stop_screen_share` and the snapshot's `camera` / `sharing` wishes (taken back when the
  sidecar reports `camera_unavailable`, `screen_cancelled`, `screen_ended`...).
  `NativeSession::share_screen` claims the room's share first and gives it back however the
  share ends (a watch on the snapshot).
  The native store presents a call row's `Message.call` as mobile does: `rv-call-<state>`, the
  duration in seconds as its parameter (`rv-call` before an outcome); `i18n::call_summary` says
  it ("📞 Missed call", "📞 Call · 12 min").
- **GTK** (`rv-gtk/src/chat_voice.rs`, only when `voice_supported()`): a voice channel shows a
  speaker icon and joins on selection; the people in any room's session are listed under its
  row, the ring of their avatar lit while they speak in your session (a CSS class toggled per
  account, no rebuild per speaking tick); the voice page (a tile per person glowing while they
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
  (`details/native_rooms.rs` sends `UpdateRoom.voice` only then). Camera and screen buttons
  on the voice page (green when on); a camera fills its tile; while
  someone shares, the stage fills the page and the people go in a narrow column at its right.
  Each video view is a `gtk::Picture` polling `frame()` 25 times a second while mapped, a
  `gdk::MemoryTexture` per new frame (`video_view`, `video_box`). Toasts say when there is
  no camera or the screen could not be shared. On Windows the settings' "Voice" group has
  "Include the call in a shared screen's sound" (`voice-share-call` in the config dir) and
  the noise remover. As in Discord: the people are tiles sharing the page at 16:9
  (`tile_grid.rs`, a widget arranging its children), a camera filling its tile, the name in a
  corner; the ⌃ beside the microphone opens a popover (input and output devices, input volume
  and a level meter polled 20 times a second, output volume, noise remover, deafen, voice
  settings); a right click on someone (under the room, on a tile) sets their volume or mutes
  them for this side, kept with the other listening choices in `voice-listening.json`. The
  screen button opens a picker (`share_picker`: screens and windows with thumbnails,
  resolution and frame rate kept in `voice-share-quality`; Wayland: the quality only). The
  stage goes full screen (its button, a double click; Escape comes back) and follows a
  takeover. A direct call over gives the chat back; the other person gone, it hangs up after
  2 s (`direct_call`). An outgoing ring declined or missed while alone in the call hangs up
  (`voice_rings`), and calling a direct room nobody else is in rings again, even from inside
  its session.
- **Packaging**: every desktop package carries `rv-voice` next to the app (`desktop.yml` calls
  `desktop-voice.yml`); see [desktop-gtk](../architecture/desktop-gtk.md#packaging).
- **SwiftUI** (`apps/desktop/macos`): the same `rv-voice` sidecar through rv-core, exported by
  rv-ffi's `native_voice.rs` (`NativeChat.voiceState`, `voiceMembers`, `joinVoice`,
  `answerCall`, `voiceFrame`, `voiceDevices`, `setPersonVolume`, ...; frames handed as RGBA,
  only when newer than the caller's serial). A supervisor task in rv-ffi does what GTK's UI
  loop does: it hangs up an outgoing ring declined or missed while alone, hangs up a direct
  call 2 s after the other person left, and sends `Event::Voice` (at most every 100 ms) when
  the session, the listening choices or the rings change. The choices are shared with GTK
  through `rv_core::voice_prefs` (one file each in `~/.config/rocket-vibe-rs`). Kit's
  `VoiceModel` follows the state and derives the cues, the ringtone or ringback and the
  incoming ring; `AppModel.select` joins a voice channel picked in the list. Views in
  `Sources/RocketVibe/Voice.swift`: occupants under each row (ring lit while speaking, a
  context menu with mute here and a volume from 0 to 200 %), the voice page (16:9 tiles,
  the stage and a column of people while a screen is shared, Join or the controls), the
  stage full screen in its own window, the "Voice connected" panel above the account bar,
  the menu beside the microphone (devices, volumes, live level, noise remover, deafen,
  settings), the share picker (screens and windows with thumbnails, resolution, frame
  rate), the header's call button, the call rows' Join or Call back, an alert to accept or
  decline a ring, a "Voice" section in the settings, and room creation (`NewRoom.swift`, from
  the list's button: name, private, "Voice channel" where the server offers voice, through
  `AppModel.createRoom`, opened once listed). No camera button: the sidecar captures
  none on macOS; others' cameras show. Sounds: `scripts/package.sh` renders the WAV masters
  (`scripts/sounds/generate.mjs`) and encodes them to AAC in `Resources/sounds` for
  `AVAudioPlayer`; the bundle carries `rv-voice` in `Contents/MacOS`, signed with the app's
  entitlements. Checked by the macOS CI build only.

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
- apps/mobile/modules/voice/android/src/main/java/com/rocketvibe/voice/Denoiser.kt
- apps/mobile/modules/voice/build-android.mjs
- apps/desktop/crates/rv-core/src/voice_prefs.rs
- apps/desktop/crates/rv-ffi/src/native_voice.rs
- apps/desktop/macos/Sources/RocketVibeKit/VoiceModel.swift
- apps/desktop/macos/Sources/RocketVibe/Voice.swift
- apps/desktop/macos/Sources/RocketVibe/NewRoom.swift
- apps/desktop/macos/scripts/package.sh
- crates/rv-voice-mobile/src/lib.rs
- apps/mobile/lib/voiceGrid.ts
- apps/mobile/ui/slider.tsx
- apps/mobile/app/voice/menu.tsx
- apps/mobile/app/voice/person.tsx
- apps/mobile/lib/voice.ts
- apps/mobile/ui/voice.tsx
- apps/mobile/app/voice/[rid].tsx
- apps/mobile/app/voice-ring/[id].tsx
- apps/mobile/app/new-room.tsx
- apps/mobile/plugins/native-push-source.js
- apps/mobile/providers/rocketvibe/chat.ts
- apps/desktop/voice/src/main.rs
- apps/desktop/voice/src/audio.rs
- apps/desktop/voice/src/video.rs
- apps/desktop/voice/src/screen_audio.rs
- apps/desktop/voice/screen-audio/src/main.rs
- apps/desktop/voice/build.rs
- apps/desktop/crates/rv-voice-protocol/src/lib.rs
- apps/desktop/crates/rv-core/src/voice.rs
- apps/desktop/crates/rv-core/src/native/voice.rs
- apps/desktop/crates/rv-core/src/native/store.rs
- apps/desktop/crates/rv-gtk/src/chat_voice.rs
- apps/desktop/crates/rv-gtk/src/tile_grid.rs
- apps/desktop/crates/rv-gtk/src/sounds.rs
- apps/desktop/crates/rv-gtk/src/cards.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-gtk/src/settings/voice.rs
- apps/desktop/crates/rv-gtk/src/details/native_rooms.rs
- .github/workflows/desktop-voice.yml
