# Changelog

All notable changes are documented here in English.

## [Unreleased]

### Fixed

- Apply microphone processing before publication, and stop capture on processor failure or a failed retry before displaying the listening state.

- Match GTK settings categories, icons, profile subpages and administration navigation; remove text zoom and clock controls without GTK equivalents.
- Use thin rounded scrollbars, bounded administrator-list avatars and a styled profile-photo picker.
- Enter voice channels automatically, show their participants under the room and display the call in the main pane.
- Play audio attachments in place with seek, pause and volume controls, retaining playback during live reactions.
- Match GTK initials and 24-hour conversation times.

- Center unread and mention counters vertically and horizontally in their badges.
- Remove the redundant server field from sign-in; the service origin is shown as plain text.
- Center the conversation title in its header as GTK does.
- Serialize call teardown before rejoining and ignore stale voice grants after leaving or signing out.
- Restore drafts before enabling the editor so opening a fresh room cannot erase the first typed characters.

### Added

- GTK voice tile arrangement, connection header, native call controls and speaking halos in the call and room roster.
- Audio-device menu with real microphone gain and meter, output gain, deafen, browser noise suppression and retained per-person volume or local mute.
- Serialize screen claims with call teardown so a delayed share response cannot begin capture after leaving.

- Match the new master bots and workflows features: bot badges, scoped bot profiles and one-time keys, administrator policy, workflow triggers and steps, variable insertion, history, webhook URLs and message forms.
- Scope workflow command completion to the current room and dispatch hyphenated commands without plaintext fallback.
- Generate the feature labels and failure messages from the shared GTK catalog.

- Original RocketVibe unicorn favicon from the GTK application icon.
- Device-session details, renaming and confirmed revocation.

- Server-delivered, single-origin web client with the GTK theme, fonts, icons, emoji and sounds.
- GTK-style DOM composer with inline formatting, cursor-line markers, selection, undo/redo and plain-text paste.
- Durable session successor recovery after a lost response and serialized multi-tab renewal.
- Live ordinary conversations, threads, quotes, message actions, search, drafts and durable offline sending.
- Staged uploads and voice recordings, protected media caching, room/profile controls and administration.
- TOTP, recovery codes, verified email and email factors, device sessions and preferences.
- LiveKit audio/video calls, capture controls and browser notifications while the tab is alive.
- Encrypted rooms shown locked, with sending and media/call actions unavailable.
