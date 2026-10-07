# Desktop macOS app: SwiftUI over rv-ffi

`apps/desktop/macos` is a native SwiftUI app for macOS 15+ (Apple Silicon) that reuses the whole Rust core through `rv-ffi`, a UniFFI facade. It exists because the GTK build on macOS renders in software and feels laggy. It ships in beta beside the GTK app as its own bundle, `rocket-vibe SwiftUI` (`com.rocketvibe.app.swiftui`), and shares accounts and databases with it.

Context: [desktop-app.md](desktop-app.md) (crates), [desktop-core.md](desktop-core.md) (what `rv-ffi` wraps), [desktop-gtk.md](desktop-gtk.md) (the GTK app it parallels). The plan and its history are in `apps/desktop/docs/MACOS-SWIFTUI.md`; this page describes what the code does today.

## Why it exists

The GTK build sets `GSK_RENDERER=cairo` on macOS (`rv-gtk/src/macos.rs`) because GTK's OpenGL renderer drew emoji as `?` and crawled on Macs without a real GPU (CI runners). Every Retina frame is then rasterised on the CPU, and GTK's list factory rebuilds each row widget on bind. GTK on macOS also lacks native scrolling physics, text input and menus. A SwiftUI layer gets those from the system and draws on the GPU, at the cost of a second UI to keep in step. The "measure GL rendering on a real Mac first" step of the plan was never run; the build went ahead because its first phases were cheap.

## Layers

```
rv-core (Rust)        protocol, store, sync, outbox, uploads, E2EE, display rules
rv-ffi  (Rust)        UniFFI facade: Client, Chat, records, Listener; staticlib + cdylib
SwiftPM package RocketVibeMac (apps/desktop/macos/Package.swift)
  rv_ffiFFI           C target: the generated header, links librv_ffi.a by path
  RocketVibeCore      the generated Swift bindings (rv_ffi.swift)
  RocketVibeKit       @MainActor @Observable view models; builds on Linux too
  RocketVibe          the SwiftUI app (macOS only)
  rv-rooms            CLI: offline self-check, or sign in and list rooms
  RocketVibeKitTests  XCTest
```

The generated files (`Sources/rv_ffiFFI/include/rv_ffiFFI.h`, `Sources/RocketVibeCore/rv_ffi.swift`) are gitignored and written by `scripts/generate.sh`.

## rv-ffi

- **UniFFI 0.32 with proc-macros** (`uniffi::setup_scaffolding!`, `#[uniffi::export]`, `uniffi::Record/Enum/Object`), no UDL. The crate ships its own `uniffi-bindgen-swift` binary (`src/bin/uniffi-bindgen-swift.rs`), run in library mode against the built dylib.
- **One tokio runtime per process** (2 workers). Every async export spawns its work there and awaits the join handle, so any executor can poll it: Swift's, or `futures::executor::block_on` in `tests/live.rs`. UniFFI's own `async_runtime = "tokio"` is deliberately not used: it would run futures on a different runtime from the one `Session::start` spawned its tasks on. Keychain and file work goes through `spawn_blocking`.
- **Objects.** `Client` (constructed with the home directory) probes servers, logs in (with 2FA), lists and resumes accounts. `Chat` wraps one `Arc<Session>` and exposes rooms, messages, threads, paging, send, slash commands, edit/delete/react/pin/star/quote, action lists, calls, media bytes, downloads, drafts, typing, uploads, spotlight, DMs, status, E2E unlock/lock, sign-out. Dropping a `Chat` aborts its listener task and shuts the session down.
- **Records, not JSON.** Where `rv-core` keeps JSON strings (attachments, reactions, `md`), `model.rs` hands Swift parsed records; `markup.rs` turns `rv-core` markdown blocks into styled runs (`rv_core::runs`), so Swift never parses Rocket.Chat documents or Pango markup. `context.rs` puts rv-core's context window behind the `ContextView` object. Free functions export the shared catalog (`t`, `tf`, `tn`, `system_message`, `set_french`), emoji helpers (`reaction_emoji`, `same_emoji` from `reactions.rs` among them), the player origin and navigation rule, and the call-origin rule.
- **Quick reactions.** `reactions.rs` keeps one rv-core `EmojiUsage` per account for the run, in the config folder and under the key the GTK app uses, so both apps on one Mac count into one file; `Chat::quick_reactions` and the native `quick_reactions(custom:)` give the top 5, and the react exports (Rocket.Chat, native, private) record every reaction added.
- **Protected media.** `Chat::media(path)` returns bytes plus content type and a `placeholder` flag (the server's generated initials SVG), so Swift never holds the token.
- **Synchronous context menus.** `prepare_actions(rid)` fetches the server's settings and my room permissions when a room opens; `actions(rid, message_id, in_thread)` then answers at once, because a SwiftUI context menu builds its items synchronously.
- **One listener.** `Chat::set_listener(Arc<dyn Listener>)` spawns a task that `select!`s over the store's `changes()` and the session's `events()` and calls `Listener::on_event(Event)` **on a tokio thread**. `Event` mirrors `SessionEvent` plus `Changed { rooms, rids }`; a lagged store receiver becomes `Event::Resync`, lagged session events are dropped. Before forwarding, the task saves the E2E key to the keychain on `E2e` and, on `Expired`, removes the account and deletes its database file. A new `set_listener` replaces the previous task.

### Shared accounts

`accounts.rs` writes exactly where `rv-gtk` does on macOS: Keychain items through the `keyring` crate (service `me.barrut.RocketVibe`, account `<base URL>|<user id>`, a JSON secret that also carries the E2E key as a JWK while unlocked), and the `accounts`, `active-account` and `servers` files in `~/.config/rocket-vibe-rs`. `Dirs::glib` reproduces GLib's XDG resolution (absolute `XDG_*` variables, else `~/.config`, `~/.local/share`, `~/.cache`), so databases land in `~/.local/share/rocket-vibe-rs/<host>-<uid>.sqlite` for both apps. `load_all` puts the active account first. Footgun: Keychain access lists are per signed app, so the first time one app reads an item the other wrote, macOS asks once ("Always Allow").

## RocketVibeKit view models

All `@MainActor`; the models are `@Observable`.

- `Relay` implements the generated `Listener` protocol and re-posts each event with `DispatchQueue.main.async` + `MainActor.assumeIsolated`, preserving order. This is the only thread hop: everything after it runs on the main actor.
- `AppModel`: screen (`starting`, `login`, `chat`), accounts, room groups, connection state, E2E lock state, open `RoomModel` and thread `RoomModel`, folded sections (same `collapsed-sections` file as GTK), back/forward history, `imagesVersion` bumped on avatar changes. `start()` resumes the first account (the active one) or shows login. `handle(Event)` routes events; reloads go through `later(...)`, which collects them in a `Pending` and flushes once 25 ms later, because a busy server sends presence and message events in bursts that used to reload the list several times per frame. `onIncoming` and `onAttention` are hooks the app sets for notifications and the dock badge.
- `LoginModel`: server probe as the address is typed, credentials, then the 2FA code step.
- `RoomModel`: one room or one thread. `reload()` re-reads the store through rv-ffi and publishes only when the list differs (rows are `Equatable`, so unchanged rows are not redrawn); paging back, jump-to-message, drafts saved 400 ms after the last keystroke, send or run a slash command, quote, edit-last, typing and uploads.
- `MediaStore`: protected files and photos fetched once each through rv-ffi, shared by concurrent requests, forgotten on avatar changes.
- `VoiceModel` (RocketVibe servers offering voice, the sidecar shipped): the voice session, rings and listening choices read from rv-ffi on each `Event::Voice`, the cues and tones it derives (played by the app through `onVoiceCue`/`onVoiceTone`), the incoming ring, the room whose voice page shows (`shown`). See [voice](../features/voice.md#desktop).
- `AdminModel.swift`: the server administration (`AdminCategory`, `AdminText`, `AdminList` with its generation counter and 250 ms search debounce, `AdminModel`) and the report flow (`ReportTarget`, `ReportDraft`); `AppModel` holds `administrator` (asked at session start and when the settings open, since a context menu is built synchronously), `admin` and `reporting`. Over rv-ffi's `ServerAdmin` (`admin.rs`, from `Chat::admin()` / `NativeChat::admin()`). See [../features/administration.md](../features/administration.md).
- `Settings.swift`: `SettingsCategory` (the GTK app's categories and their visibility per account), `SettingsLayout` (85 % of the window clamped to 360 x 360 .. 1100 x 800, one pane under 640), and the `AppModel` extension that opens and closes the overlay ([../features/settings.md](../features/settings.md)).
- `Strings` reads the language saved by either app (`auto`, `fr`, `en`) and calls into the Rust catalog; `Formatting` formats times as the GTK app does.

## The SwiftUI app

`RocketVibeApp` is a SwiftPM `@main` executable (no Xcode project): a `Window` scene with `RootView` and, over it, the settings or the administration overlay (`SettingsOverlay`, `AdminOverlay`, both in the shared `PanelOverlay`) and the window's `ReportSheet` (the the `Settings` scene is gone, a `CommandGroup` replacing `.appSettings` binds Command-comma to `AppModel.openSettings`), `onOpenURL` for `rocketvibe://room/<rid>?host=`, the `Notifier` (`UNUserNotificationCenter`, click opens the message, inline Reply sends) and `NSApp.dockTile.badgeLabel` for attention. Notable views: `ChatView` (sidebar sections and account bar), `RoomView` (`ScrollView` + `LazyVStack` in a `ScrollViewReader`, `.contextMenu` actions, locked banner and unlock sheet, quote/file/link/call cards), `BodyView` (`AttributedString` from rv-ffi runs), `Composer` (an `NSTextView` wrapper with the system spell checker, staged chips, completion list, voice recording through `AVAudioRecorder` to AAC `.m4a` sent as `audio/mp4`), `PlayerView` (AVKit `VideoPlayer` on a local copy), `Player` (WKWebView for YouTube/Dailymotion/Vimeo links), `CallWindow` (WKWebView locked on the call's origin), `Details` (room info, profile, search, pinned/starred, emoji picker), `Pictures` (images decoded off the main thread at drawn size, cached), `Theme` (the night palette, Baloo 2 and Nunito via `ATSApplicationFontsPath`).

Differences from GTK that are by design: voice messages are AAC, not Ogg/Opus (AVFoundation does not write Opus; the mobile app sends AAC too); the system's Emoji & Symbols panel also works; there is no self-update (rv-ffi does not export `rv_core::update`).

## Build, test, package

- `scripts/generate.sh` (from `apps/desktop`): `cargo build --release -p rv-ffi --lib` with `MACOSX_DEPLOYMENT_TARGET=15.0`, then `uniffi-bindgen-swift --swift-sources --headers` on the dylib (`.so` on Linux), copying the header and Swift file into the package. Prints the target dir; callers export `RV_FFI_LIB_DIR` from it. `Package.swift` links `librv_ffi.a` by path (no xcframework: one arm64 target needs none, and it keeps the linker off the dylib beside it) plus Security, SystemConfiguration and CoreFoundation on macOS.
- `scripts/check-linux.sh` builds and tests every target but the app in `macos/docker/Dockerfile` (`swift:6.1-noble`), with its own cargo volume and `CARGO_TARGET_DIR=target/swift-linux`. `RV_TEST_SERVER` enables the live tests (`KitTests.testSignInOpenARoomAndSend`, and `cargo test -p rv-ffi --test live` on the Rust side).
- `scripts/package.sh <version>` builds the `RocketVibe` product in release, lays out `dist/rocket-vibe SwiftUI.app` (Info.plist, fonts, icon from `apps/mobile/assets/icon.png`), fails if the binary links anything under `/opt` or `/usr/local`, signs it (Developer ID with hardened runtime when `MACOS_SIGN_IDENTITY` is set, ad hoc otherwise) and builds `rocket-vibe-desktop-<version>-macos-swiftui-arm64.dmg`. The bundle carries no GTK, GStreamer or fontconfig. It carries the voice sidecar (`$RV_VOICE`, else `apps/desktop/dist/voice/rv-voice`, into `Contents/MacOS`, signed with the app's entitlements; `RV_VOICE_REQUIRED=1` makes its absence an error) and the voice sounds, rendered by `scripts/sounds/generate.mjs` and encoded to AAC by `afconvert` into `Resources/sounds`.
- CI: `.github/workflows/desktop-swiftui.yml` on `macos-15`, triggered by feature-branch pushes touching `macos/` or `rv-ffi`, manual runs, and as a reusable workflow from `desktop.yml` on tags and manual runs (so a desktop release carries the SwiftUI DMG). It runs `swift build`, `swift test`, `swift run rv-rooms` (offline self-check), takes the `rv-voice-macos-arm64` artifact when `desktop.yml` calls it (`voice-artifact`) or builds the sidecar itself, packages, signs and notarizes, then launches the app: login screenshot, the sample-message gallery (`RV_SMOKE_GALLERY=1`, no server), a 45 s soak that must log "soak survived", and a 400-row scroll benchmark (`RV_SMOKE_SCROLL=1`) reported in the job summary as a trend, not a gate.

## Status

On master. [Parity](../parity.md) tracks it as its own column: it matches the GTK app except where that table says otherwise. Proven: rv-ffi and the view models against the test server (from Rust and from Swift on Linux), and on CI's Mac runner the build, signature, notarization, launch, gallery and soak. Not yet proven: the SwiftUI screens against a real server on a real Mac, which is the testers' beta. Keeping both UIs in step is the standing cost: every visible desktop feature lands in `rv-gtk` and in `macos/`, with the logic kept in `rv-core` so both stay thin.

## Sources

- apps/desktop/crates/rv-ffi/Cargo.toml
- apps/desktop/crates/rv-ffi/src/lib.rs
- apps/desktop/crates/rv-ffi/src/accounts.rs
- apps/desktop/crates/rv-ffi/src/model.rs
- apps/desktop/crates/rv-ffi/src/context.rs
- apps/desktop/crates/rv-ffi/src/markup.rs
- apps/desktop/crates/rv-ffi/src/reactions.rs
- apps/desktop/crates/rv-ffi/src/admin.rs
- apps/desktop/crates/rv-ffi/src/people.rs
- apps/desktop/crates/rv-ffi/src/writing.rs
- apps/desktop/crates/rv-ffi/src/native_voice.rs
- apps/desktop/crates/rv-ffi/src/bin/uniffi-bindgen-swift.rs
- apps/desktop/crates/rv-ffi/tests/live.rs
- apps/desktop/crates/rv-gtk/src/macos.rs
- apps/desktop/macos/Package.swift
- apps/desktop/macos/.gitignore
- apps/desktop/macos/data/Info.plist
- apps/desktop/macos/docker/Dockerfile
- apps/desktop/macos/scripts/generate.sh
- apps/desktop/macos/scripts/check-linux.sh
- apps/desktop/macos/scripts/package.sh
- apps/desktop/macos/Sources/RocketVibeKit/
- apps/desktop/macos/Sources/RocketVibeKit/Settings.swift
- apps/desktop/macos/Sources/RocketVibeKit/AdminModel.swift
- apps/desktop/macos/Sources/RocketVibe/AdminView.swift
- apps/desktop/macos/Sources/RocketVibe/RocketVibeApp.swift
- apps/desktop/macos/Sources/RocketVibe/SettingsView.swift
- apps/desktop/macos/Sources/RocketVibe/
- apps/desktop/macos/Sources/rv-rooms/main.swift
- apps/desktop/macos/Tests/RocketVibeKitTests/KitTests.swift
- apps/desktop/docs/MACOS-SWIFTUI.md
- .github/workflows/desktop-swiftui.yml
- .github/workflows/desktop.yml
