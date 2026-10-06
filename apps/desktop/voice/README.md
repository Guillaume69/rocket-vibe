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
  next to its own executable. Without it, the app does not offer voice.

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
  clang 21, so the binary needs glibc 2.35 only (a Fedora build needs 2.43).
  Output in `apps/desktop/dist/`.
- **Linux, development**: in the desktop's Fedora image, after
  `dnf install -y clang` (webrtc-sys needs clang 21 or later), with a target
  directory of its own, such as `CARGO_TARGET_DIR=/cargo/target-voice`.
- **macOS**: `cargo build --release` (Xcode command line tools).

PulseAudio reports no device GUID: such a device's id is its name.
