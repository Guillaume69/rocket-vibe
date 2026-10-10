# Desktop app: crates, apps and build

The desktop client lives in `apps/desktop/`: one Cargo workspace of four crates (a UI-free protocol core, a GTK 4 + libadwaita app, a UniFFI facade, platform shims) plus a SwiftUI app for macOS in `apps/desktop/macos/` that sits on the same core. Everything Rust builds in a Fedora 44 container, so the host needs no Rust toolchain or GTK headers.

Read [overview.md](overview.md) first for where the desktop sits in the monorepo; the per-layer detail is in [desktop-core.md](desktop-core.md), [desktop-gtk.md](desktop-gtk.md) and [desktop-macos.md](desktop-macos.md).

## The workspace

`apps/desktop/Cargo.toml` declares a resolver-3 workspace with `crates/rv-core`, `crates/rv-ffi`, `crates/rv-gtk` and `crates/rv-native`. Shared package settings: edition 2024, one version for every crate (`version = "0.7.0"` at the time of writing, read by `node scripts/version.mjs desktop`), MIT licence. Workspace lints:

- `unsafe_code = "deny"`. The few files that need FFI opt out with a file-level `#![allow(unsafe_code)]`: the Windows and macOS modules of `rv-native`, plus `rv-gtk/src/macos.rs` (environment set before threads start), `rv-gtk/src/windows.rs` (standard streams) and `rv-gtk/src/focus.rs`. `rv-core` and `rv-ffi` hold no unsafe code.
- `clippy::all` at warn, turned into errors by `-D warnings` in `scripts/build.sh` and CI. `result_large_err` is allowed (`RestError` is a fat struct on purpose).

`rustfmt.toml` sets `max_width = 120` and `use_small_heuristics = "Max"`; `cargo fmt --check` is the first gate of every build.

## The four crates and the SwiftUI app

| Unit | Kind | Role |
|---|---|---|
| `rv-core` | lib | Protocol (REST, DDP), SQLite store, sync, outbox, uploads, E2EE, and every display rule both UIs share (timeline grouping, markdown, room sections, actions, i18n catalog). No UI dependency. A port of the mobile app's `lib/`, whose tests are its spec. |
| `rocket-vibe-gtk` (dir `rv-gtk`) | bin | The GTK 4 + libadwaita app: Linux, Windows, and a GTK build for macOS. Owns the main thread, runs `rv-core` on a tokio runtime. |
| `rv-native` | lib | Windows (WinRT, Win32, WebView2) and macOS (AppKit, UserNotifications, WKWebView) shims the GTK app needs where GLib falls short: toasts and badges, tray and single instance, start at login, call windows, the inline video player. No GTK dependency. On other systems every call is a no-op. |
| `rv-ffi` | lib (`lib`, `staticlib`, `cdylib`) + bin `uniffi-bindgen-swift` | A UniFFI facade over `rv-core::session::Session` and its helpers, for Swift. |
| `rv-voice-protocol` | lib | The JSON-lines contract between `rv-core` and the voice sidecar. Serde only. |
| `apps/desktop/voice` (`rv-voice`) | bin, **separate workspace** | The voice sidecar: LiveKit and the platform audio devices. Excluded from the main workspace because it links libwebrtc (MSVC only on Windows, clang 21 on Linux); `rv-core::voice` finds it next to the executable. See [voice](../features/voice.md). |
| `apps/desktop/macos` | SwiftPM package `RocketVibeMac` | The SwiftUI app (`RocketVibe`), its view models (`RocketVibeKit`), the generated bindings (`RocketVibeCore`), a CLI (`rv-rooms`) and XCTests. |

The crate directory `rv-gtk` builds a package named `rocket-vibe-gtk` with a binary of the same name: `cargo build -p rocket-vibe-gtk`, `target/<profile>/rocket-vibe-gtk`.

### Dependency direction

```
rocket-vibe-gtk ──> rv-core
        └────────> rv-native        (no rv-core, no GTK)
rv-ffi ──────────> rv-core
RocketVibeMac (Swift) ──> librv_ffi.a + generated Swift bindings
```

`rv-core` depends on nothing of ours. `rv-native` depends on nothing of ours either: it speaks in plain strings, `Rect`s and callbacks (`rv_native::Event`, `AppEvent`), and its events arrive "on whatever thread the system uses", so the caller hops to its own (see [desktop-gtk.md](desktop-gtk.md)). `rv-gtk` and `rv-ffi` never depend on each other; the two UIs share behaviour only through `rv-core`. When a display rule would otherwise be written twice it moves into `rv-core` (`timeline`, `media::room_avatar_path`, `i18n`, `runs`), which is why the core carries more than protocol code.

Key third-party picks per crate (exact versions in the crates' `Cargo.toml`, summarised in [../stack.md](../stack.md)):

- `rv-core`: tokio (multi-thread runtime), reqwest with rustls (no OpenSSL), tokio-tungstenite with webpki roots, rusqlite with the `bundled` SQLite, aws-lc-rs for E2EE crypto, `gif` for animated images.
- `rv-gtk`: gtk4 (feature `v4_12`), libadwaita (`v1_6`), pango (`v1_56`), gstreamer 0.24 (+ app, video), spellbook (Hunspell), async-channel; `oo7` (Secret Service) and `webkit6` on Linux only; `keyring` on Windows and macOS; `gdk4-win32` on Windows.
- `rv-native`: `windows` 0.62 and `webview2-com` on Windows; `objc2`, `objc2-app-kit`, `objc2-web-kit`, `objc2-user-notifications` on macOS.
- `rv-ffi`: `uniffi` 0.32 (proc-macros, no UDL), `keyring` (with `apple-native` on macOS).

The minimum versions the GTK feature flags imply (GTK 4.12, libadwaita 1.6, Pango 1.56) are what the release tarball needs from a host; see [../operations.md](../operations.md).

## The Fedora build container

`apps/desktop/docker/Dockerfile` is a `fedora:44` image with Rust, cargo, clippy, rustfmt, gcc, llvm, the GTK 4 / libadwaita / WebKitGTK 6.0 / GStreamer development packages, GStreamer plugins (good, bad-free, libav) for the media tests, Xvfb and `dbus-daemon` for headless runs, Noto fonts (sans and colour emoji), and `cargo-llvm-cov`. `CARGO_HOME=/cargo` points at a named volume.

`apps/desktop/scripts/build.sh`:

1. builds the image as `rocket-vibe-rs-build` and creates the `rv-cargo` volume (cargo registry cache shared across runs), chowned to the caller's uid;
2. runs, as the caller's uid with the checkout mounted at `/src`: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `cargo build --workspace`, all with `--profile "$PROFILE"` (`PROFILE=dev` by default, `PROFILE=release` for a release build).

The script runs under `set -euo pipefail`, so a failed step fails the script. Because the image ships the same GTK 4.22 and libadwaita 1.9 as a Fedora 44 host, the binary in `target/` runs natively on the developer's machine. The other scripts reuse the same image: `smoke.sh`, `e2e.sh`, `e2e-actions.sh` (the app under Xvfb against the seeded test server) and `coverage.sh`; see [testing.md](testing.md).

Footguns:

- The container builds against Fedora 44's libraries and glibc: the resulting binary is not portable to older distributions. Portability is the AppImage's job (built in a separate Arch image, see [desktop-gtk.md](desktop-gtk.md#packaging)).
- `apps/desktop/target/` is shared between host runs and container runs; the AppImage build uses `target/appimage` and the Linux Swift check uses `target/swift-linux` to avoid clobbering it.
- CI's `linux` job does not use this Dockerfile: it runs the same four cargo commands in a plain `fedora:44` container with its own package list (`.github/workflows/desktop.yml`).
- The SwiftUI side has its own container (`apps/desktop/macos/docker/Dockerfile`, `swift:6.1-noble`) for its Linux-buildable targets; see [desktop-macos.md](desktop-macos.md).

## `data/` and assets

| Path | What it is |
|---|---|
| `data/com.rocketvibe.app.desktop` | The freedesktop launcher entry: `Exec=rocket-vibe-gtk %u`, `MimeType=x-scheme-handler/rocketvibe;`, `StartupWMClass=com.rocketvibe.app`. Installed by `scripts/install-desktop.sh` (checkout) and `scripts/install.sh` (AppImage). |
| `data/icons/hicolor/<size>/apps/com.rocketvibe.app.png` | The icon at 32 to 512 px. The 48 and 128 px ones are also compiled into the binary (`rv-gtk/src/icon.rs`) so the window has its icon whether installed or not. |
| `data/windows/rocket-vibe.ico` | Embedded in the Windows executable by `rv-gtk/build.rs` (winresource). |
| `data/windows/rocket-vibe.iss` | The Inno Setup script CI compiles into `...-windows-x86_64-setup.exe` (6.7 or later). Its look is `installer-ui.iss`: dark wizard, borderless window dragged from anywhere (`WM_NCHITTEST`), pill buttons over the real ones kept off-window, a rocket trailing a rainbow as progress bar, frameless dialogs for Setup's questions, and an uninstaller whose rocket crashes (played at `usUninstall`: by `usPostUninstall` the window is freed, and its controls answer "Could not call proc"). A yes to uninstall reruns the uninstaller `/SILENT /RVFAREWELL=1`, the only way past Inno's own message boxes. `installer-preview.iss` shows all of it over a throwaway payload in `%TEMP%`, with no registry key; its `unins000.exe` shows the uninstaller. |
| `data/windows/installer-art.py`, `data/windows/installer/` | Draws the installer artwork (Pillow, deterministic) from the mobile splash rocket; the PNGs are committed. |
| `data/macos/Info.plist`, `data/macos/entitlements.plist` | The GTK app's macOS bundle metadata and hardened-runtime entitlements, used by `scripts/package-macos.sh`. |
| `macos/data/Info.plist`, `macos/data/entitlements.plist` | The SwiftUI app's own (bundle id `com.rocketvibe.app.swiftui`). |
| `crates/rv-core/data/emojis.tsv` | Shortcode to code points to picker category, generated by `scripts/generate-emojis.mjs` from emoji-toolkit and compiled in with `include_str!` (`rv-core/src/emoji.rs`). Rocket.Chat never sends this table. |
| `crates/rv-gtk/assets/fonts/` | Baloo 2 (titles) and Nunito (body), the mobile app's typefaces, with their OFL licences. Compiled into the GTK binary (`rv-gtk/src/fonts.rs`) and copied into the SwiftUI bundle by `macos/scripts/package.sh`. |
| `tests/media/` | `video.mp4`, `voice.m4a`, `voice.ogg`: fixtures for the media smoke checks. |

Fetched at packaging time, not committed: Hunspell dictionaries (`scripts/fetch-dictionaries.sh`, Windows and macOS packages; Linux uses the system's) and Noto Color Emoji (`scripts/fetch-emoji-font.sh`, same platforms).

## Where state lives at runtime

Both apps use GLib's XDG layout, macOS included (GLib has no macOS case for its user directories, and `rv-ffi` computes the same paths so the two apps share them):

- `~/.local/share/rocket-vibe-rs/<host>[_<port>]-<user id>.sqlite`: one database per server and account (`database_path` in `rv-gtk/src/window.rs`).
- `~/.config/rocket-vibe-rs/`: `active-account`, `accounts` (the keychain cannot list its items), `servers` (known servers), `last-server`, `language`, `collapsed-sections`, `dictionary` (personal spell-check words), `quit-on-close`, `no-update-check`.
- `~/.cache/rocket-vibe-rs/`: logs and `crash.log` (`rv-gtk/src/crashlog.rs`; on Windows the local app data folder instead, since Disk Cleanup empties GLib's cache folder there), `update.json` and downloaded updates, the GStreamer registry on macOS.
- The system keychain: one item per account under the service `me.barrut.RocketVibe` (the app's first id, kept so signed-in sessions survive the id change), keyed `<base URL>|<user id>`. The token is never written to disk.

The `rocket-vibe-rs` folder name predates the monorepo; renaming it would orphan every existing install's accounts and caches.

## Sources

- apps/desktop/Cargo.toml
- apps/desktop/rustfmt.toml
- apps/desktop/crates/rv-core/Cargo.toml
- apps/desktop/crates/rv-gtk/Cargo.toml
- apps/desktop/crates/rv-gtk/build.rs
- apps/desktop/crates/rv-native/Cargo.toml
- apps/desktop/crates/rv-ffi/Cargo.toml
- apps/desktop/crates/rv-core/src/lib.rs
- apps/desktop/crates/rv-core/src/emoji.rs
- apps/desktop/crates/rv-gtk/src/fonts.rs
- apps/desktop/crates/rv-gtk/src/icon.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-gtk/src/secrets.rs
- apps/desktop/crates/rv-ffi/src/accounts.rs
- apps/desktop/docker/Dockerfile
- apps/desktop/scripts/build.sh
- apps/desktop/scripts/generate-emojis.mjs
- apps/desktop/scripts/fetch-dictionaries.sh
- apps/desktop/scripts/fetch-emoji-font.sh
- apps/desktop/data/
- apps/desktop/macos/Package.swift
- apps/desktop/macos/docker/Dockerfile
- .github/workflows/desktop.yml
- apps/desktop/README.md
