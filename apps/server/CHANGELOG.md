# Changelog

Notable changes to the RocketVibe server. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version lives
in `apps/server/Cargo.toml`; a `server-vX.Y.Z` tag publishes the release (a Linux x86_64
binary), whose notes are the version's section here. 0.2.0 is the first release:
everything before it is under that section.

## [Unreleased]

## [0.2.0] - 2026-10-09

### Added

- First published release of the native RocketVibe chat server (Rust, PostgreSQL), as the apps and the web client use it: accounts with second factors, recovery and device sessions, public, private and direct rooms, threads, reactions, pins, stars, quotes, search, uploads and link previews, live sync over a WebSocket, push, private end-to-end encrypted rooms, voice over LiveKit, bots, workflows, slash commands, reports and in-app administration. Published as a Linux x86_64 binary.
- The server has an icon of its own, set and removed by an administrator from the apps (`PUT`/`DELETE /api/v1/admin/icon`, capability `instance_icon`), public at `GET /api/v1/instance/icon` and announced by `icon_revision` in the discovery document.
- Administrators add and remove custom emoji from the apps (`PUT`/`DELETE /api/v1/admin/emoji/{name}`, capability `custom_emoji_admin`), with per-administrator receipts and the administrator named in the operator journal.
- Embed the native web client in the server binary and Docker image, serving explicit application routes and immutable hashed assets without a Node runtime.
- Accept browser-recorded audio WebM with the same EBML header validation as video WebM.

### Fixed

- Preserve bot identity in live profile observations so author refreshes keep the BOT badge on bot and workflow messages.

[Unreleased]: https://github.com/Guillaume69/rocket-vibe/compare/server-v0.2.0...HEAD
[0.2.0]: https://github.com/Guillaume69/rocket-vibe/releases/tag/server-v0.2.0
