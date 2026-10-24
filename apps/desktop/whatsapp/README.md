# WhatsApp helper (Go engine, Android)

**The desktop no longer ships this helper.** Its `rv-whatsapp` is the Rust engine in `crates/rv-whatsapp/engine` (same JSON-lines protocol, built by `apps/desktop/scripts/build-whatsapp.sh` and `desktop-whatsapp.yml`). This Go engine stays as Android's, built into `librv_whatsapp.so` by `apps/mobile/modules/whatsapp/build-android.mjs`, until Android binds the Rust one; `desktop-whatsapp.yml` still runs its gofmt, vet and race tests. The sections below describe it as it was used on the desktop.

Status: experimental, on `claude/whatsapp-feasibility` (continuing `codex/whatsapp-feasibility`). A WhatsApp account is an account of the GTK app; this is the local helper behind it. Read [the handoff](../../../docs/WHATSAPP_HANDOFF.md) before extending it.

This is a linked-device connector for a personal WhatsApp account, using [whatsmeow](https://github.com/tulir/whatsmeow), driven by the app's `WaSession` (`rv-core/src/whatsapp_session.rs`). It runs on the user's computer. There is no WhatsApp Web embed, Business API credential, Matrix bridge or Vibez server relay.

## Build and launch

From the repository root, in Bash:

```bash
# On Windows Git Bash, also set MSYS_NO_PATHCONV=1.
apps/desktop/scripts/build-whatsapp.sh
apps/desktop/scripts/build.sh

# The Windows helper (mingw-w64 cross build):
TARGET_OS=windows PROFILE=release apps/desktop/scripts/build-whatsapp.sh
```

The Go script builds a **Linux** sidecar in Docker. It pins whatsmeow and its dependencies in `go.mod` and `go.sum`; Go 1.26.0 is required and downloaded into the dedicated Docker volume through Go's toolchain mechanism. SQLite uses a compiled native driver (CGO). The Rust app still builds through the existing Fedora script.

The app locates `rv-whatsapp` (`rv-whatsapp.exe` on Windows) beside itself, or the path in `RV_WHATSAPP_HELPER`. If it is there, the sign-in page offers **Connect WhatsApp**, which shows the QR; each linked account gets its own helper process and state.

Packages ship it: `.github/workflows/desktop-whatsapp.yml` builds it (Linux in Ubuntu 22.04, Windows cross-built with mingw-w64, macOS on its runner) with `rv-whatsapp-licenses.txt` (`licenses.sh`, every module's licence, whatsmeow's MPL-2.0 first), and `desktop.yml` puts both beside the app in the Linux archive, the Windows zip and installer, and the macOS bundle (signed like `rv-voice`); the AppImage carries the helper but not yet the notice. `rv-whatsapp --version` names the helper and whatsmeow's version. macOS SwiftUI and Android embedding are not there.

On Linux, an unlocked Secret Service is necessary for real linking. On Windows/macOS the GTK implementation uses the corresponding system keychain. Unavailable secure storage fails closed. Do not replace that with a plaintext key file or an environment variable.

## State and privacy

- The system keychain stores a separate 32-byte wrapping key per account, under `whatsapp-storage-v1|<state>` (`whatsapp-pilot-storage-v1` for the device the earlier pilot window linked).
- Initialization passes that key through the child's private stdin, never arguments or environment variables.
- The child keeps its SQLite database in memory. It serializes and seals the database with AES-256-GCM, using a fresh nonce and an authenticated version header.
- The persistent state is `<user-data>/rocket-vibe-rs/whatsapp/<state>/state.bin` (`whatsapp-pilot/state.bin` for the adopted pilot device). Restoring it copies the image into the in-memory database through SQLite's backup API: a deserialized image cannot grow. It contains encrypted device keys, protocol state and the text cache. A native OS lock prevents simultaneous writers.
- The QR payload exists only in the current process and expires in the UI. It is never written to a log, documentation or a fixture.
- Stop checkpoints the state; successful unlinking removes the ciphertext and clears the UI projection. The wrapping key may remain in the keychain for a later association.
- Checkpoints run once per second, when the database changed, and before an outbound request. Atomic replacement protects the previous file, but the last second of received protocol state can be lost in a crash.
- The text cache keeps the newest 20,000 messages; unsettled sends stay until settled.
- A send intent is persisted before calling WhatsApp. An uncertain send stays uncertain across a restart and is **never automatically replayed**.
- View-once and disappearing messages are never kept; media and unsupported payloads are not there yet. Edits and revocations are applied. Do not represent the cache as a complete WhatsApp history (newest 20,000 messages).

## Tests

`build-whatsapp.sh` runs gofmt verification, vet, race-enabled tests and builds the connector. Tests exercise encrypted SQLite restoration, wrong keys, tampering, revocation, skipped unchanged checkpoints, cache pruning, writer exclusion and recipient scope.

`build.sh` exercises Rust projection tests and a synthetic child-process IPC peer. The peer never connects to WhatsApp.

`scripts/smoke-whatsapp.sh` renders the QR and chat screens under Xvfb with the synthetic peer (`RV_CARGO_TARGET=/cargo/target-desktop` when the binaries live in the `rv-cargo` volume); screenshots land in `.cache/whatsapp/`. See also [the handoff](../../../docs/WHATSAPP_HANDOFF.md). Only synthetic QR codes and conversations may be automatically captured.

## Dependencies

whatsmeow is a third-party library, not an official Meta personal-account API, under MPL-2.0. We build it from our fork, [boubou666/whatsmeow](https://github.com/boubou666/whatsmeow), branch `rocketvibe` (a `replace` in `go.mod`; the fork keeps the module path `go.mau.fi/whatsmeow`), so fixes and what whatsmeow lacks, calls first, can live there. It starts at upstream `c386243a72ba` (2026-10-07). To take a change of the fork: push it to `rocketvibe`, then `go mod edit -replace go.mau.fi/whatsmeow=github.com/boubou666/whatsmeow@<commit>` and `go mod tidy`. Files we change in the fork stay under MPL-2.0.

The helper must be built with `-tags sqlite_unlock_notify` (`build-whatsapp.sh` does; `engine/tags.go` refuses to start otherwise): the vault's shared in-memory database relies on a write waiting for the one before it. Follow dependency license obligations when distributing the helper. Future upstream protocol changes may require an update and renewed live qualification.

