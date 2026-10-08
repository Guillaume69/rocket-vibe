# rocket-vibe

Third-party **Rocket.Chat** clients, faster and more reliable than the official ones, for
self-hosted servers running Rocket.Chat **8** or later. The `feature/rocketvibe-server`
branch adds a **RocketVibe** server in Rust; both providers use the existing interfaces.

| App | Where | Tech | Version |
|---|---|---|---|
| **Mobile** (Android first) | [`apps/mobile`](apps/mobile/README.md) | Expo / React Native, SQLite | `apps/mobile/app.json` |
| **Web** | [`apps/web`](apps/web/README.md) | TypeScript browser app embedded in the native server | `apps/web/package.json` |
| **Desktop** (Linux, Windows, macOS) | [`apps/desktop`](apps/desktop/README.md) | Rust, GTK 4 + libadwaita | `apps/desktop/Cargo.toml` |

Each app has its own version number and its own builds; the desktop's feature parity with
mobile is tracked in [`brain/parity.md`](brain/parity.md).

The native server also delivers a real [web client](apps/web/README.md), with the GTK design, one account on the serving origin, and encrypted rooms currently unsupported. Its dedicated browser CI checks build, conversations, files, security and WebRTC.

## Shared

- [Native RocketVibe server, experimental](apps/server/README.md): a Rust server
  independent of Rocket.Chat; [progress log](docs/NATIVE_SERVER_EXECUTION.md).
- [Two providers on mobile](docs/NATIVE_MOBILE_PILOT.md): shared screens, rooms / DMs,
  drafts and durable resumption in SQLite.
- [Two providers on desktop](docs/NATIVE_DESKTOP_PILOT.md): Rust engine, the existing GTK
  app, SQLite cache / outbox and UniFFI bindings.
- [RFC 0001: a standalone RocketVibe server in Rust](docs/rfcs/0001-rocketvibe-rust-server.md):
  the server, protocol, client parity and migration from Rocket.Chat.
- [`ROADMAP.md`](ROADMAP.md): the product decisions and their justification.
- [`docs/`](docs): the development environment and the survey of the target server
  (`DEV.md`), push (`PUSH.md`).
- [`docker/`](docker): a test Rocket.Chat 8.5.1 + MongoDB 8.0:

  ```sh
  cd docker && cp .env.example .env && chmod 600 .env   # fill in ADMIN_PASS
  node patch-push.mjs                                   # server bundle patched for push (docs/PUSH.md)
  docker compose up -d
  node ../scripts/seed.mjs                              # alice, bob, test rooms, idempotent
  ```

## CI, versions and releases

Three GitHub Actions workflows, each running only when its app (or the workflow itself)
changes. A push only checks (typecheck, lint, tests; fmt, clippy and Linux tests for the
desktop): packages are only built on a release tag, or by hand through
`workflow_dispatch`.

- **`mobile`**: typecheck, lint, tests, then a release Android APK (`expo prebuild` +
  Gradle on the runner, never EAS). It reads `google-services.json` from the
  `GOOGLE_SERVICES_JSON` secret.
- **`desktop`**: Linux (the same Fedora as the local build: fmt, clippy, all tests, an
  archive; plus an AppImage built on Arch, launched in CI on a distribution without GTK),
  Windows (MSYS2: a per-user installer, without administrator rights, which adds a
  shortcut and registers `rocketvibe://` links, tested in CI by an install, a launch and
  an uninstall; plus a zip) and macOS (Apple Silicon, macOS 15+: a self-contained app in a
  DMG, launched in CI without Homebrew), signed with Developer ID and notarized by Apple:
  it opens without a warning. The certificate comes from the `MACOS_CERTIFICATE_P12`
  secret (and its password), the notarization from an App Store Connect API key
  (`APPLE_API_KEY_P8`, `_KEY_ID`, `_ISSUER_ID`); without them, CI signs ad hoc and macOS
  asks "Open Anyway" on first launch. The originals live in `~/.config/rocket-vibe/apple/`,
  **back them up**: the certificate's private key cannot be recovered.
- **`desktop-swiftui`**: the SwiftUI app for macOS (`apps/desktop/macos`, on `rv-ffi`), a
  reusable workflow: `desktop` calls it on a tag or a `workflow_dispatch`, and its release
  takes the DMG from it; it runs on its own on branches other than `master` that touch the
  app.

`node scripts/version.mjs mobile|desktop` prints an app's version and checks its
consistency. Each app keeps its changelog in the Keep a Changelog format
([mobile](apps/mobile/CHANGELOG.md), [desktop](apps/desktop/CHANGELOG.md)). To publish:
move the "Unreleased" section under the new version number, bump the version, then push a
`mobile-vX.Y.Z` or `desktop-vX.Y.Z` tag. The workflow checks that the tag matches the
version and that the changelog has its section, then creates the GitHub release with its
binaries and that section as notes.

## License & status

Personal project, under active development. Main branch: **`master`**.
