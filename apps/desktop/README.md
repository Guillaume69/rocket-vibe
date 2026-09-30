# rocket-vibe desktop

Desktop Rocket.Chat client in Rust: GTK 4 + libadwaita on top of a UI-free
protocol core. It ports the mobile app's `lib/` (`../mobile`), whose tests are
the spec. Commands below run from `apps/desktop/`; the Rocket.Chat test server
is the repository's `docker/`, seeded by its `scripts/seed.mjs`.

## Build

Everything builds in a Fedora 44 container (cargo registry cached in the
`rv-cargo` volume), so the host needs no Rust or GTK headers:

```sh
scripts/build.sh                  # fmt check, clippy -D warnings, tests, build
PROFILE=release scripts/build.sh
```

The container ships the same GTK 4.22 and libadwaita 1.9 as a Fedora 44 host,
so the binary runs natively:

```sh
./target/debug/rocket-vibe-gtk
```

The session token lives in the Secret Service (KWallet or GNOME Keyring),
never on disk.

What the Android app does and where this one stands: `docs/PARITY.md`.

An experimental [native-server pilot](../../docs/NATIVE_DESKTOP_PILOT.md) is also
available: discovery selects Rocket.Chat or RocketVibe per account in the same
GTK chat interface, with an isolated native cache, durable outbox and drafts. The Rust engine is exposed
through an explicit UniFFI API; its SwiftUI screens are not connected yet.

## Desktop integration

Calls open in a window of the app, locked on the meeting's origin: WebView2 on
Windows (the Edge runtime Windows 10 and 11 carry; the package ships its loader,
`WebView2Loader.dll`), WKWebView on macOS (camera and microphone entitlements and
usage strings in the bundle). Linux distributions build WebKitGTK without WebRTC,
so there a call opens as an app window of Chromium, Chrome, Brave, Edge or
Vivaldi (`--app`, with its own profile in the data folder) when one is on the
PATH, and in the default browser otherwise. The call card's info button gives
the meeting link without the joiner's token.

On Windows, the installer from CI (`rocket-vibe-desktop-<version>-windows-x86_64-setup.exe`,
built from `data/windows/rocket-vibe.iss`) installs for the current user, adds a Start
menu entry and registers `rocketvibe://` links. On Windows the app is not
single-instance (that goes through D-Bus), so a link opens a second window;
text goes through fontconfig, which avoids a cairo abort and keeps the bundled
fonts; warnings go to `%LOCALAPPDATA%\rocket-vibe-rs\rocket-vibe.log` when the
app has no console, the previous run's in `rocket-vibe.previous.log` beside it. On every
system a panic is appended to `crash.log` in the same cache folder, with its backtrace;
Settings, About shows the folder and opens it.

On macOS, the DMG from CI holds `rocket-vibe.app` (Apple Silicon, macOS 15 or later),
built by `scripts/package-macos.sh`: GTK, libadwaita, GStreamer and their libraries
inside, `rocketvibe://` declared. The binary itself points GTK, GStreamer and
fontconfig at the bundle (`crates/rv-gtk/src/macos.rs`): under the hardened runtime,
permissions such as the microphone belong to the signed executable. Text goes through
fontconfig, which loads the bundled fonts, and drawing through GTK's software
renderer, which draws emoji where its OpenGL renderer did not (`GSK_RENDERER=gl` to
compare). With `MACOS_SIGN_IDENTITY` the script signs with that Developer ID
(hardened runtime, `data/macos/entitlements.plist`); CI then has Apple notarize the DMG
and staples the ticket, so it opens without any prompt. Without an identity it signs
ad-hoc, and the app needs one "Open Anyway" in Privacy & Security the first time.

On Linux, the AppImage runs on any distribution, old ones included, and needs
nothing installed: to install it for the current user (no root), with a launcher
entry, its icon and `rocketvibe://` links, and to update it later:

```sh
curl -fsSL https://raw.githubusercontent.com/Guillaume69/rocket-vibe/master/apps/desktop/scripts/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/Guillaume69/rocket-vibe/master/apps/desktop/scripts/install.sh | sh -s -- --uninstall
```

The script (`scripts/install.sh`, curl or wget) takes the newest `desktop-v*`
release's `rocket-vibe-desktop-<version>-linux-x86_64.AppImage` into
`~/.local/bin/rocket-vibe.AppImage`; the app's update card then replaces that file in
place. The AppImage is built by `scripts/package-appimage.sh`, in pkgforge-dev's Arch
Linux image (`scripts/appimage-build.sh`): Anylinux's quick-sharun gathers the binary
with every library it loads, glibc and its loader included, GTK, libadwaita, GStreamer
with its codecs (H.264 and AAC through libav, Opus and Ogg for voice messages), Mesa,
the Adwaita icons, the Hunspell dictionaries and Noto Color Emoji; its runtime mounts
it with FUSE when there is one, and otherwise runs it from namespaces or a temporary
extraction. A bug report from the AppImage therefore runs the same libraries everywhere.
Uninstalling leaves the accounts and messages in `~/.config/rocket-vibe-rs` and
`~/.local/share/rocket-vibe-rs`.

The release also carries a tarball of the bare binary, which uses the system's
libraries: GTK 4.12 and libadwaita 1.6 or later, Pango 1.56, and a C library as recent
as Fedora 44's (a rolling distribution: Arch, Fedora). From a checkout:

```sh
PROFILE=release scripts/build.sh
scripts/install-desktop.sh        # launcher entry, rocketvibe:// links
```

Run that way, voice messages record through the system's GStreamer: the host needs
its Opus, Ogg and PulseAudio or PipeWire plugins (Fedora ships them with a desktop
install). Video plays through GStreamer too: H.264, the most common format, needs a
decoder Fedora does not install by default, `gstreamer1-plugin-openh264` (Cisco's
repository, enabled on Fedora Workstation) or `gstreamer1-plugin-libav` (RPM Fusion);
Debian and Ubuntu ship `gstreamer1.0-libav`. Without one, a video card says it cannot
play the format and offers another application. The spell check reads the system's
Hunspell dictionaries (`fr_FR`, `en_US`: the `hunspell-fr` and `hunspell-en`
packages); the AppImage, Windows and macOS packages carry their own
(`scripts/fetch-dictionaries.sh`).

## Headless smoke run

Logs in, opens a room, optionally sends a message, saves a screenshot and
quits, under Xvfb in the build image:

```sh
scripts/smoke.sh http://localhost:3000 alice alice-dev-2026 test-public /tmp/shot.png "hello"
```

## Tests

| Level | What | Command |
|---|---|---|
| Unit | Pure logic: normalisation, store SQL, diff, media URLs, avatar hash | `scripts/build.sh` |
| Integration | REST, DDP and the outbox against fake HTTP and WebSocket servers | `scripts/build.sh` |
| End-to-end | The real app, headless, against the seeded bench: sends, receives live, sees a deletion; checks the server stored the send once | `scripts/e2e.sh` |

Coverage (cargo-llvm-cov, in the build image):

```sh
scripts/coverage.sh          # unit + integration (~43% of lines: the UI is out of their reach)
scripts/coverage.sh --e2e    # plus an instrumented end-to-end run (~88%)
HTML=1 scripts/coverage.sh --e2e
```

## Layout

| Crate / module | Role |
|---|---|
| `rv-core::normalize` | Rocket.Chat documents to local rows |
| `rv-core::rest` | REST: 401 discrimination, 2FA, 429 back-off, timeouts |
| `rv-core::ddp` | Listen-only DDP actor: login resume, ref-counted subs, silence watchdog |
| `rv-core::store` | SQLite (rusqlite): `_updatedAt`-arbitrated upserts, cursors, outbox, change broadcast |
| `rv-core::sync`, `outbox` | Stream and REST into SQLite; optimistic send with delivery check |
| `rv-core::session` | Login, wiring, reconnection with back-off |
| `rv-core::diff` | List refresh as splices, so views keep their scroll position |
| `rv-gtk` | libadwaita UI; tokio runs the core, GLib owns the main thread |

## Status

Password + TOTP login, session resume, rooms and subscriptions via cursors,
history paging, live messages and edits for every room through
`__my_messages__`, live deletions in the open room, optimistic send with
retry, read marking, reconnection with back-off, photo avatars and inline
images (click to enlarge).

Not yet: live avatar changes (`updateAvatar`; a changed photo shows after a
restart), markdown, non-image files beyond their name, threads view,
reactions, typing indicator, notifications, E2EE.
