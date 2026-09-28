# A SwiftUI app for macOS over rv-core

Testers find the macOS app laggy. This plans a native view layer in SwiftUI
on top of the existing Rust core, bound through UniFFI; the GTK app keeps
serving Linux and Windows. Nothing here is built yet.

## Why it lags today

On macOS the GTK app draws with GTK's **software** renderer:
`crates/rv-gtk/src/macos.rs` sets `GSK_RENDERER=cairo`, because the OpenGL
renderer drew emoji as `?` and crawled on a Mac without a real GPU (CI
runners). Every frame of a Retina window is then rasterised on the CPU, and
every scroll re-renders the rows. GTK on macOS also has no native scrolling
physics, text input or menus, which users feel even when frames are fast.

## Step 0: measure before rewriting (a day)

Cheap checks that tell how much of the lag a rewrite would really remove:

- Run a release build with `GSK_RENDERER=ngl` (then `vulkan` through MoltenVK
  if available) on the testers' Macs: frame times while scrolling a long room,
  typing, resizing. If `ngl` is smooth, the emoji problem (colour glyphs
  through the GL glyph cache) is the thing to fix, not the toolkit.
- Profile the cairo build with Instruments (Time Profiler): how much is
  rasterisation, how much is our own row building (`rows::message_widget`
  rebuilds whole rows on every bind).

If GL rendering with a working emoji path is enough, stop here. The rest of
this document is the plan if it is not.

## Architecture

```
rv-core (Rust, unchanged)       protocol, SQLite store, sync, outbox, uploads, E2EE
rv-ffi  (Rust, new crate)       a UniFFI façade over Session: records, async calls,
                                change and event streams
RocketVibe.xcframework          rv-ffi built for arm64 (and x86_64 if wanted),
                                with the generated Swift bindings
RocketVibeMac (Swift, new)      SwiftUI app: views, navigation, notifications, dock
rv-gtk  (Rust, unchanged)       Linux and Windows
```

### rv-ffi

- UniFFI with proc-macros (`#[uniffi::export]`, `#[derive(uniffi::Record)]`),
  no UDL file.
- Async methods run on tokio: `#[uniffi::export(async_runtime = "tokio")]`,
  so rv-core's futures keep their runtime. Swift sees `async throws`.
- Records mirror what the GTK UI reads today: `RoomRow`, `MessageRow`,
  `SessionInfo`, `Profile`, `Incoming`, `ServerSettings`, upload states. Where
  rv-core keeps JSON strings (attachments, reactions, `md`), rv-ffi hands out
  parsed records (`content::files`, `actions::reactions`, `markdown::render`)
  so Swift never parses Rocket.Chat documents.
- The store's `changes()` broadcast and the session's `events()` become one
  foreign callback interface (`trait Listener: Send + Sync`) that Swift
  implements and hops to `@MainActor`; an `AsyncStream` wraps it on the Swift
  side.
- The session token keeps living in the system keychain, written by Swift
  (`Security` framework) with the same service and account names as today, so
  a GTK install and a SwiftUI install share sessions.
- Size of the façade: `Session` has about 50 public methods; most map one to
  one.

### Build

- `cargo build --target aarch64-apple-darwin -p rv-ffi --release` into a
  static library, `uniffi-bindgen-swift` for the Swift file and module map,
  `xcodebuild -create-xcframework` to pack them.
- An Xcode project (or a SwiftPM package driven by `xcodebuild`) links the
  framework. CI's macOS job builds it instead of `scripts/package-macos.sh`,
  signs it with the same Developer ID and notarizes the DMG the same way.
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
| `recorder.rs` | `AVAudioRecorder` (Opus through an encoder, or AAC if the server accepts it) |

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
   the message, dock badge, `rocketvibe://` links, keychain sharing with the
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
- **Opus voice messages.** AVFoundation does not encode Opus; either link an
  encoder (libopus through rv-ffi) or send AAC, which the mobile app and
  Rocket.Chat both play.
- **Testing.** No Mac in CI's regular runs today (packages are built on
  tags); the SwiftUI app needs its own UI tests (XCUITest) on a macOS runner.
