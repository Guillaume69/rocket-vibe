# Changelog

All notable changes are documented here in English.

## [Unreleased]

### Added

- Native RocketVibe MLS encryption through the shared Rust engine in a WebAssembly worker, with identity/device approval, verified peers and explicit group creation/admission reviews.
- Protected private conversations, drafts, threads, local search, message actions and encrypted attachments, plus identity recovery, history sharing/backups and storage-key controls.
- Browser frame encryption using the native MLS voice exporter, with refusal when encryption is unavailable.

### Changed

- Render the browser application with React 19 and strict TypeScript, preserving the GTK theme, keyed media playback, ordinary/private threads and existing session/crypto engines.
- Load settings and administration panels on demand, with shared React dialogs, navigation, profile cards, message menus, dashboard and call controls.

### Fixed

- Observe LiveKit's asynchronous audio-output changes on the call-owned context, preventing late device-switch rejections after voice teardown.
- Refetch a read when the server requests delivery-lease revalidation, with bounded retries and no automatic mutation replay.
- Keep ordinary voice joins usable when the server omits its false E2EE flag, while continuing to reject encryption mismatches.
- Keep the selected settings category when the administration permission lookup finishes after the user has already changed pages.
- Reopen private views after a fresh membership snapshot without exposing ordinary cached content.
- Keep encrypted voice access independent of message sending, and finish identity recovery before loading controls that require a registered device.

## [0.3.0] - 2026-10-09

### Added

- Server administration: a Server icon card on the Dashboard to set or remove the server's icon; the tab shows it as its icon.
- Server administration: a Custom emoji page where administrators add emoji (name, aliases, image) and delete them.

### Changed

- The account block shows a gear and opens a menu (Settings, Server administration for administrators, Sign out); sign out left the header. The header's "+" is a menu (New message, Browse channels, Create a channel), and the Channels and Direct messages headings carry their own "+".

## [0.2.0] - 2026-10-09

### Fixed

- Open the GTK-style user profile from conversation avatars and author names, with live identity/presence, Message, Call and Report actions.
- Renew browser presence while connected, clear it on signout, and discard expired observations in an open profile.
- Fetch the DM's personal access state before opening it from a profile so Message and Call remain usable.
- Preserve a newly typed draft and a newly selected quote while an earlier send is being saved, including after switching conversations.
- Send queued text in creation order and continue with messages added while the queue is already sending.
- Ignore superseded reconnect, history, thread and message-action responses after account or conversation access changes.
- Remove delayed private previews and uploads after access withdrawal, and keep personal stars independent of public message revisions.
- Serialize signout with session renewal so an online signout revokes the current device session.
- Keep the new caller connected when another tab or device takes over the same account's voice session.
- Clean up a failed incoming-call acceptance, reject stale membership grants, stop delayed camera capture after leaving, and restore the avatar when a camera is muted.
- Show the result-variable field when adding HTTP or message steps to a workflow.

- Match GTK's administration dashboard typography, card rows, column spacing, responsive collapse and refresh icon inside the deployment header.
- Use the shared GTK administration labels and full native deployment, presence, room/message, upload and report fields; restore instance copying, moderation badges/navigation and the bot-policy switch's refusal behavior.

- Mark incoming messages read while their channel is visible, focused and at the latest message, even when the timeline never scrolls; preserve GTK's captured-message delay and cancel pending reads on navigation.
- Keep inactive tabs, earlier history and hidden call views unread, and dismiss room notifications after their unread messages have been read.

- Keep workflow messages marked BOT after live author-profile refreshes and page reloads.

- Report failed initial WebRTC connections instead of silently closing the connecting page, and allow a clean retry after the failure.

- Replace invented per-image 1600/960-pixel options with GTK's parked Original-quality choice; prepare JPEG at 1920 pixels and quality 82 only when sending.
- Match staged-file thumbnails, name/type/size rows and inline sound replay, with no separate stock-player or caption/quality dialog.
- Enqueue a file batch atomically in selection order and apply the caption to its first file only.
- Use GTK's recording bar, elapsed counter, cancel action and stop-to-listen control; cancel releases the microphone and stages nothing.

- Show image attachments in GTK's standalone cropped frame, with its inline size limits and full-size viewer geometry.
- Add the native image context menu for copying, saving as PNG and downloading for another application; close and clear private viewers when room access is withdrawn.

- Keep audio, video and embedded-site players connected during message updates, including fullscreen video during live reactions.
- Match GTK's video attachment frame, first image, inline controls, elapsed/remaining counters and file caption; put audio controls below the file header.
- Recognize canonical YouTube, Dailymotion and Vimeo links, including short and live URLs, deduplicate them and show at most three native-style cards per message.
- Identify video embeds with the service origin while withholding room paths and bearer tokens, and restore the thumbnail when playback is stopped.
- Show protected download progress using the attachment's known size, including chunked responses without a content length.
- Preserve the voice-recording stop control through live upload refreshes, and stop delayed microphone capture after room or session changes.

- Apply microphone processing before publication, and stop capture on processor failure or a failed retry before displaying the listening state.
- Detect quiet speech from decoded audio with GTK's thresholds, meter decay and speaking hangover, and send the native deafen attribute.
- Return the sidebar call panel to the active call's room.

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
- GTK screen-share quality choices, main stage and camera/person strip, with the browser source picker and fullscreen following share takeover.
- Guarded screen sound and the native opt-in call mix; capture without confirmed call-audio exclusion keeps video only.
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

[Unreleased]: https://github.com/Guillaume69/rocket-vibe/compare/web-v0.3.0...HEAD
[0.3.0]: https://github.com/Guillaume69/rocket-vibe/compare/web-v0.2.0...web-v0.3.0
[0.2.0]: https://github.com/Guillaume69/rocket-vibe/releases/tag/web-v0.2.0
