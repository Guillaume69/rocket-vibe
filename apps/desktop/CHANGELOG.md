# Changelog

Notable changes to the desktop app. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version lives
in `Cargo.toml`; a `desktop-vX.Y.Z` tag publishes the release, whose notes are the version's
section here.

## [Unreleased]

### Fixed

- Personal profiles, status, photos, language and notification preferences now
  use the existing GTK and SwiftUI settings with either server. Native changes
  survive retries; rejected changes can be resumed or discarded, and verified
  email remains in the existing security flow. Profile notifications no longer
  cancel downloads of current native avatars.

- Native public profiles and protected avatars use the existing GTK and SwiftUI
  dialogs and message tiles. Identity changes refresh displayed names; profile
  actions open direct conversations by stable user ID.

- Native message search uses the existing GTK dialog and SwiftUI search view,
  with authorized temporary results, thread replies and Enter to search again.
  Suspension and content changes clear stale results.

- Native presence and typing use the existing GTK / SwiftUI indicators and
  composers, expire after disconnection, and clear on suspension. Native @here
  mentions capture the members present when the message is sent.

- Native threads use the existing GTK and SwiftUI panels, menus and composers.
  Replies retain their root across offline retries; thread drafts and observed
  reads stay separate. Quotes work inside threads, and a deleted root preserves
  the draft while preventing new replies.
- Native quotes render two levels in the existing GTK and SwiftUI cards.
  Each source keeps its own access checks; removing a nested source clears its
  private text without hiding a still accessible parent.
- Native room activity uses the existing translated system rows in GTK and
  SwiftUI. Membership and settings changes stay out of unread badges and
  message actions.
- GTK and SwiftUI reuse their reply controls for native message references.
  Quoted sends survive retries; a rejected selection keeps the entered words.
  Unavailable sources have a translated label and discard private previews.
  GTK now renders native quotes in the existing cards without an RC session.

- A stale native editor keeps its unsent words and reports `revision_conflict`
  when the cache already contains a newer message. Quote references are captured
  only for the matching revision.

- Native edits preserve ordered quote references after source deletion or access
  withdrawal, including retries and cache restarts. Older edit intents without a
  captured body retain their draft and require a fresh submission.

- Native quote cards retain source text that resembles a legacy quote prefix;
  official Rocket.Chat quote-prefix handling remains available.

- Native room composers bind draft saves and sends to the membership that
  opened them. Withdrawal or a new membership clears open room buffers and
  closes private forms; delayed callbacks cannot overwrite a fresh draft.
  Role changes preserve the current draft.

- Native caches detect room withdrawal followed by rejoining even after a missed
  event and a snapshot reset. Older private history, drafts and pending commands
  are purged, while role changes keep the current membership's intentions.
  Learning the first membership stamp also clears unstamped legacy intentions.
- Native room composers follow effective write permissions after room settings
  or role changes. Owners and moderators can still write in read-only rooms;
  members use the existing read-only presentation. Older responses cannot
  restore cached permissions after withdrawal or a new room revision.

- SwiftUI security can copy the original private backup-code receipt while the
  native connection restarts after a factor change. Reading retries retain the
  displayed revision and family; closed views and stale confirmations still fail.

### Added

- Native quoted messages reuse the existing GTK / SwiftUI quote cards. Source
  edits and deletions refresh cached excerpts across rooms; withdrawal or a new
  membership removes private excerpts and rejects delayed responses. Quote
  sending remains disabled until the existing reply controls and outbox are wired.

- Native message bodies adapt to the existing GTK and SwiftUI renderers from a
  shared typed document. Composer bold / italic / strike markers keep their
  current behavior; escaped mentions, code, quotes and link labels do not gain
  mention highlighting. Markdown images remain literal until native uploads.

- Native unread / mention badges and the existing new-messages divider in GTK
  and SwiftUI. Read timers retain a displayed confirmed message and its opening
  membership; later arrivals cannot postpone the timer or replace that message.
  Hidden windows and open panels do not observe new messages. Confirmed badges
  remain while offline; the opening divider stays after a read acknowledgement.

- Native favorites in the existing GTK and SwiftUI room information panels and
  sidebar menus. Only confirmed preferences move rooms into favorites; pending
  requests can resume and rejected requests can be explicitly cleared. A stale
  click cannot replace a newer preference or cross a membership change. The
  SwiftUI sidebar also offers the official Rocket.Chat favorite action.

- Native read and favorite intentions survive process restart in SQLite.
  Read retries retain the observed message position; favorite retries recover
  the original receipt without restoring an older preference. Delayed read
  callbacks cannot cross withdrawal and rejoining.

- Existing GTK and SwiftUI room information panels offer native room settings,
  paginated members, roles and departure according to current permissions.
  Interrupted commands resume their original receipt; rejected forms require
  explicit dismissal or review. Leaving the last owner explains how to transfer
  ownership first.

- Existing GTK and SwiftUI room information panels display native topics,
  descriptions, announcements, member counts and read-only status. Room changes
  refresh the panel; withdrawal or account closure discards it. GTK keeps its
  existing owner invitation form accessible from the room information panel.

- Request a password recovery code by email from the existing GTK / SwiftUI
  sign-in forms. Opening the form reads private storage only; interrupted requests
  resume the original operation, with persisted retry limits and explicit local
  dismissal. Password reset still asks for installed second factors at sign-in.

- Explicit email-factor activation and removal in the existing GTK / SwiftUI
  security settings, with approval pinned to the displayed contact and profiles,
  durable receipt recovery and shared backup codes. Removing one factor keeps
  another installed factor; contact changes explain why email codes must first
  be disabled.

- Email second-factor sign-in and identity confirmation in the existing GTK / SwiftUI
  forms, with explicit delivery, original-attempt recovery across restarts,
  delivery status and bounded resend. Input codes stay transient; confirming
  identity keeps the current session family and the proof's original age.
  Swift uses opaque, revision-bound handles; closed forms cannot request mail.

- Private email removal in the existing GTK and SwiftUI security settings,
  with confirmation bound to the displayed contact, one durable operation
  across lost replies and restarts, cancellation and explicit acknowledgement.
  Contact settings remain available without SMTP; a new verification requires
  its advertised capability. Removal keeps two-factor authentication enabled.

- Private email verification in the existing GTK and SwiftUI security settings:
  delivery status, original-attempt recovery after lost replies and process
  restarts, explicit cancellation and receipt acknowledgement. GTK and Swift
  share the system-keychain vault; input codes stay transient and stale view
  confirmations cannot affect a newer attempt.

- Native security in the existing SwiftUI settings, sharing the GTK private
  system-keychain vault. Opaque FFI handles keep proof and operation IDs private;
  confirmations bind to the displayed revision, and copied secrets are checked
  again before entering the clipboard. Hiding settings or switching accounts
  clears transient input and blocks late callbacks. Original backup receipts
  survive a process restart and lost responses.

- Native security in the existing GTK preferences: confirm identity on the
  current device family, configure TOTP, explicitly save backup codes,
  regenerate them or disable the factor. Private system-keychain intents resume
  lost responses and survive process restarts; closed views and reconnected
  providers reject late callbacks.

- Native TOTP and backup-code sign-in in the existing GTK / SwiftUI forms, with a private
  system-keychain proof, recovery after a lost response and activation only
  after session storage succeeds. Hiding or leaving the form invalidates late
  responses. Swift keeps opaque attempts and activates after account-selection
  checks; replaying a committed attempt cannot rewind renewed credentials.
  Rocket.Chat keeps its existing factor flow.

- Operator-code password recovery in the existing GTK / SwiftUI sign-in forms,
  preserving account identity and conversations while revoking old sessions.
  Lost acknowledgements resume once; encryption keys remain unchanged.

- Invitation signup in the existing GTK and SwiftUI sign-in forms, offered only
  by capable RocketVibe servers. Lost acknowledgements resume the same account;
  instance, generation and user checks precede secure session storage.

- Native signed-in devices in the existing settings, with names, activity and
  expiry dates. Another device can be revoked after a recent sign-in; retained
  controls cannot act after switching accounts.

- Native sessions renew before expiry through the system keychain. A durable
  successor recovers a lost response, and GTK / Swift serialize credential writes
  without discarding SQLite drafts or pending actions.

- Native pins and private stars in the existing GTK / SwiftUI menus and marked
  lists. Explicit states survive restarts; personal revisions prevent concurrent
  public message updates from clearing a star.

- Native reactions in the existing GTK and SwiftUI menus and message chips.
  Emoji aliases share one state; pending actions survive lost responses and
  restarts without changing message order or marking the text as edited.

- Native edit/delete actions in the existing GTK and SwiftUI menus and editors.
  SQLite commands retain their operation IDs and original revisions across
  retries and restarts; rejected edit drafts remain available for review.
  Stale editors report a conflict, and closed account providers reject actions.

- Native edits and tombstones in the existing GTK / SwiftUI message renderer.
  Cursor resets replace confirmed history while retaining live-room drafts and
  outbox; older in-flight responses cannot restore discarded or deleted content.

- Native request IDs and server retry delays remain available through provider
  errors, connection status and Swift bindings, including locally deferred retries.

- Native public rooms in the existing GTK / SwiftUI search and join flows;
  interrupted room creation keeps its SQLite operation ID across retries and restarts.

- Native sends remain retryable after a permission revalidation race and preserve
  their durable operation ID during reconnection.

- Materialized native snapshots shared by GTK and SwiftUI, assembled and validated
  before the atomic cache update, with bounded pages and older-server compatibility.

- Native feature discovery shared by GTK and SwiftUI, limited to features implemented
  by both the server and the installed client.

- Native login / socket-ticket retries honor the server's `Retry-After` delay,
  including across cloned transports, without discarding the saved account.

- Rocket.Chat and RocketVibe accounts in the existing GTK chat interface: login, rooms, invitations,
  DMs, text, history, persistent drafts and a durable SQLite outbox. Native identity
  pins and caches are kept separate from Rocket.Chat accounts.
- Explicit UniFFI native-chat API and a disposable PostgreSQL integration bench
  exercising the mobile runner and actual GTK application.
- Formatting controls scroll horizontally in narrow windows so the send button
  stays visible.
- Rocket.Chat and RocketVibe in the existing SwiftUI interface: shared login,
  room and message views, account switching, durable offline sends, drafts and DMs.
  Missing native capabilities are disabled; callbacks from a previous account stop
  affecting the active view. A real Secret Service keyring exercises secure resume
  in the Linux view-model integration bench.

## [0.5.0] - 2026-09-30

### Added

- Animated GIFs play, in the list and in the image viewer, only while on screen. A GIF search
  result or a bot's picture shows its title as a link to its page.
- Bot and integration attachments show as cards: author, linked title, text and fields, with
  their colour down the side.
- A right click on a picture in the viewer copies it, saves it or opens it in the default app.
- Calls open in a window of the app instead of a browser tab: WebView2 on Windows, WKWebView
  on macOS (the SwiftUI app too). The window stays on the meeting's own site: only that site
  gets the camera and the microphone, any other link opens in the browser. On Linux, where
  distributions build WebKitGTK without the WebRTC a meeting needs, the call opens as an app
  window of Chromium, Chrome, Brave, Edge or Vivaldi when one is installed, else in the browser.
- An information button on the call card shows the meeting link, to copy or open in the
  browser, like the official client's.
- A Favorites section in the room list, after Unread, for the rooms starred on the server
  (as in the official client); a right click on a room adds it or takes it out.
- Shift+Enter continues a list in the composer: the same bullet, or the next number, at the
  same indentation; on an empty item it ends the list.

### Changed

- The macOS SwiftUI app wears the rocket-vibe look: the night palette, the gradient wordmark
  and sync comet, Android avatar colours, Baloo 2 and Nunito, pink and yellow badges, the
  sparkle marker, the pill composer with its gradient send button, and springs where things
  move. It scrolls smoother: pictures decode in the background at the size drawn and stay
  cached, unchanged messages are not redrawn, and bursts of server events reload once.
- Text selects across messages as in a browser: drag from one message into others and the
  selection runs through them in reading order, scrolling the list at its edges; Ctrl+C
  copies it. The selection of whole messages from the avatar column is gone.

### Fixed

- Logs could grow without bound: a GTK critical repeated four million times made a 300 MB
  log. A message repeated back to back is now written once and counted, and a run writes
  5 MB at most.
- Windows: the app crashed after a keyboard layout change (Win+Space, Alt+Shift, or Windows
  switching layouts per window) while typing: GTK left its input method behind. The input
  method is now fixed, so a layout change no longer swaps it.
- Audio and video files did not play on Windows (decoders missing from the package) nor on
  macOS (Homebrew's GTK has no media backend; the app now plays through GStreamer itself).
  Both play Ogg (voice messages from this app), AAC (from the Android app) and H.264 video.
  An audio file that cannot play says so.
- Windows: the logs moved to `%LOCALAPPDATA%\rocket-vibe-rs`, out of the Internet cache that
  Disk Cleanup empties. Settings, Logs opens the folder.
- A code block closed at the end of its last line, or opened and closed on one line, was
  posted as a list or with stray backticks: the fences now get lines of their own.
- Long lines in code blocks wrapped with inserted hyphens, which also ended up in copies.
- The room list turned grey while the window was not focused.
- Server emoji showed as boxes in headings and list items, and a message of server emoji
  alone showed them small; in bold or struck text the words around them disappeared (the
  "Invalid markup" warnings in the log).
- Messages that come without the server's parsed form (bots, integrations) showed their raw
  text: `[label](url)` links, `:emoji:` codes and formatting now render.
- Pinned and starred messages showed raw markdown; they render as in the room.
- Room list previews showed markdown syntax (fences, stars, link brackets); they read as text.
- A message with a picture, a video or a link card could be drawn over the next messages: rows
  were sized for the picture at its narrowest.
- Images from GIF searches and bots showed as empty frames: their page was fetched instead of
  the image, and hosts that require a User-Agent refused the request.
- Clicking the dimmed backdrop around the image viewer now closes it; a double click there no
  longer maximizes the window.
- Times in the room list and beside messages lost the top of their digits at small or
  fractional scales.
- Windows: opening a call could leave a blank window and freeze the app: the page was made
  from inside the engine's own start-up, which sometimes hung. It is now made once start-up
  has returned.

## [0.4.1] - 2026-09-29

### Added

- On Windows and macOS, closing the window no longer quits: the app keeps running, and
  notifications keep coming. On Windows it sits in the notification area (a click brings the
  window back, a right click offers Open and Quit); on macOS the Dock brings it back. Quit,
  Cmd+Q or Ctrl+Q leave for real. Switched off in Settings, Startup and background.
- Start at login, from the same section, without opening the window (Windows and macOS).
- The app icon shows a dot for unread messages when none mentions you or comes as a direct
  message; the count stays for those (Windows taskbar and notification area, macOS Dock).
- On Windows, opening the app, or a `rocketvibe://` link, while it already runs brings its
  window back instead of starting a second one.
- A Linux AppImage that runs on any distribution, Ubuntu LTS and Debian stable included,
  with nothing installed: GTK, GStreamer and its video codecs, the dictionaries and the
  emoji font are all inside. One line installs it for the current user, with its launcher
  entry and `rocketvibe://` links:
  `curl -fsSL https://raw.githubusercontent.com/Guillaume69/rocket-vibe/master/apps/desktop/scripts/install.sh | sh`
  (`| sh -s -- --uninstall` removes it). The update card replaces the AppImage in place.

### Fixed

- On Windows, a blank icon named `rocket-vibe-gtk.exe` appeared in the notification area
  once a room was opened: GLib's own notification backend, woken by clearing the room's
  toasts, which the app's native notifications already do.

## [0.4.0] - 2026-09-29

### Added

- A native macOS app, in SwiftUI over the same Rust core, for testers who find the GTK app
  laggy on a Mac: `rocket-vibe SwiftUI`, its own DMG, installable beside the GTK one. It
  shares the GTK app's accounts, caches, language and E2E key. Rooms, threads, markdown,
  images, files, cards, reactions, editing, the actions menu, uploads, voice messages (AAC),
  encrypted rooms, notifications with a reply field and the dock badge.
- The server's own emoji in the emoji picker: a tab of their own, and first in a search.
- The @ and : suggestions show the person's card and the server emoji's picture; hovering a
  server emoji in a message shows it large with its shortcode.
- The app tells when a newer version is out: a card at the foot of the room list, with what is
  new and an Update button. On Linux it replaces the binary in place and offers to restart, on
  Windows it runs the installer and reopens, on macOS it downloads and opens the disk image.
  Checked at startup (every 6 hours at most) and from Settings, where it can be turned off.

### Fixed

- In a short window (a tiling slot of about 300 px), the composer was cut off: the window
  asked for 480 px of height.
- A paragraph holding both a server emoji and a mention or a link lost everything before
  the emoji; its mentions now show their card on hover like any other.
- Ctrl+C (and Ctrl+Insert, which Omarchy's Super+C sends) did nothing on text selected in a
  message; only the right-click menu copied it.
- A selection now runs across a message's blank lines, and dragging it into another message
  selects the whole messages in between, copied with Ctrl+C.
- Files waiting in the composer were lost when another room was opened; they now wait in
  their room.
- The emoji picker showed boxes for emoji this computer's fonts cannot draw, which also
  spread its grid wide: they are left out.
- A picture measured before its width was known could take no room and slide under the
  next messages.

## [0.3.0] - 2026-09-29

### Added

- Encrypted rooms, once unlocked, are written in like any other: messages leave encrypted (mentions
  still notify), and a message sent while locked waits for the unlock. Edit and Reply in thread
  work there too.
- Unlocking an encrypted room lasts: the E2E key is kept in the system keychain with the
  session, as the web client keeps it, so the next launch opens unlocked. Locking or signing
  out forgets it; the password itself is never kept.
- Photos, sounds, videos and files sent encrypted show in their room once unlocked, under their
  real name, and open or save in clear.
- Files can be sent in an encrypted room too: they leave encrypted, name and caption included.
  A server that refuses encrypted files says so as soon as the file is attached.

### Fixed

- An encrypted room created by an older web client (AES-128 room key) reads once unlocked,
  instead of showing every message as undecipherable.

## [0.2.0] - 2026-09-29

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
- Several messages at once: press in the left gutter (avatar, time) and drag, or Shift+click, to
  pick whole messages; Copy (or Ctrl+C) puts them on the clipboard with their author and time.
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
  block, quote, lists) with keyboard shortcuts, and the draft shows as formatted text, its
  markdown markers hidden except on the line being edited, as it is
  typed.
- Spell check of the message field, French and English at once: unknown words are underlined,
  a right click offers suggestions and "Add to dictionary".
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
- Where the notification server has no reply field (GNOME), notifications get a Reply button
  that opens the message with the message field ready; Windows and macOS notifications now
  come from the system itself, with a reply field and the unread count on the taskbar or dock.
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
- The actions menu follows my permissions: Pin only where I may pin, and Edit and Delete on
  others' messages where I moderate.
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

[Unreleased]: https://github.com/Guillaume69/rocket-vibe/compare/desktop-v0.5.0...HEAD
[0.5.0]: https://github.com/Guillaume69/rocket-vibe/compare/desktop-v0.4.1...desktop-v0.5.0
[0.4.1]: https://github.com/Guillaume69/rocket-vibe/compare/desktop-v0.4.0...desktop-v0.4.1
[0.4.0]: https://github.com/Guillaume69/rocket-vibe/compare/desktop-v0.3.0...desktop-v0.4.0
[0.3.0]: https://github.com/Guillaume69/rocket-vibe/compare/desktop-v0.2.0...desktop-v0.3.0
[0.2.0]: https://github.com/Guillaume69/rocket-vibe/compare/desktop-v0.1.0...desktop-v0.2.0
[0.1.0]: https://github.com/Guillaume69/rocket-vibe/releases/tag/desktop-v0.1.0
