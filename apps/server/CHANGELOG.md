# Changelog

Notable changes to the RocketVibe server. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version lives
in `apps/server/Cargo.toml`; a `server-vX.Y.Z` tag publishes the release (a Linux x86_64
binary and the `ghcr.io/guillaume69/rocketvibe-server` image), whose notes are the version's section here. 0.2.0 is the first release:
everything before it is under that section.

## [Unreleased]

### Added

- Admin-only, retry-safe account invitation creation, listing and revocation; secrets remain hashed in storage.
- Sign in with the verified email address of an account instead of its username, on `/auth/login` and `/auth/start`; a pending or unknown address fails like a wrong password.

- The Docker image is published to `ghcr.io/guillaume69/rocketvibe-server` on each release and carries a title, a description and its source repository (OCI labels).

### Changed

- A verified email address belongs to one account: confirming an address another account already holds answers `409 email_address_taken`. Migration 0062 keeps addresses two accounts already shared as contacts but not as sign-in identifiers.

### Fixed

- Preserve a room's reviewed encryption policy when only its name, texts or voice-channel flag changes; actual privacy and read-only changes still invalidate the old policy.

- Convert IPv4-mapped trusted proxy prefixes to their IPv4 width, preserving exact address boundaries and rejecting broader ambiguous mappings.

## [0.4.0] - 2026-10-11

### Added

- Owner-managed channel images: authenticated, versioned PNG reads, bounded PNG/JPEG uploads, idempotent room-command receipts and the additive room_avatars capability. Private room images remain restricted to current members.

- Quick polls and game-night RSVP cards with durable, idempotent answers, optional poll expiry and author closure.
- Private sticker shelves, typed image messages and transient, connected-only voice reactions.
- Optional server-side GIPHY search, configured with a private RV_GIPHY_CONFIG_FILE; keys never travel to apps.


- Thread list and following: `GET /api/v1/rooms/{id}/threads` lists a room's threads, all or the ones I follow, latest reply first, paged, with my unread replies; `PUT /api/v1/messages/{id}/follow` follows or unfollows one, and my other sessions see it live. The root's author and every replier follow automatically. "Also send to the room": a thread reply sent with `also_in_room` also shows in the room's history for the clients that ask for it (`?also_in_room=true`). New capabilities `thread_list`, `thread_follow` and `thread_also_in_room`; older clients see nothing change.

## [0.3.0] - 2026-10-11

### Added

- Scheduled messages: a member schedules a text message (a thread reply too) between one minute and 30 days ahead; the server sends it at that time as its author, once, even if no app runs, and keeps the ones it could not send for their author to see. Not in end-to-end encrypted rooms.
- Read receipts: the live frame carries how far the other members of a small room (50 members at most) read it. An account preference turns them off both ways: its reads are hidden and it sees no one's.
- Do not disturb: an account's preferences take quiet hours (a daily window in its time zone) and a mute until an instant (at most seven days). While either holds, no push is sent and no device rings for a call; messages still arrive. A client that does not know the new fields keeps them unchanged.

### Changed

- The embedded web client supports native MLS encrypted conversations through WebAssembly and uses React rendering, with room switching, read receipts, quick activity choices, scheduled messages and do-not-disturb controls.

### Fixed

- Behind a reverse proxy, the login, invitation, recovery and email limits count each client separately: `RV_TRUSTED_PROXIES` lists the proxies whose `X-Forwarded-For` names the client, and the Compose file sets it. Before, every client shared the proxy's address, and about thirty failed logins a minute locked everyone out.

## [0.2.0] - 2026-10-09

### Added

- First published release of the native RocketVibe chat server (Rust, PostgreSQL), as the apps and the web client use it: accounts with second factors, recovery and device sessions, public, private and direct rooms, threads, reactions, pins, stars, quotes, search, uploads and link previews, live sync over a WebSocket, push, private end-to-end encrypted rooms, voice over LiveKit, bots, workflows, slash commands, reports and in-app administration. Published as a Linux x86_64 binary.
- The server has an icon of its own, set and removed by an administrator from the apps (`PUT`/`DELETE /api/v1/admin/icon`, capability `instance_icon`), public at `GET /api/v1/instance/icon` and announced by `icon_revision` in the discovery document.
- Administrators add and remove custom emoji from the apps (`PUT`/`DELETE /api/v1/admin/emoji/{name}`, capability `custom_emoji_admin`), with per-administrator receipts and the administrator named in the operator journal.
- Embed the native web client in the server binary and Docker image, serving explicit application routes and immutable hashed assets without a Node runtime.
- Accept browser-recorded audio WebM with the same EBML header validation as video WebM.

### Fixed

- Preserve bot identity in live profile observations so author refreshes keep the BOT badge on bot and workflow messages.

[Unreleased]: https://github.com/Guillaume69/rocket-vibe/compare/server-v0.4.0...HEAD
[0.4.0]: https://github.com/Guillaume69/rocket-vibe/compare/server-v0.3.0...server-v0.4.0
[0.3.0]: https://github.com/Guillaume69/rocket-vibe/compare/server-v0.2.0...server-v0.3.0
[0.2.0]: https://github.com/Guillaume69/rocket-vibe/releases/tag/server-v0.2.0
