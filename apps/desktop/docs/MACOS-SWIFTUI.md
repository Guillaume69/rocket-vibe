# A SwiftUI app for macOS over rv-core

Testers find the macOS app laggy. This plans a native view layer in SwiftUI
on top of the existing Rust core, bound through UniFFI; the GTK app keeps
serving Linux and Windows.

## Why it lags today

On macOS the GTK app draws with GTK's **software** renderer:
`crates/rv-gtk/src/macos.rs` sets `GSK_RENDERER=cairo`, because the OpenGL
renderer drew emoji as `?` and crawled on a Mac without a real GPU (CI
runners). Every frame of a Retina window is then rasterised on the CPU, and
every scroll re-renders the rows: the list factory's `bind` builds a whole new
row widget each time (`message_list.rs`, `rows::message_widget`), nothing is
kept from `setup`. GTK on macOS also has no native scrolling physics, text
input or menus, which users feel even when frames are fast.

## Step 0: measure before rewriting (a day, on a tester's Mac)

Cheap checks that tell how much of the lag a rewrite would really remove.
They need a Mac with a real GPU: CI's macOS runners have none, which is the
very reason cairo is forced.

- From Terminal, with the installed app:
  `GSK_RENDERER=ngl /Applications/rocket-vibe.app/Contents/MacOS/rocket-vibe-gtk`
  (then `GSK_RENDERER=vulkan` if MoltenVK is there). Add `GTK_DEBUG=interactive`
  to get the inspector, whose *Visual* page shows a frame-rate overlay:
  scroll a long room, type, resize. If `ngl` is smooth, the emoji problem
  (colour glyphs through the GL glyph cache) is the thing to fix, not the
  toolkit.
- Profile the cairo build with Instruments (Time Profiler): how much is
  rasterisation, how much is our own row building.

If GL rendering with a working emoji path is enough, the SwiftUI app can stop
at the phase it has reached. The build below went ahead without waiting for
step 0 (2026-09-29): its phases 1 and 2 are cheap next to the whole, and they
are what tells whether the rest is worth it.

## Architecture

```
rv-core (Rust)                  protocol, SQLite store, sync, outbox, uploads, E2EE,
                                and the display rules both UIs share
rv-ffi  (Rust, new crate)       a UniFFI façade over Session: records, async calls,
                                one listener for changes and events, accounts
RocketVibe.xcframework          rv-ffi built for arm64 (and x86_64 if wanted)
RocketVibeMac (Swift, new)      SwiftPM package in macos/: SwiftUI views,
                                notifications, dock
rv-gtk  (Rust, unchanged)       Linux and Windows
```

### What moves into rv-core first

Some display rules live in rv-gtk today and would otherwise be written twice:
the grouping of a message list (`rows::Display`: header, day separator, time
in the gutter, the "new messages" marker) and the day labels. They move to
rv-core as a mechanical step before rv-ffi exposes them. The French and
English strings (`i18n.rs`) stay per UI: SwiftUI has its own string catalogs,
and the keys are copied, not shared.

### rv-ffi

- UniFFI with proc-macros (`#[uniffi::export]`, `#[derive(uniffi::Record)]`),
  no UDL file.
- Async methods run on tokio: `#[uniffi::export(async_runtime = "tokio")]`.
  `Session::start` must itself run inside a runtime (it spawns its tasks), so
  rv-ffi keeps one multi-threaded runtime for the process and enters it
  there. Swift sees `async throws`.
- The façade is wider than `Session`'s 54 methods: rv-gtk also reads the store
  (`rooms`, `messages`, `thread_messages`, `uploads`, `draft`, `last_seen`),
  the media cache (`fetch`: protected files come back as bytes, so Swift never
  holds the token), the upload queue (`progress`, `retry`, `discard`), history
  paging (`sync.load_history`), and pure helpers (`rooms::sections`,
  `markdown`, `content::files`, `actions`, `emoji`, `compose`, `completion`,
  `links`). The helpers are what keep the Swift side thin.
- Records mirror what the GTK UI reads: `RoomRow`, `MessageRow`,
  `SessionInfo`, `Profile`, `Incoming`, `ServerSettings`, upload states. Where
  rv-core keeps JSON strings (attachments, reactions, `md`), rv-ffi hands out
  parsed records so Swift never parses Rocket.Chat documents.
- The store's `changes()` broadcast and the session's `events()` become one
  foreign callback interface (`trait Listener: Send + Sync`) that Swift
  implements and hops to `@MainActor`. Both are broadcast channels: a slow
  receiver gets `Lagged`, which rv-ffi turns into "everything changed" rather
  than dropping it.
- Accounts stay where the GTK app keeps them, written by Rust, not by Swift's
  `Security` framework: the `keyring` crate's Keychain items (service
  `me.barrut.RocketVibe`, account `<base URL>|<user id>`, a JSON secret), the
  `accounts` index and `active-account` file in GLib's config directory, and
  one database per account (`<host>-<user id>.sqlite`) in its data
  directory, each under `rocket-vibe-rs/`. Swift hands rv-ffi the same
  directories GLib gives rv-gtk on macOS. A GTK install and
  a SwiftUI install then share sessions and caches. The Keychain asks once
  ("Always Allow") when one app reads an item the other wrote: its access
  list is per signed app.

### Build

- `cargo build --target aarch64-apple-darwin -p rv-ffi --release` into a
  static library, `uniffi-bindgen` (library mode) for the Swift file and module
  map, `xcodebuild -create-xcframework` to pack them.
- A SwiftPM package (`macos/`) links the framework as a `binaryTarget`, and a
  script lays out the `.app` (Info.plist, icon, entitlements) around the built
  executable, as `scripts/package-macos.sh` does for GTK. No Xcode project to
  maintain by hand; SwiftUI's `@main` app runs from a SwiftPM executable.
  CI's macOS job builds it next to the GTK bundle, signs it with the same
  Developer ID and notarizes the DMG the same way.
- No GTK, GStreamer or fontconfig in the bundle any more: a far smaller app.

### SwiftUI side, screen by screen

| GTK module today | SwiftUI |
|---|---|
| `login.rs` | `LoginView`: server probe, credentials, 2FA step |
| `window.rs`, `chat.rs` (split view) | `NavigationSplitView`: sidebar and room |
| room list, sections, badges | `List` with `Section`s, folding by `DisclosureGroup` |
| `message_list.rs`, `rows.rs` | `ScrollView` + `LazyVStack`, rows as views, `ScrollViewReader` for jumps and the latest-messages button |
| `markdown_view.rs` | `AttributedString` built from rv-core's markdown blocks |
| `composer.rs`, `staged.rs` | `TextEditor` (or an `NSTextView` wrapper for formatting and the system spell checker), chips above it |
| `cards.rs`, `video.rs` | link cards, `AVPlayerView` for video, `AVAudioPlayer` for voice |
| `actions_menu.rs` | `.contextMenu` on rows |
| `details.rs`, `settings.rs`, `spotlight.rs`, `marked.rs` | sheets and `Settings` scene |
| `notifier.rs`, `badge.rs` | `UNUserNotificationCenter` with a reply action; `NSApp.dockTile.badgeLabel` |
| `recorder.rs` | `AVAudioRecorder` to AAC in `.m4a` (`audio/mp4`), as the Android app sends |

What comes for free: native scrolling and text input, the system spell checker
and text services, notification actions (click to the message, inline reply),
the dock badge, and Retina rendering on the GPU.

## Phases

1. **rv-ffi skeleton** (about a week): login, session resume, room list
   records, the listener, an xcframework and a Swift command-line test that
   prints the rooms. Proves the toolchain and the tokio-in-FFI setup.
2. **Read-only app** (two weeks): sidebar, room view with markdown, images,
   quotes, reactions, threads; live updates through the listener.
3. **Writing** (two weeks): composer with outbox, staged uploads, edit and
   delete, reactions, formatting, drafts.
4. **Desktop integration** (a week): notifications with reply and deep link to
   the message, dock badge, `rocketvibe://` links, sessions shared with the
   GTK install.
5. **Parity and release** (two weeks): walk `docs/PARITY.md` and
   `docs/FEEDBACK.md`, CI packaging and notarization, a beta for the testers.

About two months for one developer, most of it in the room view and composer.

## Costs and risks

- **Two UIs to keep in step.** Every visible feature lands twice (GTK and
  SwiftUI). rv-core carrying the logic (as it already does for actions,
  formatting, markdown) keeps the UI layers thin; `PARITY.md` gains a macOS
  column.
- **FFI surface churn.** rv-core's API was shaped for rv-gtk; rv-ffi absorbs
  the differences so rv-core does not bend to Swift.
- **Threading.** Listener callbacks arrive on tokio threads; Swift must hop to
  the main actor before touching state. UniFFI's generated code is safe to
  call from any thread.
- **Voice messages.** AVFoundation does not write Ogg/Opus, which the GTK app
  records through GStreamer; the SwiftUI app records AAC in `.m4a`, the
  Android app's format, which Rocket.Chat's clients all play.
- **Testing.** No Mac in CI's regular runs (packages are built on tags and
  manual runs). rv-ffi is tested in Rust on Linux like rv-core; the Swift view
  models get XCTest cases in the package; the app itself is smoke-launched
  and screenshotted on the runner like the GTK bundle. XCUITest would need an
  Xcode project, which this plan avoids.
