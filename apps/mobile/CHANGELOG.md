# Changelog

Notable changes to the mobile app. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [Semantic Versioning](https://semver.org/). The version lives in
`app.json` (with `package.json` and `android.versionCode`); a `mobile-vX.Y.Z` tag publishes the
release, and its notes are that version's section here.

## [Unreleased]

## [0.6.0] - 2026-10-06

### Changed

- Tapping a search result now opens the room at that message. A pinned, starred or searched
  message older than what the room has loaded shows the conversation around it, whatever its
  age, instead of "Message not found in recent history". Scrolling reads on in both
  directions; the button at the bottom, or sending a message, comes back to the latest
  messages.

- The app moves its local data, settings and notification links to new internal names on
  the first launch after the update. You stay signed in, with your messages, language,
  collapsed sections and unsent messages; notifications already on screen still open and
  still take replies.

## [0.5.0] - 2026-10-03

### Added

- Slash commands: a `/` at the start of a message suggests the server commands you can run
  in the room, with their parameters and what they do; sending runs it, in the thread when
  you are in one. The server's reply (a room not found, `/help`) shows above the input,
  visible to you alone. A rejected command comes back into the input.

### Fixed

- A long press on a link or a mention opens the message actions, as anywhere else in the
  message; it used to open nothing.

## [0.4.0] - 2026-09-30

### Added

- A Favorites section in the room list, after Unread, for the rooms marked as favorite on
  the server (as in the official client); a room's info screen adds it there or removes it.

### Fixed

- The last-message preview in the room list showed markdown syntax (code delimiters,
  asterisks, link brackets): it now reads as plain text.

## [0.3.1] - 2026-09-29

### Fixed

- Attachments prepared in a room but not yet sent were lost when switching rooms: they now
  wait until you come back.

## [0.3.0] - 2026-09-29

### Added

- Encrypted room: once unlocked, you write in it as anywhere else. The message goes out
  encrypted (mentions still notify); while locked, it waits for the unlock instead of failing.
  You can also edit your messages and reply in a thread there.
- Encrypted room: photos, sounds and videos sent encrypted are displayed (decrypted on the
  device, up to 25 MB), and any encrypted file can be shared or saved in the clear.
  You can also attach files there: they go out encrypted, name and caption included.

### Fixed

- An encrypted room created by an old web client (AES-128 room key) is readable again once
  unlocked, instead of showing only "chiffrés, non pris en charge" ("encrypted, not
  supported") messages.

## [0.2.0] - 2026-09-29

### Added

- Room list: tapping a section title (Unread, Channels, Direct messages) collapses or
  expands it; collapsed, it shows its number of conversations, and the state is kept from
  one launch to the next.
- Room: once scrolled more than a screen up the history, a round button at the bottom right
  brings you back to the latest messages in one gesture.
- Messages: pin and unpin, add to and remove from favorites, from a message's actions. A 📌
  button in the room header opens its pinned messages and your favorites; tapping one scrolls
  the conversation back to it and highlights it, loading older history if needed.
- Composer: attachments wait to be sent as chips (thumbnail or icon, name, format and size,
  ✕ to remove); you can attach several at once, preview them with a tap, and the typed text
  goes out as the first one's caption.

### Changed

- A file the server rejects (size, type) is rejected as soon as it is attached, no longer at
  send time.

### Fixed

- A message's actions follow your actual rights on the server: no more "Épingler" ("Pin")
  without the permission, and a moderator can edit or delete other people's messages.
- A sent file keeps its original name; a copy made by the picker went out under a random
  cache name.
- Sharing to the app while it was not running does open the share screen, on the first try;
  and a share is no longer replayed on every later opening of the app.

## [0.1.0] - 2026-09-27

First published version: Android, for Rocket.Chat 8 or later.

### Added

- Password login with two-factor authentication (TOTP, email, password), session kept in
  secure storage.
- Offline first: one SQLite database per server and per account, which the UI observes;
  REST to act, DDP to listen, automatic reconnection and catch-up.
- Room list by activity, in sections (unread, channels, direct messages), with presence,
  previews, unread badges, and search for people and rooms.
- Message list: native markdown, emojis (custom ones included), mentions, quotes, threads,
  reactions, pinning, editing and deletion, per-room drafts.
- Two-step file upload (photos, downscaled videos, documents, voice messages), with
  progress, resume and cancel.
- Built-in audio and video playback, link previews, and YouTube / Dailymotion / Vimeo cards.
- Typing indicator, "new messages" bar, search within a room.
- FCM push notifications with hidden content, fetched on receipt; reply from the
  notification; room opened by a `rocketvibe://` link.
- Reading end-to-end encrypted rooms after unlocking.
- Jitsi video calls.
- Sharing from other apps to a room.
- Profiles, room info, my profile (status, photo, information).
- Interface in French and English.

[Unreleased]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.6.0...HEAD
[0.6.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.5.0...mobile-v0.6.0
[0.5.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.4.0...mobile-v0.5.0
[0.4.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.3.1...mobile-v0.4.0
[0.3.1]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.3.0...mobile-v0.3.1
[0.3.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.2.0...mobile-v0.3.0
[0.2.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.1.0...mobile-v0.2.0
[0.1.0]: https://github.com/Guillaume69/rocket-vibe/releases/tag/mobile-v0.1.0
