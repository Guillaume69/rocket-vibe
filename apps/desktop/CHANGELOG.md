# Changelog

Notable changes to the desktop app. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version lives
in `Cargo.toml`; a `desktop-vX.Y.Z` tag publishes the release, whose notes are the version's
section here.

## [Unreleased]

### Added

- Mouse back and forward buttons, and Alt+Left / Alt+Right: out of a thread, between the
  room list and the room in a narrow window, then through the rooms opened before.
- In a narrow window, a forward arrow on the room list goes back to the open room.
- Deleting a message asks for confirmation first.
- Messages are edited in place, in their own row (Enter saves, Escape cancels), and Up in an
  empty composer edits my last message.
- A button back to the latest messages shows once scrolled a screen or more above them.
- A click beside the picture closes the image viewer.

### Fixed

- In a narrow window, images, link previews and file cards shrink to fit instead of pushing
  the messages and the send button past the right edge.
- The play badge on video cards is a circle, the emoji button lines up with the microphone,
  and message times are no longer cut at the top.
- System messages, calls and locked encrypted messages no longer open an empty actions menu.

## [0.1.0] - 2026-09-27

First release: Linux, Windows and macOS, for Rocket.Chat 8 or later, at feature parity with
the mobile app (see `docs/PARITY.md`).

### Added

- Password sign-in with two-factor authentication (TOTP, email, password), a server check
  as its address is typed, known servers, and several accounts with switching.
- Offline first: one SQLite database per server and account, REST to act, DDP to listen,
  reconnection with catch-up of missed edits and deletions.
- Room list by activity in sections (unread, channels, direct messages), with presence,
  previews, unread badges and a new-conversation search.
- Messages: markdown, emoji including custom ones, mentions, quotes, threads, reactions,
  pinning, editing and deleting, per-room and per-thread drafts, `@` and `:` completion,
  an emoji picker.
- Files by chooser, drag-and-drop or paste, with captions and reduced images; two-step
  upload with progress, retry and discard; voice messages.
- Audio and video playback, link previews, YouTube / Dailymotion / Vimeo cards, a Jitsi
  call card, a typing indicator and a "new messages" marker.
- Search in a room, room information, profiles, my profile and settings.
- Desktop notifications, with inline reply where the desktop offers it (KDE Plasma).
- Reading end-to-end encrypted rooms once unlocked.
- `rocketvibe://` links.
- French and English.
- Packages: a Linux tarball; a Windows installer (per user, Start menu entry,
  `rocketvibe://` links) and zip; a macOS app in a DMG, signed with a Developer ID and
  notarized by Apple.

[Unreleased]: https://github.com/Guillaume69/rocket-vibe/compare/desktop-v0.1.0...HEAD
[0.1.0]: https://github.com/Guillaume69/rocket-vibe/releases/tag/desktop-v0.1.0
