# Testing

How each app is tested: fast unit and integration suites that run everywhere (including CI), end-to-end runs that drive the real app against the seeded Docker server (local only), and CI smoke runs of the packaged desktop app on each OS. The recurring rule in both apps: an end-to-end assertion that the UI shows something is not enough, the server's state is checked too.

## Mobile

### Unit tests (`npm test`)

`npm test` runs Node's built-in runner on `lib/**/*.test.ts`, `db/**/*.test.ts`, `ui/**/*.test.ts`, `fournisseurs/**/*.test.ts` and `plugins/**/*.test.mjs`. There is no Jest and no transpiler: Node 24 strips TypeScript types itself, which is why:

- imports carry their `.ts` extension (`allowImportingTsExtensions` in `tsconfig.json`);
- `lib/` and `db/` must avoid syntax that emits code (`enum`, constructor parameter properties); `apps/mobile/eslint.config.js` turns both into lint errors, because a single one stops Node from loading the module and silently takes its tests with it;
- tested modules must not import React Native. Pure logic lives in `lib/` and in the testable halves of `ui/` (for example `ui/salonChaud.ts`, `ui/barreNonLus.ts`, `ui/sectionsAccueil.ts`), while the `.tsx` components stay untested.

Notable test techniques:

- **SQL is tested on real SQLite.** `db/upserts.test.ts` and `db/schema.test.ts` open `node:sqlite`'s `DatabaseSync`, apply the real Drizzle migrations from `db/migrations/`, and run the exact SQL strings and parameter builders that `db/depot.ts` executes on the device through `expo-sqlite` (the depot deliberately avoids Drizzle's query builder so tested and shipped SQL cannot diverge).
- **Fake stores keep the deadlock invariant.** `lib/depotDeTest.ts` wraps fake `Depot`s so that calling a queued write method inside `transaction` throws, as the real write queue would deadlock; a naive fake would let such a refactor pass every test and then freeze on the device.
- **Transports are faked at the socket.** `lib/ddp.test.ts` drives the DDP client through an in-memory `WebSocketLike`; `lib/rest.test.ts` injects its own `fetch` into the client.
- **Crypto runs on `node:crypto`.** Metro aliases `crypto` to react-native-quick-crypto in the app bundle only, so `lib/e2e/*.test.ts` exercise the same calls against Node's OpenSSL. `lib/e2e/surfaceQuickCrypto.test.ts` runs the real `metro.config.js` resolver with a fake context to prove the alias still points at quick-crypto (if it broke, the app would load a pure-JS polyfill or nothing and no other test would notice); the quick-crypto API surface itself is pinned by type assertions in `lib/e2e/surfaceQuickCrypto.ts`, checked by `tsc`.
- **Config plugins are tested as functions**: each `plugins/with-*.test.mjs` feeds a template file to the plugin's exported transform (for example `signer` in `with-signature-release.js`).

Alongside: `npx tsc --noEmit` (strict, no implicit `any`) and `npm run lint`. CI runs all three on every relevant push and PR ([../operations.md](../operations.md)).

### End-to-end: Maestro (`e2e/`)

`MAESTRO=/path/to/maestro e2e/lancer.sh` runs five flows against a dev build on the emulator and the local server (`SERVEUR`, default `http://localhost:3000`):

| Flow | What it proves | Harness around it |
|---|---|---|
| `01-connexion.yaml` | From a cleared state: dev-client launcher, server address, alice's login, room list. | Retried once (see below). |
| `02-envoi.yaml` | Sends a message. | `harnais/verifier-serveur.mjs` checks the server holds it: the on-screen assert would pass on the optimistic row alone. |
| `03-reconnexion.yaml` | A message posted while offline appears after reconnecting. | The script removes `adb reverse`, has bob post (`harnais/poster-bob.mjs`), restores the link (a trap restores it on any failure). |
| `04-upload.yaml` | Uploads an image through the system picker with a caption. | Generates a 1x1 PNG, pushes it to `/sdcard/Download`, then checks the server has the message and its file. |
| `05-deux-facteurs.yaml` | Login with TOTP. | `harnais/deux-facteurs.mjs` enables bob's TOTP (via DDP methods, the only place in the repo allowed to call them) and always disables it afterwards; `harnais/totp.mjs` computes codes. |

Footguns encoded in `lancer.sh`: it pins `ANDROID_SERIAL` to `emulator-5554` so a plugged-in personal phone never receives the suite; flows starting from a cleared state get one retry because the dev client crashes natively on some cold starts (Fabric `MountingCoordinator::pullTransaction`, roughly 2 in 8, never in release); flows that post are not retried, since a retry would post twice; a 2FA secret left by an interrupted run is persisted in `/tmp/rocket-vibe-e2e-2fa-secret` and cleaned up at the next start. The suite is written in bash, not zsh. It does not run in CI.

## Desktop

### Unit and integration tests

`scripts/build.sh` runs `cargo test --workspace` in the Fedora container after fmt and clippy.

- **Unit tests** sit next to the code (`#[cfg(test)]` modules across `rv-core`, plus a few in `rv-gtk`, `rv-native` and `rv-ffi`): normalisation, store SQL, list diffing, markdown, media URLs, emoji, update version comparison and similar pure logic.
- **Integration tests** in `crates/rv-core/tests/` (`rest.rs`, `ddp.rs`, `sync.rs`, `outbox.rs`, `uploads.rs`, `actions.rs`) run the real clients against local fakes: `tests/common/mod.rs` provides `FakeHttp`, a raw HTTP/1.1 server with one scripted response per request that records every request; `tests/ddp.rs` has a scripted `FakeDdp` WebSocket server (tokio-tungstenite) that answers the handshake, login and subs, can reply with a `msg: 'error'` carrying `offendingMessage`, and lets the test push frames.
- **Live tests, skipped without a server**: `crates/rv-ffi/tests/live.rs` and the Swift `LiveTests` in `macos/Tests/RocketVibeKitTests/KitTests.swift` run only when `RV_TEST_SERVER` is set (`RV_TEST_SERVER=http://localhost:3000 cargo test -p rv-ffi --test live`), and print "skipped" or throw `XCTSkip` otherwise. rv-ffi's test polls futures with `block_on` outside tokio, as Swift does.
- **SwiftUI side**: `swift test` runs the view-model tests; `swift run rv-rooms` is an offline self-check of the bindings (system message text, shortcode replacement, emoji completion), or with `<server> <user> <password>` signs in and lists rooms. `macos/scripts/check-linux.sh` runs build and tests in the `swift:6.1-noble` container.

### The smoke driver (`RV_SMOKE_*`)

`crates/rv-gtk/src/smoke.rs` turns the real app into a scripted test, driven by environment variables (its module doc lists them all). With a server: `RV_SMOKE_LOGIN="server|user|password"`, `RV_SMOKE_ROOM`, `RV_SMOKE_SEND`, `RV_SMOKE_EXPECT` / `RV_SMOKE_EXPECT_ABSENT` (texts that must or must not be shown), `RV_SMOKE_SHOT` (screenshot after `RV_SMOKE_DELAY_MS`), and feature scenarios such as `RV_SMOKE_ACTIONS`, `RV_SMOKE_DRAFTS`, `RV_SMOKE_COMMANDS`, `RV_SMOKE_UPLOAD`, `RV_SMOKE_NOTIFY`, `RV_SMOKE_SECOND`, `RV_SMOKE_E2E`, `RV_SMOKE_VOICE`, `RV_SMOKE_EDIT`, `RV_SMOKE_JUMP`, `RV_SMOKE_PLAYER_LEAVE`, `RV_SMOKE_UPDATE`. Without a server: `RV_SMOKE_GALLERY=1` draws sample messages, combined with `RV_SMOKE_SOAK=<secs>` (churn rows, toasts and badges), `RV_SMOKE_MEDIA` (files that must play), `RV_SMOKE_CALL`, `RV_SMOKE_PLAYER`, `RV_SMOKE_IME`; `RV_SMOKE_AUTOSTART=on|off` toggles start at login and exits. A failed expectation exits with status 1. The SwiftUI app honours `RV_SMOKE_GALLERY`, `RV_SMOKE_SOAK` and `RV_SMOKE_SCROLL` (`Gallery.swift`, `ScrollBench.swift`).

`scripts/smoke.sh <server> <user> <password> <room> <out.png> [message]` runs that driver headless in the build image: Xvfb on `:99`, `GSK_RENDERER=cairo`, host network, a throwaway `HOME`, a session D-Bus when `RV_SMOKE_NOTIFY` is set, and `RV_HOST_LOOK=1` to borrow the host's icon theme and GTK settings.

### End-to-end scripts (seeded bench)

- `scripts/e2e.sh [server]`: alice opens `test-public` and sends a message while bob, over REST, posts one and posts then deletes another. Passes when the app shows alice's and bob's messages exactly once, does not show the deleted one, and the server stored alice's message exactly once.
- `scripts/e2e-actions.sh [server]`: alice reacts to bob's message, quotes it, edits her own and replies in a thread; each effect is then verified on the server over REST (reaction user list, quote permalink, edited text, `tmid`).
- `scripts/coverage.sh` measures line coverage with cargo-llvm-cov in the build image; `--e2e` adds an instrumented `e2e.sh` run, `HTML=1` writes `target/llvm-cov/html`. The README quotes about 43% from tests alone and about 88% with the e2e run, the UI being out of the unit tests' reach.

These need the Docker server up and seeded; none runs in CI.

### CI smoke runs of the packages

On a release tag or a manual dispatch, `desktop.yml` runs the built packages, not just the tests (artifacts include screenshots):

- **AppImage** on `ubuntu:22.04` with no GTK installed (the job fails if GTK is found): gallery under Xvfb, no panic logged, three media files must report `smoke: media ... ok`.
- **Windows**: silent install, Start menu link and `rocketvibe://` registration checked, launch from a link, background start with tray icon and a second launch handing over the link, start at login switched on, off, on, gallery with media, IME crash regression (`RV_SMOKE_IME`), call window and inline player on WebView2, 45 s soak with no `crash.log`, then uninstall leaving no registry entries. A crash leaves a minidump that `cdb` summarises.
- **macOS (GTK)**: with Homebrew moved aside to prove the bundle is self-contained: launch, gallery with media, call window and player on WKWebView, soak, launch agent written and removed, background start; plus Gatekeeper and stapling checks when signed.
- **macOS (SwiftUI)** (`desktop-swiftui.yml`, also on feature branches touching it): login screen, gallery, 45 s soak, and a scroll benchmark whose frame times go to the job summary as a trend, not a gate (runners have no GPU).

Fixtures for media playback live in `apps/desktop/tests/media/` (`voice.ogg`, `voice.m4a`, `video.mp4`).

## What CI gates on every change

| App | On push to `master` and PRs |
|---|---|
| Mobile | version consistency, `tsc --noEmit`, ESLint, `npm test` |
| Desktop | version, `cargo fmt --check`, `clippy -D warnings`, `cargo test --workspace` (Fedora 44) |
| SwiftUI | build, `swift test`, `rv-rooms`, packaging and launch, on non-`master` pushes touching `macos/` or `rv-ffi` |

## Sources

- `apps/mobile/package.json`
- `apps/mobile/tsconfig.json`
- `apps/mobile/eslint.config.js`
- `apps/mobile/metro.config.js`
- `apps/mobile/lib/depotDeTest.ts`
- `apps/mobile/lib/ddp.test.ts`
- `apps/mobile/lib/e2e/surfaceQuickCrypto.test.ts`
- `apps/mobile/lib/e2e/surfaceQuickCrypto.ts`
- `apps/mobile/lib/rest.test.ts`
- `apps/mobile/db/upserts.test.ts`
- `apps/mobile/db/schema.test.ts`
- `apps/mobile/db/depot.ts`
- `apps/mobile/plugins/with-signature-release.test.mjs`
- `apps/mobile/e2e/lancer.sh`
- `apps/mobile/e2e/flows/`
- `apps/mobile/e2e/harnais/`
- `apps/desktop/scripts/build.sh`
- `apps/desktop/scripts/smoke.sh`
- `apps/desktop/scripts/e2e.sh`
- `apps/desktop/scripts/e2e-actions.sh`
- `apps/desktop/scripts/coverage.sh`
- `apps/desktop/crates/rv-core/tests/`
- `apps/desktop/crates/rv-ffi/tests/live.rs`
- `apps/desktop/crates/rv-gtk/src/smoke.rs`
- `apps/desktop/macos/Tests/RocketVibeKitTests/KitTests.swift`
- `apps/desktop/macos/Sources/rv-rooms/main.swift`
- `apps/desktop/macos/Sources/RocketVibe/Gallery.swift`
- `apps/desktop/macos/Sources/RocketVibe/ScrollBench.swift`
- `apps/desktop/macos/scripts/check-linux.sh`
- `apps/desktop/tests/media/`
- `apps/desktop/README.md`
- `.github/workflows/mobile.yml`
- `.github/workflows/desktop.yml`
- `.github/workflows/desktop-swiftui.yml`
