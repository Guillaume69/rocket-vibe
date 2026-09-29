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
RocketVibeMac (Swift, new)      SwiftPM package in macos/:
  rv_ffiFFI                       C target: rv-ffi's header, its static library linked by path
  RocketVibeCore                  the generated Swift bindings
  RocketVibeKit                   view models (sign-in, rooms, a room, media); builds on Linux too
  RocketVibe                      the SwiftUI app: views, notifications, dock
  rv-rooms                        a command line that signs in and lists the rooms
rv-gtk  (Rust, unchanged)       Linux and Windows
```

### What moves into rv-core first

Some display rules lived in rv-gtk and would otherwise be written twice. They
moved to rv-core as mechanical steps before rv-ffi exposed them: the grouping
of a message list (`timeline`: header, day separator, time in the gutter, the
"new messages" marker), the room avatar rule (`media::room_avatar_path`), and
the French and English catalog (`i18n`). The catalog was first meant to be
copied into Swift string catalogs; it is plain data, a copy would drift, so
both UIs read the one table (Swift through rv-ffi's `t`, `tf`, `tn`). The
language choice stays per UI, in the same `language` file.

### rv-ffi

- UniFFI with proc-macros (`#[uniffi::export]`, `#[derive(uniffi::Record)]`),
  no UDL file.
- rv-ffi keeps one multi-threaded tokio runtime for the process. Its async
  methods spawn their work there and await the `JoinHandle`, which any
  executor can poll: Swift's, or a plain `block_on` in the Rust tests. UniFFI's
  own `async_runtime = "tokio"` is not used: it would run futures on a
  runtime of its own, beside the one `Session::start` spawned its tasks on.
  Swift sees `async throws`.
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
- A SwiftUI context menu builds its items synchronously: `prepare_actions`
  reads the server's settings and my room permissions when a room opens, and
  `actions` answers from them at once.
- Accounts stay where the GTK app keeps them, written by Rust, not by Swift's
  `Security` framework: the `keyring` crate's Keychain items (service
  `me.barrut.RocketVibe`, account `<base URL>|<user id>`, a JSON secret), the
  `accounts` index and `active-account` file in `~/.config/rocket-vibe-rs`,
  and one database per account in
  `~/.local/share/rocket-vibe-rs/<host>-<user id>.sqlite`: GLib has no macOS
  case for its user directories, so rv-gtk uses the XDG ones there too, and
  rv-ffi computes the same. A GTK install and
  a SwiftUI install then share sessions and caches. The Keychain asks once
  ("Always Allow") when one app reads an item the other wrote: its access
  list is per signed app. Since the e2ee merge the item also carries my E2E
  key while unlocked (`e2eKey`): rv-ffi restores it at start and writes it
  back when the lock changes, as rv-gtk does.

### Build

- `macos/scripts/generate.sh` builds rv-ffi (release) and runs
  `uniffi-bindgen-swift` (library mode, rv-ffi's own binary) for the Swift
  file and C header, written into the package (gitignored).
- The package's `rv_ffiFFI` C target links `librv_ffi.a` by path. No
  xcframework: one arm64 target needs none, and linking by path keeps the
  linker from picking the dylib built beside it.
- `macos/scripts/check-linux.sh` builds and tests every target but the
  SwiftUI app in a Swift container on Linux, with rv-ffi built there too.
- `macos/scripts/package.sh` lays out the `.app` (Info.plist, icon,
  entitlements) around the built executable, signs it and packs the DMG. No
  Xcode project to maintain by hand; SwiftUI's `@main` app runs from a
  SwiftPM executable. During the beta it is its own app, `rocket-vibe
  SwiftUI` (`com.rocketvibe.app.swiftui`), installable beside the GTK one.
- CI: `.github/workflows/desktop-swiftui.yml` on a macOS runner (tags,
  manual runs, feature branches touching it): tests, the CLI's self-check,
  package, the same Developer ID signing and notarization as the GTK bundle,
  screenshots of the login screen and of sample messages
  (`RV_SMOKE_GALLERY=1`, no server needed), and a 45-second soak.
- No GTK, GStreamer or fontconfig in the bundle any more: a far smaller app.

### SwiftUI side, screen by screen

| GTK module today | SwiftUI |
|---|---|
| `login.rs` | `LoginView`: server probe, credentials, 2FA step |
| `window.rs`, `chat.rs` (split view) | `NavigationSplitView`: sidebar and room |
| room list, sections, badges | `List` with `Section(isExpanded:)`, folds kept in the same `collapsed-sections` file |
| `message_list.rs`, `rows.rs` | `ScrollView` + `LazyVStack`, rows as views, `ScrollViewReader` for jumps and the latest-messages button |
| `markdown_view.rs` | `AttributedString` built from rv-core's markdown blocks |
| `composer.rs`, `staged.rs` | an `NSTextView` wrapper (the system spell checker, Return sends), chips above it |
| `cards.rs`, `video.rs` | link cards, AVKit's `VideoPlayer` for audio and video (a local copy first: protected files need the token) |
| `actions_menu.rs` | `.contextMenu` on rows, edit in place, a confirmed delete |
| `unlock.rs` | a banner on a locked encrypted room, an unlock sheet |
| `details.rs`, `settings.rs`, `spotlight.rs`, `marked.rs` | sheets and `Settings` scene |
| `notifier.rs`, `badge.rs` | `UNUserNotificationCenter` with a reply action; `NSApp.dockTile.badgeLabel` |
| `recorder.rs` | `AVAudioRecorder` to AAC in `.m4a` (`audio/mp4`), as the Android app sends |

What comes for free: native scrolling and text input, the system spell checker
and text services, notification actions (click to the message, inline reply),
the dock badge, and Retina rendering on the GPU.

## Status (2026-09-29)

Phases 1 to 4 are built, on the branch `feature/macos-swiftui`, and phase
5's parity: every item of `docs/PARITY.md` (room info, profiles, search,
pinned and starred, calls, completion, the emoji picker, the staged-file
preview, my profile, the notification preference...). What is proven, and
where:

- rv-ffi, against the test server from Rust and from Swift on Linux: sign-in
  (a wrong password refused), the room list, going online, send, react,
  actions, delete, media, drafts, sign-out.
- The app, on CI's macOS runner: it compiles, is signed with the Developer
  ID and notarized, starts on its sign-in screen, draws the sample messages
  (`RV_SMOKE_GALLERY=1`) and survives a 45-second soak.
- Not yet: the SwiftUI views against a real server on a Mac. The runner has
  none, and step 0 is still undone. Both are for the testers' beta.

Since the testers' first look (2026-09-30): the app wears the rocket-vibe
look (night palette, Baloo 2 and Nunito bundled, the wordmark, Android avatar
gradients, the pill composer, springs), and the stutter they felt was worked
on: pictures decode off the main thread at the size drawn and stay cached,
rows are Equatable so an unchanged message is not redrawn, bursts of listener
events reload once, and nothing animates while connected. The gallery times a
400-row scroll on CI (`RV_SMOKE_SCROLL=1`, one step per display frame): before,
8 frames of 1747 over 25 ms (max 42.7 ms); after, none of 2177 (max 16.7 ms).
The runner has no GPU and no server, so photos are not in that measure; how it
feels on a tester's Mac is still to be told.

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
   `docs/FEEDBACK.md` on a Mac, a beta for the testers. CI packaging and
   notarization are done: a desktop release carries the SwiftUI DMG.

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
- **Testing.** No Mac in CI's regular runs. rv-ffi is tested in Rust on
  Linux like rv-core, with a live test against the test server polled
  outside tokio; the view models get XCTest cases, run on Linux too, one of
  them live; the app itself is smoke-launched, screenshotted and soaked on
  the macOS runner. The SwiftUI views compile only there. XCUITest would need
  an Xcode project, which this plan avoids.
