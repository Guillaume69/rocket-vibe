# Changelog

Notable changes to the desktop app. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version lives
in `Cargo.toml`; a `desktop-vX.Y.Z` tag publishes the release, whose notes are the version's
section here.

## [Unreleased]

### Changed

- Files chosen, dropped or pasted wait in the composer as chips (thumbnail, name, type and
  size, a button to remove them, a click to preview) and leave with the text typed as their
  caption, instead of going through a dialog. Images are reduced unless "original quality"
  is ticked.

- The app id is now `com.rocketvibe.app`, as on mobile (desktop entry, macOS bundle, D-Bus
  name). Sessions are kept. On Linux, run `scripts/install-desktop.sh` again to replace the
  launcher entry; on macOS the keychain may ask once to let the renamed app read it.

### Added

- Mouse back and forward buttons, and Alt+Left / Alt+Right: out of a thread, between the
  room list and the room in a narrow window, then through the rooms opened before.
- The mouse selects across the lines of a message, and a selection is plainly visible.
- In a narrow window, a forward arrow on the room list goes back to the open room.
- Deleting a message asks for confirmation first.
- Messages are edited in place, in their own row (Enter saves, Escape cancels), and Up in an
  empty composer edits my last message.
- A button back to the latest messages shows once scrolled a screen or more above them.
- A click beside the picture closes the image viewer.
- Room list sections fold and unfold with a click on their title (or Enter); folded, they show
  how many rooms they hold, and stay folded at the next launch.
- File cards have a Download button that saves the file to the Downloads folder.
- Message actions: Star and Unstar, and Unpin on a pinned message.
- A formatting toolbar under the message field (bold, italic, strike, heading, link, code, code
  block, quote, lists) with keyboard shortcuts, and the draft shows its formatting as it is
  typed.
- A pin button in the room header lists the room's pinned messages and my starred ones; a
  click goes to the message, loading older history as far as needed.
- Videos show as a player in place: first image and a play button (files up to 25 MB), then
  playback in the same frame with a controls bar and fullscreen; a format the system cannot
  decode says so and offers another application.
- Settings, About: the version, and the folder of the logs with a button to open it. A panic is
  recorded in `crash.log` with its backtrace; on Windows the previous run's log is kept.
- The app icon: in the launcher entry (installed by `scripts/install-desktop.sh` and shipped in
  the Linux archive), on the window wherever the app runs from, and in the Windows executable.
- A click on a notification opens its message: the room scrolls to it and highlights it.
- Settings, Notifications: what shows them (and whether it takes replies), a test notification,
  and on Windows and macOS a shortcut to the system's notification settings.
- On Linux docks that support it (KDE Plasma, Dash to Dock, Plank), the app icon shows the
  number of unread direct messages and mentions.
- Hovering an emoji in a message shows it large with its shortcode; hovering a mention shows
  the person's photo, name and username.

### Fixed

- Opening a room with Enter or a double click in the room list opened the room one or two
  rows off (the section titles were not counted).
- Open on a file did nothing on Linux desktops without the GNOME portal: it falls back to the
  default application, then `xdg-open`, and says so when nothing can open it.
- Files dropped on the message field were inserted as text instead of being attached, and
  pictures dragged from a web page were refused; both are now attached, and the room is
  outlined while something is dragged over it.
- Clicking a desktop notification (KDE Plasma and other freedesktop servers) aborted the app
  when it opened the room.

- In a narrow window, images, link previews and file cards shrink to fit instead of pushing
  the messages and the send button past the right edge.
- The play badge on video cards is a circle, the emoji button lines up with the microphone,
  and message times are no longer cut at the top.
- System messages, calls and locked encrypted messages no longer open an empty actions menu.

## [0.1.0] - 2026-09-27

First release: Linux, Windows and macOS, for Rocket.Chat 8 or later, at feature parity with
the mobile app (see `docs/PARITY.md`).

### Changed

- Files chosen, dropped or pasted wait in the composer as chips (thumbnail, name, type and
  size, a button to remove them, a click to preview) and leave with the text typed as their
  caption, instead of going through a dialog. Images are reduced unless "original quality"
  is ticked.

- The app id is now `com.rocketvibe.app`, as on mobile (desktop entry, macOS bundle, D-Bus
  name). Sessions are kept. On Linux, run `scripts/install-desktop.sh` again to replace the
  launcher entry; on macOS the keychain may ask once to let the renamed app read it.

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
