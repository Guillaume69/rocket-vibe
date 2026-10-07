# rv-voice, the voice sidecar

`rv-voice` carries the audio of native voice sessions (LiveKit, WebRTC) for the
desktop apps. The app spawns one process per voice connection and drives it over
stdin/stdout JSON lines: `crates/rv-voice-protocol` is the contract,
`crates/rv-core/src/voice.rs` the app side. It exits once disconnected, and as
soon as its stdin closes (the app died).

## Why a separate process and workspace

- It is the only binary that links libwebrtc, through LiveKit's prebuilt
  `webrtc-sys`. That build is MSVC-only on Windows, while the GTK app is built
  with MSYS2 GNU; and `rv-ffi`'s static library (SwiftUI) must never carry
  libwebrtc. A process boundary keeps both untouched.
- `apps/desktop/voice` is its own cargo workspace (own `Cargo.lock`, excluded
  from `apps/desktop/Cargo.toml`), so `cargo build --workspace` of the desktop
  never compiles `webrtc-sys`.
- The app finds it through `RV_VOICE_BIN`, else as `rv-voice` (`rv-voice.exe`)
  next to its own executable, else in `$SHARUN_DIR/bin` (the AppImage, whose
  current executable is sharun's loader). Without it, the app does not offer voice.

`RV_VOICE_FAKE_AUDIO=sine` publishes a 440 Hz tone instead of opening the
microphone and speakers, for headless tests. `rv-voice --version` prints the
version and protocol.

## Building

The version follows `apps/desktop/Cargo.toml` (bump both together).

- **Windows** (MSVC, from `apps/desktop/voice`, so that `.cargo/config.toml`
  applies `+crt-static`, which libwebrtc's `/MT` objects require). The target
  directory must be short: `cl.exe` is not long-path aware and libwebrtc's
  headers sit deep below it (`C1083`).

  ```sh
  cargo build --release --target-dir C:/Users/<you>/.cargo/t-rvv
  ```

- **Linux, shippable**: `scripts/build-linux.sh` builds in `ubuntu:22.04` with
  clang 21, so the binary needs glibc 2.35 only (a Fedora build needs 2.43). It links
  GLib (`build.rs`: libwebrtc's screen capture portal speaks D-Bus through GIO) and reads
  cameras through V4L2 (`nokhwa`). The workspace's second binary, `rv-screen-audio`
  (`screen-audio/`), captures the screen's sound through PipeWire and ships next to
  rv-voice. It builds on Ubuntu 24.04 (its PipeWire bindings need headers newer than
  22.04's 0.3.48; `scripts/build-screen-audio-linux.sh`) and runs on 22.04 too (glibc
  2.34, libpipewire 0.3).
  Output: `apps/desktop/dist/voice/rv-voice`, where the packaging scripts look.
- **Linux, development**: in the desktop's Fedora image, after
  `dnf install -y clang` (webrtc-sys needs clang 21 or later), with a target
  directory of its own, such as `CARGO_TARGET_DIR=/cargo/target-voice`.
- **macOS**: `cargo build --release` (Xcode command line tools).

PulseAudio reports no device GUID: such a device's id is its name.

## Packaging

Every desktop package carries the sidecar next to the app's executable:

| Package | Where | Script |
|---|---|---|
| Linux tarball | `rv-voice` beside `rocket-vibe-gtk` | the `linux` job of `.github/workflows/desktop.yml` |
| AppImage | wrapped by sharun like the app (`AppDir/bin/rv-voice`, bundled glibc, PulseAudio through `DEPLOY_PULSE=1`) | `scripts/appimage-build.sh` |
| Windows zip and installer | `bin/rv-voice.exe` beside `bin/rocket-vibe-gtk.exe`; Inno Setup installs the whole folder | `scripts/package-windows.sh`, `data/windows/rocket-vibe.iss` |
| macOS app | `Contents/MacOS/rv-voice`, signed with the app's entitlements (microphone) | `scripts/package-macos.sh` |

The scripts take the sidecar from `$RV_VOICE`, else `dist/voice/rv-voice`
(`rv-voice.exe` on Windows), relative to `apps/desktop`. Without it they warn
and package an app without voice; `RV_VOICE_REQUIRED=1` makes that an error.

In CI, `.github/workflows/desktop-voice.yml` builds the three sidecars (on its
own when they change, and called by `desktop.yml` as its `voice` job when it
packages: a tag or a manual run). Each packaging job downloads its artifact
(`rv-voice-linux-x86_64`, `rv-voice-windows-x86_64`, `rv-voice-macos-arm64`)
into `dist/voice/` with `RV_VOICE_REQUIRED=1`, then runs `rv-voice --version`
from the package: the tarball, the AppImage extracted on Ubuntu 22.04, the
installed Windows app, the macOS bundle with Homebrew moved aside. Artifacts
lose the executable bit, hence the scripts' `install -m755`.
