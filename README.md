# rocket-vibe

Native chat clients, faster and more reliable than the official ones, and the server they
share a protocol with. One app, several kinds of account side by side in a rail:

| Account | What it is |
|---|---|
| **Rocket.Chat** | self-hosted servers running Rocket.Chat **8** or later |
| **Vibez** | the Rust server in this monorepo ([`apps/server`](apps/server/README.md)): native protocol, MLS encrypted conversations, voice |
| **Mattermost** and **kChat** | Mattermost servers and Infomaniak's fork ([`docs/MATTERMOST.md`](docs/MATTERMOST.md)) |
| **WhatsApp** (experimental) | a personal account linked as a WhatsApp device, like WhatsApp Web; the engine runs on your machine, nothing goes through a Vibez server ([`brain/features/whatsapp.md`](brain/features/whatsapp.md)) |

The interfaces are native (GTK, SwiftUI, Android views), with no UI kit; a web view only where a
third party requires one (the Jitsi call screen on Android, video-site players on desktop).

## Apps

| App | Where | Tech | Version |
|---|---|---|---|
| **Mobile** (Android; iOS later) | [`apps/mobile`](apps/mobile/README.md) | Expo / React Native, SQLite, Kotlin and Rust native modules | `apps/mobile/app.json` |
| **Desktop** (Linux, Windows, macOS) | [`apps/desktop`](apps/desktop/README.md) | Rust, GTK 4 + libadwaita | `apps/desktop/Cargo.toml` |
| **Desktop SwiftUI** (macOS) | [`apps/desktop/macos`](apps/desktop/macos) | SwiftUI on the desktop's Rust core (`rv-ffi`) | shipped with the desktop |
| **Web** | [`apps/web`](apps/web/README.md) | TypeScript, compiled into the Vibez server | shipped with the server |
| **Vibez** (server) | [`apps/server`](apps/server/README.md) | Rust, Axum, PostgreSQL | `apps/server/Cargo.toml` |

The apps aim at the same features; none is the reference. [`brain/parity.md`](brain/parity.md)
keeps the count, feature by feature, with what each app still owes. The web client speaks to the
Vibez server that serves it only, with the GTK design and MLS encryption through
WebAssembly ([encryption qualification](docs/WEB_E2EE.md)).

Rust shared by the server and the apps (native protocol, client, MLS engine and its bridges)
lives in [`crates/`](crates) ([`brain/architecture/shared-crates.md`](brain/architecture/shared-crates.md)).
WhatsApp runs on [whatsmeow](https://github.com/tulir/whatsmeow), through our fork
[`boubou666/whatsmeow`](https://github.com/boubou666/whatsmeow): a helper process beside the
desktop app ([`apps/desktop/whatsapp`](apps/desktop/whatsapp/README.md)), the same Go engine
inside the Android app ([`docs/WHATSAPP_ANDROID.md`](docs/WHATSAPP_ANDROID.md)).

## Where to read

- [`brain/`](brain/BRAIN.md): the knowledge base. How every feature works on each app, the
  architecture, the servers' facts and the decisions, written to be understood without reading
  the source. Start there.
- [Slack Session mode protocol and implementation handoff](docs/protocol/SLACK_SESSION.md):
  measured session/RTM behaviour, provider parity targets and qualification probes;
  a hidden read-only preview now validates manual sessions and pages conversations/history; persistent accounts, real-time sync and writes remain pending.
- [`ROADMAP.md`](ROADMAP.md): the product decisions and their justification.
- [`docs/`](docs): the development environment and the survey of the target server
  ([`DEV.md`](docs/DEV.md)), push ([`PUSH.md`](docs/PUSH.md)), WhatsApp
  ([`WHATSAPP_HANDOFF.md`](docs/WHATSAPP_HANDOFF.md)), the
  [RFC of the Vibez server](docs/rfcs/0001-vibez-server.md).

## Test servers

[`docker/`](docker) holds the servers the apps are tested against:

```sh
cd docker && cp .env.example .env && chmod 600 .env   # fill in ADMIN_PASS
node patch-push.mjs                                   # Rocket.Chat bundle patched for push (docs/PUSH.md)
docker compose up -d                                  # Rocket.Chat 8.5.1 + MongoDB 8.0
node ../scripts/seed.mjs                              # alice, bob, test rooms, idempotent
```

`compose.vibez.yml` starts a Vibez server and `compose.mattermost.yml` a Mattermost
one; the other compose files are the native pilots' benches.

## CI, versions and releases

GitHub Actions workflows run when their app (or the workflow itself) changes. A push only
checks (typecheck, lint, tests; fmt, clippy and tests for the Rust); packages are built on a
release tag, or by hand through `workflow_dispatch`.

- **`mobile`**: typecheck, lint, tests, then a release Android APK (`expo prebuild` + Gradle
  on the runner, never EAS), the Rust crypto and the Go WhatsApp engine built for each ABI. It
  reads `google-services.json` from the `GOOGLE_SERVICES_JSON` secret.
- **`native-crypto-android`**: the Android crypto module against a real Keystore, on an emulator.
- **`desktop`**: Linux (the same Fedora as the local build: fmt, clippy, all tests, an archive;
  plus an AppImage built on Arch, launched in CI on a distribution without GTK), Windows (MSYS2:
  a per-user installer without administrator rights, which adds a shortcut and registers
  `rocketvibe://` links, tested by an install, a launch and an uninstall; plus a zip) and macOS
  (Apple Silicon, macOS 15+: a self-contained app in a DMG, launched in CI without Homebrew),
  signed with Developer ID and notarized by Apple. The certificate comes from the
  `MACOS_CERTIFICATE_P12` secret (and its password), the notarization from an App Store Connect
  API key (`APPLE_API_KEY_P8`, `_KEY_ID`, `_ISSUER_ID`); without them, CI signs ad hoc and macOS
  asks "Open Anyway" on first launch. The originals live in `~/.config/rocket-vibe/apple/`,
  **back them up**: the certificate's private key cannot be recovered.
- **`desktop-voice`** and **`desktop-whatsapp`**: the voice and WhatsApp helpers for the three
  desktop platforms, with the WhatsApp helper's licence notice; `desktop` calls both when it
  packages and puts them beside the app's executable.
- **`desktop-swiftui`**: the SwiftUI app for macOS, called by `desktop` on a tag or a
  `workflow_dispatch` (its release takes the DMG from it), and on its own when the app changes.
- **`notification-cards`**: the desktop's own notification cards on Windows.
- **`native-server`**: the Vibez server and its crypto against PostgreSQL and the real
  platform keystores.
- **`server-release`**: on a `vibez-vX.Y.Z` tag, the server gate, then one Docker build: its
  binary as a Linux x86_64 archive (`vibez-X.Y.Z-linux-x86_64.tar.gz`) with SHA-256 checksums and its image pushed to
  `ghcr.io/guillaume69/vibez` (`X.Y.Z` and `latest`). A `release/**` branch runs it
  without publishing; `server-image` republishes the image of an existing tag.
- **`web-client`**: committed-bundle verification, server fmt/clippy/tests and real browser
  scenarios. It publishes nothing: the web client ships inside the server binary, under the
  server's version and release. The bundle embeds the desktop's strings: a change to `rv-core`'s `i18n.rs` means
  rebuilding it (`apps/web`, `npm run build`).
- **`cargo-locks`**: keeps the separate Rust workspaces' `Cargo.lock` files on the same versions.

`node scripts/version.mjs mobile|desktop|vibez` prints an app's version and checks its
consistency. Each app keeps its changelog in the Keep a Changelog format
([mobile](apps/mobile/CHANGELOG.md), [desktop](apps/desktop/CHANGELOG.md),
[vibez](apps/server/CHANGELOG.md), the server and its web client), every visible change going
into its "Unreleased" section. To publish: move that section under the new version number,
bump the version, then push a `mobile-vX.Y.Z`, `desktop-vX.Y.Z` or
`vibez-vX.Y.Z` tag, at most three in one push (GitHub starts no workflow for more). The
workflow checks that the tag matches the version and that the changelog has its section, then
creates the GitHub release with its binaries and that section as notes.

## License & status

Personal project, under active development. Main branch: **`master`**.

WhatsApp support is experimental and is not a Meta product: WhatsApp may restrict an account
that uses a third-party client. The apps ship the licences of the code they include: the
desktop's Linux archive, Windows packages and macOS app carry `rv-whatsapp-licenses.txt` beside the
WhatsApp helper (the AppImage does not yet), and the Android
app lists them under Settings > App > Open-source licences (whatsmeow is under the Mozilla
Public License 2.0).
