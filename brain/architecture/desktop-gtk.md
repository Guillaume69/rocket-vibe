# Desktop GTK app: rv-gtk and rv-native

`rocket-vibe-gtk` (`apps/desktop/crates/rv-gtk`) is the desktop UI on Linux, Windows and macOS: GTK 4 + libadwaita over `rv-core`, with `rv-native` filling in what GLib lacks on Windows and macOS. GTK owns the main thread; the core runs on a tokio runtime; a small bridge carries store changes and session events back to the main thread. This doc covers that structure, the threading model, media, and the packaging scripts.

Context: [desktop-app.md](desktop-app.md) (workspace, build container), [desktop-core.md](desktop-core.md) (what the UI calls), [desktop-macos.md](desktop-macos.md) (the SwiftUI alternative on macOS).

## Startup

`src/main.rs`, in order: crash log and log filter (`crashlog`, `logs`), the macOS bundle environment (`macos::bundle_environment`, before any thread exists), Windows standard streams and text backend, then an `adw::Application` with id `com.rocketvibe.app` and `HANDLES_OPEN`. It is single-instance through D-Bus everywhere but Windows, which has no session bus (GLib's attempt aborted the app), so there it is `NON_UNIQUE` and `rv_native::claim_instance` does the job: a second launch hands its `rocketvibe://` link to the first and exits. `RV_INSTANCE=<name>` gives an instance its own lock and hidden window, so named instances run beside the usual one (two accounts on one machine; their data folders through `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`). `connect_open` routes links to `AppWindow::open_link`. The window is created once (`window_of`), possibly hidden when started at login (`background::start_hidden`).

## Structure

| Module | What it holds |
|---|---|
| `window` | `AppWindow`: a `gtk::Stack` of the login page and the chat page; owns the current `Arc<Session>`, starts and stops sessions, account switching and adding, logout, deep links, the bridge described below |
| `login` | `LoginPage`: server, user, password, then the 2FA code field when challenged |
| `secrets` | Accounts in the system keychain (Secret Service via `oo7` on Linux with a 5 s timeout, `keyring` elsewhere), the `accounts` / `active-account` / `servers` files |
| `chat` | `ChatPage`: an `adw::NavigationSplitView` with the room list (sections, folds, favourites menu), the open room, its header, the thread pane, upload strip, typing line, back/forward history |
| `message_list` | `MessageList`: a `gtk::ListView` over a `gio::ListStore` of `BoxedAnyObject`-wrapped `timeline::Display` rows, shared by rooms and threads; scroll pinning, "jump to latest", reveal-a-message, the detached mode of a context window, cross-message text selection |
| `rows` | Builds one room row or one message row widget from store rows |
| `markdown_view`, `cards`, `video`, `player`, `media` | Message bodies from `rv-core` markdown blocks, attachment and link cards, video attachments, embedded YouTube/Dailymotion/Vimeo, protected images as GDK textures (fetched and decoded once, shared by every row asking) |
| `composer`, `staged`, `attach`, `emoji_picker`, `spell`, `recorder` | The message field (Enter sends, Shift+Enter breaks), staged files with captions and image quality, pick/drop/paste, emoji picker, Hunspell spell check, voice recording to Ogg/Opus |
| `actions_menu`, `reactions`, `marked`, `details`, `spotlight`, `thread`, `unlock` | Message actions menu, its quick reactions (my most used per account, then "+" to the picker), pinned/starred dialog, room info / profiles / search, new conversation, thread page, the E2E password prompt |
| `sidebar_dialog`, `settings`, `admin` | `SidebarDialog`, the large modal with clickable categories (85 % of the window, at most 1100 x 800, one pane under 640 sp; Escape, close button or backdrop click close it) and its `Host`; the settings in categories ([../features/settings.md](../features/settings.md)); the server administration and the Report dialog ([../features/administration.md](../features/administration.md)) |
| `notifier`, `badge`, `background`, `call_window`, `updater` | Notifications, unread badge, tray/dock life, call windows, self-update |
| `chat_voice`, `sounds`, `settings/voice` | Native voice sessions on the chat page (`VoiceUi`: who is in each room's session under its row, the voice page, the "Voice connected" panel, the ring dialog, cues), the voice sounds of `assets/sounds` played through GStreamer's `playbin` (one-shot cues; the ringtone and ringback looped while their `Player` lives), the microphone and speaker choice. See [../features/voice.md](../features/voice.md) |
| `style`, `widgets`, `fonts`, `icon`, `sizer`, `i18n` | The "Nuit Étoilée" theme over libadwaita's dark style, the Android kit's widgets (gradient avatars, pills, the sync comet, `close_on_backdrop`, which turns a click on an `adw::Dialog`'s dimmed backdrop into a close instead of a window drag), bundled fonts and icon, language choice |
| `smoke` | The unattended run driven by `RV_SMOKE_*` variables (`smoke/admin.rs` walks the administration), and the sample-message gallery |
| `macos`, `windows`, `focus`, `crashlog`, `logs`, `bundle` | Platform start-up fixes and where packaged data lives |

### How a list refreshes

`ChatPage::on_change(&Change)` reloads the room list when `change.rooms` is set, and the open room (plus its uploads and read mark) or the open thread when their rid is in `change.rids`. Reloading reads the store synchronously (`session.store.messages(rid, limit)`) and hands the rows to `MessageList::set_rows`, which groups them (`timeline::group`), places the unread marker, diffs against the previous rows with `rv_core::diff::diff_sorted` keyed on `(ts, id)`, and applies the result as `ListStore::splice` calls. Splicing instead of replacing keeps the scroll position and untouched widgets. When the list is pinned to the bottom it scrolls again 120 ms later, after GTK re-measures the inserted rows.

Footgun: the list factory's `bind` builds a brand-new widget tree for each row it binds (`rows::message_widget`); nothing is reused from `setup`. Anything a row shows that does not come from its data (presence, photos, the E2E lock) needs an explicit `rebind()` or `load_rooms(force)`, which is what `on_avatar`, `on_presence` and `on_e2e` do. It is also the cost the SwiftUI app was started to avoid on macOS.

### How voice changes reach the UI

Voice has two sources, kept apart. **Who is connected** to any room and the **rings** come from the live snapshot (`NativeSession::voice_participants`, `rings`), so they arrive with the native session's ordinary refresh, which calls `ChatPage::refresh_voice`. **This device's session** (state, microphone, who speaks) comes from the `VoiceController` snapshot: `follow_voice` (on `set_native_session`) forwards `voice().changes()` from tokio through a one-slot `async_channel` (a full slot means a wake-up is already pending; the snapshot is read when handled), and `on_voice_change` plays the cues, then compares the snapshot's `shape` (room, state, microphone, deafen, who is muted). A changed shape rebuilds what voice shows (`refresh_voice`: occupants under the bound rows, the panel, the voice page keyed so an identical page is not redrawn, the header's call button, rings); a speaking tick, about ten a second, only toggles the `speaking` class on the registered avatar frames and cards (`VoiceUi::light`). `VoiceUi::reset` drops everything of the previous account. Call rows (`rv-call-<state>`) are message rows: `cards::voice_call` shows the outcome and Join or Call back, which sends `RowEvent::VoiceCall` to `ChatPage::voice_call_back`.

## Threading model

- One tokio runtime for the process (`main::runtime()`, multi-thread, 2 workers), created lazily. UI code runs in `glib::spawn_future_local` futures on the main thread and hops over with `on_tokio(future).await`, which spawns on tokio and awaits the join handle. `Session::start` is called with `runtime().enter()` held.
- **The bridge** (`AppWindow::start_session`): a tokio task `select!`s over `session.store.changes()` and `session.events()` and pushes `UiEvent`s into an `async_channel`; a main-thread future drains it and calls `ChatPage` (`on_change`, `set_connection`, `on_typing`, `on_presence`, `on_upload`, `on_avatar`, `on_private`, `on_e2e`) or the notifier. A lagged store receiver becomes `UiEvent::Resync` (reload everything); lagged session events are skipped. `SessionEvent::Expired` stops the session, deletes the account's database (and its `-wal`/`-shm`), removes its keychain item and shows the login page with "expired"; another signed-in account takes over when there is one.
- Store reads happen on the main thread, synchronously, through the store's mutex (see [desktop-core.md](desktop-core.md#async-model)).
- `rv-native` never touches GTK. Its callbacks arrive on the system's thread and are re-posted with `glib::MainContext::default().invoke` (e.g. `notifier::native_event`). The Windows call window and shell window live on GTK's thread: GTK's message loop dispatches their window messages. On macOS, GTK's run loop is AppKit's main run loop, which is what lets `rv-native` drive WKWebView and NSWindow there.
- Session switching: `stop_session` aborts the bridge task, clears the media cache, calls `Session::shutdown`; the new session gets a new bridge.

## rv-native per platform

`rv-native/src/lib.rs` exposes one API; `windows_*` and `macos_*` modules implement it and an `other` module makes every call a no-op on Linux (`available()` false).

| Piece | Windows | macOS |
|---|---|---|
| Notifications (`init`, `show`, `withdraw`, `delivered`) | WinRT toasts, the app id registered under HKCU so an unpackaged app may toast; one toast per room (tag hashed to 64 chars), inline reply | `UNUserNotificationCenter` with a reply action; only inside a bundle (it throws otherwise), so `available()` is false in a development run |
| Badge | Taskbar badge | Dock tile |
| Shell (`tray`, `app_events`, `claim_instance`, `autostart`) | A hidden window: notification-area icon and menu, single instance (a second launch forwards its link), login entry in the `Run` key | Dock reopen (the method is added to GTK's app delegate class, which leaves it unanswered), launch agent for start at login |
| Call window (`call_window`) | WebView2 in a window of its own | WKWebView in an NSWindow |
| Inline video player (`player`) | WebView2 in a child window laid over the card, clipped to the list, page served from a folder under a host name of ours | WKWebView in a view of the app window laid over the card, page loaded with a base address of ours |

The player is laid over the card on every frame because a GTK window cannot hold a native view among its widgets. On Linux, `player.rs` puts a `webkit6::WebView` (ephemeral session) inside the card instead. Every engine loads `rv_core::player::page`, served from `https://player.rocket-vibe.invalid`, because YouTube refuses an embed without a Referer (error 153). Navigation goes through `rv_core::player::navigation`.

Notifications: on Linux `notifier.rs` talks to `org.freedesktop.Notifications` over the session bus (click opens the room; `inline-reply` where the server offers it, e.g. KDE Plasma). Without a session bus (Windows, macOS) it uses `rv-native` when `available()`, else GLib's `gio::Notification` (click, no reply). The Linux badge goes through the Unity launcher protocol (`com.canonical.Unity.LauncherEntry`), which KDE Plasma, Dash to Dock and Plank read; it has no dot.

Calls on Linux: distributions build WebKitGTK without WebRTC, so `call_window.rs` opens the meeting as a Chromium-family `--app` window (own profile in the data folder) when one is on the PATH, otherwise in the default browser with a toast. Origin locking uses `rv_core::call`. See [../features/calls.md](../features/calls.md).

## Video and audio through GStreamer

Video and audio attachments are downloaded to a local file first (protected files need the token), then played by `gst_stream::for_file`:

- GTK's own `gtk::MediaFile` when GTK has a media backend;
- otherwise `GstStream`, a `gtk::MediaStream` subclass wrapping GStreamer's `playbin` with an `AppSink` (RGBA) whose frames become GDK textures, so `gtk::Picture` and `gtk::MediaControls` use it like GTK's own. This covers Homebrew's GTK on macOS, which has no media backend, and Windows.

`GstStream` is forced when `RV_MEDIA_BACKEND=gstreamer`, and whenever `video_on_cpu()` is true: `RV_SOFTWARE_VIDEO=1`, or Linux with `/proc/driver/nvidia/version` present. Under NVIDIA's own driver the GL path crashed GTK's renderer while drawing GTK's GPU frames, and WebKit's GPU path drew video black, so the WebKit player also turns hardware acceleration off there. Without a decoder for the format (H.264 needs openh264 or libav on Fedora), the video card says it cannot play it and offers another application. Voice messages record through GStreamer to Ogg/Opus (`recorder.rs`). Details: [../features/media-playback.md](../features/media-playback.md), [../features/voice-messages.md](../features/voice-messages.md).

## macOS specifics of the GTK build

`macos.rs` points GTK, GLib, gdk-pixbuf, GStreamer and fontconfig at the bundle's `Resources` from inside the binary, not a launcher script: under the hardened runtime, permissions such as the microphone attach to the signed executable. It defaults `PANGOCAIRO_BACKEND=fc` (CoreText cannot load the app's own fonts) and `GSK_RENDERER=cairo`, because GTK's OpenGL renderer drew emoji as `?` and crawled without a real GPU. That software rendering is the root of the lag testers reported, and the reason for [desktop-macos.md](desktop-macos.md).

## Packaging

Release assets are named `rocket-vibe-desktop-<version>-<platform>`; `rv-core::update::Platform::asset_suffix` must match them for self-update ([../features/desktop-updates.md](../features/desktop-updates.md)).

| Asset | Built by | How |
|---|---|---|
| `-linux-x86_64.tar.gz` | CI `linux` job | Release binary, `rv-voice` and `rv-screen-audio` beside it, `.desktop` file, icons, README. Uses the host's libraries (GTK 4.12+, libadwaita 1.6+, Pango 1.56, WebKitGTK 6.0, a recent glibc) |
| `-linux-x86_64.AppImage` | `scripts/package-appimage.sh` runs `scripts/appimage-build.sh` in `ghcr.io/pkgforge-dev/archlinux` | Builds against Arch's libraries into `target/appimage`, installs under `/usr`, then Anylinux's `quick-sharun` gathers the binary and every library it loads, glibc and loader included, with GTK, GStreamer (`DEPLOY_GSTREAMER=1`), Mesa and the Adwaita icons; dictionaries and Noto Color Emoji are added. `rv-voice` and `rv-screen-audio` are wrapped by sharun like the app (`AppDir/bin/`, with PulseAudio and PipeWire through `DEPLOY_PULSE=1`, `DEPLOY_PIPEWIRE=1`), found under `$SHARUN_DIR` since the app's current executable is sharun's loader. Runs on any distribution. `scripts/install.sh` installs it to `~/.local/bin/rocket-vibe.AppImage` with a launcher entry and `rocketvibe://` handler |
| `-windows-x86_64.zip`, `-windows-x86_64-setup.exe` | `scripts/package-windows.sh` in an MSYS2 UCRT64 shell, then Inno Setup (`data/windows/rocket-vibe.iss`) in CI | A folder with the exe, `WebView2Loader.dll`, every UCRT64 DLL `ldd` finds, `rv-voice.exe` (MSVC, static C runtime), selected GStreamer plugins (Media Foundation decodes H.264 and AAC), gdk-pixbuf loaders, fontconfig config, schemas, icons, dictionaries, emoji font. The installer is per user, adds a Start menu entry and registers `rocketvibe://` |
| `-macos-arm64.dmg` | `scripts/package-macos.sh` on macOS with Homebrew's gtk4, libadwaita, gstreamer and `dylibbundler` | `rocket-vibe.app` with its libraries copied into `Frameworks`, data into `Resources` and `rv-voice` in `Contents/MacOS` (signed with the same entitlements); signed with `MACOS_SIGN_IDENTITY` (Developer ID, hardened runtime, `data/macos/entitlements.plist`) or ad hoc. CI notarizes and staples, then starts the bundled app with `/opt/homebrew` moved aside, so a library still taken from Homebrew fails the job |

Every package carries the `rv-voice` sidecar next to the app's executable, else the app offers no voice: CI's `voice` job calls `.github/workflows/desktop-voice.yml` (Linux in `ubuntu:22.04`, glibc 2.35; `rv-screen-audio`, the screen's sound through PipeWire, on Ubuntu 24.04 for its headers, glibc 2.34), and each packaging job downloads the artifacts into `dist/voice/`, where the scripts look by default (`RV_VOICE` overrides; `RV_VOICE_REQUIRED=1` makes a missing sidecar fatal, as in CI). Locally, `voice/scripts/build-linux.sh` and `build-screen-audio-linux.sh` leave them there ([apps/desktop/voice/README.md](../../apps/desktop/voice/README.md)).

From a checkout, `scripts/install-desktop.sh` registers the release build with the desktop. Release flow and CI gating: [../operations.md](../operations.md).

## Sources

- apps/desktop/crates/rv-gtk/Cargo.toml
- apps/desktop/crates/rv-gtk/src/main.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/message_list.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-gtk/src/reactions.rs
- apps/desktop/crates/rv-gtk/src/sidebar_dialog.rs
- apps/desktop/crates/rv-gtk/src/settings.rs
- apps/desktop/crates/rv-gtk/src/admin.rs
- apps/desktop/crates/rv-gtk/src/widgets.rs
- apps/desktop/crates/rv-gtk/src/secrets.rs
- apps/desktop/crates/rv-gtk/src/notifier.rs
- apps/desktop/crates/rv-gtk/src/badge.rs
- apps/desktop/crates/rv-gtk/src/background.rs
- apps/desktop/crates/rv-gtk/src/call_window.rs
- apps/desktop/crates/rv-gtk/src/player.rs
- apps/desktop/crates/rv-gtk/src/video.rs
- apps/desktop/crates/rv-gtk/src/gst_stream.rs
- apps/desktop/crates/rv-gtk/src/recorder.rs
- apps/desktop/crates/rv-gtk/src/macos.rs
- apps/desktop/crates/rv-gtk/src/smoke.rs
- apps/desktop/crates/rv-gtk/src/chat_voice.rs
- apps/desktop/crates/rv-gtk/src/chat_native.rs
- apps/desktop/crates/rv-gtk/src/sounds.rs
- apps/desktop/crates/rv-gtk/src/settings/voice.rs
- apps/desktop/crates/rv-gtk/src/cards.rs
- apps/desktop/crates/rv-native/Cargo.toml
- apps/desktop/crates/rv-native/src/lib.rs
- apps/desktop/crates/rv-native/src/windows_impl.rs
- apps/desktop/crates/rv-native/src/windows_shell.rs
- apps/desktop/crates/rv-native/src/windows_call.rs
- apps/desktop/crates/rv-native/src/windows_player.rs
- apps/desktop/crates/rv-native/src/macos_impl.rs
- apps/desktop/crates/rv-native/src/macos_shell.rs
- apps/desktop/crates/rv-native/src/macos_call.rs
- apps/desktop/crates/rv-native/src/macos_player.rs
- apps/desktop/crates/rv-core/src/player.rs
- apps/desktop/crates/rv-core/src/update.rs
- apps/desktop/scripts/package-appimage.sh
- apps/desktop/scripts/appimage-build.sh
- apps/desktop/scripts/package-windows.sh
- apps/desktop/scripts/package-macos.sh
- apps/desktop/scripts/install.sh
- apps/desktop/scripts/install-desktop.sh
- apps/desktop/data/windows/rocket-vibe.iss
- .github/workflows/desktop.yml
- .github/workflows/desktop-voice.yml
- apps/desktop/voice/scripts/build-linux.sh
