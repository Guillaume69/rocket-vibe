# Changelog

Notable changes to Vibez, the server formerly named RocketVibe, and the web client compiled into
it (entries marked "Web client", which had their own `web-v` releases up to 0.6.0). Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version lives in
`apps/server/Cargo.toml`; a `vibez-vX.Y.Z` tag publishes the release (the Linux x86_64 binary
`vibez-X.Y.Z-linux-x86_64.tar.gz` and the `ghcr.io/guillaume69/vibez` image; up to 0.5.0, `server-v`
tags and the `rocketvibe-server` image), whose notes are the version's section here. 0.2.0 is the
first release: everything before it is under that section.

## [Unreleased]

### Changed

- Web client: a private room shows a lock on its coloured tile in the room list and the room header, so it no longer looks like a public channel, which keeps `#`. Encrypted rooms keep their neutral lock.
- Web client: integration cards show their title, text and field values formatted (emoji, links, bold) instead of raw markdown, as the other apps do.

## [0.8.0] - 2026-10-14

### Added

- Web client: a link to a post on X (Twitter) shows as a card like the post, with the author, the text and its picture, opened on X.

### Fixed

- The preview of an X post without media no longer carries the author's profile photo as if it were the post's picture.

## [0.7.0] - 2026-10-14

### Added

- Web client: Room owners can change channel images from room information, with protected, revisioned images in the room header and list.
- Web client: Activity: a bell beside "+" (or Ctrl+Shift+A) lists the messages that mention you, replies in your threads and your messages others reacted to, newest first, from the messages the page already holds, with the rooms that have unread mentions above them. A click opens the message, or its thread.

### Changed

- The RocketVibe server is now **Vibez**, and the web client ships under its version (no more separate `web-v` releases). Binary `vibez`, image `ghcr.io/guillaume69/vibez`, release tags `vibez-vX.Y.Z`, archive `vibez-X.Y.Z-linux-x86_64.tar.gz`.
- Breaking: discovery moves to `/.well-known/vibez` and the server names itself product `vibez` there and in push data; apps older than this release no longer recognise it.
- Breaking: every E2EE signature, fingerprint and sealed store uses `vibez-*` domains. Encrypted rooms, device certificates, history backups and archives made before this release no longer verify: reset the instance's E2EE state when upgrading.
- Breaking: environment variables are `VIBEZ_*` (for example `VIBEZ_BIND`, `VIBEZ_OBJECTS_DIR`, `VIBEZ_E2EE`); the image runs as user `vibez` and stores files under `/var/lib/vibez/objects`, so move the objects volume's mount when upgrading. The Compose file is `docker/compose.vibez.yml`, its database and user `vibez`.
- Emails, the TOTP issuer (`Vibez-<instance>`, new authenticator entries only), the link preview user agent and the default device label say Vibez.
- Web client: the title, install name and brand say Vibez, and its browser storage is renamed, so each browser signs in again and re-enrolls its device once.
- Web client: The app's own sounds (incoming call ringtone, ringback, voice session cues, new message sound) play 30 % quieter.

### Fixed

- Preserve a room's reviewed encryption policy when only its name, texts or voice-channel flag changes; actual privacy and read-only changes still invalidate the old policy.
- Web client: Show GTK-translated messages for server, worker and local failures instead of technical error or translation keys, including sign-in, encrypted-room panels and upload tooltips. Keep the original codes in diagnostics.
- Web client: Match GTK's factor-login captions, method selector and Confirm button. Recover an accepted sign-in with a blank code and the original receipt, resume email delivery before resending, and keep those intents encrypted and fenced to their account and challenge.
- Web client: Match GTK's Security setup and backup-code row order, with QR, key and code contents below the action rows. Preserve email status during these states and pending-action cancellation separately.
- Web client: Support protected quoting between ordinary and encrypted conversations without storing private excerpts in ordinary drafts or caches. Render GTK Markdown, bounded nested quotes and authorized ordinary attachments, and navigate older encrypted search results and threads.
- Web client: Match GTK's pinned/starred dialog header, size, captions and compact rows. Use the native headerless date picker with separate month/year navigation, surrounding days, wrapping time controls and explicit Cancel/Schedule or Remind me responses.
- Web client: Match GTK's New message search dialog, with people before channels, native narrow layout and a separate Create room form. Preserve real DM and channel membership navigation while discarding delayed search answers.
- Web client: Match GTK's social chooser, poll and event forms, image shelf, room invitation, workflow step controls and settings category typography.
- Web client: Use GTK bot-detail headings and photo-removal availability. Keep the email-code status visible before address verification and through pending changes and receipts.
- Web client: Keep unknown slash names, paths and quoted commands as literal messages, matching GTK. Decorate recognized text commands through the normal encrypted message path in private conversations, and retain room command catalogues across temporary connection failures.
- Web client: Use GTK confirmation messages and explicit action labels with Cancel focused, and remove extra confirmation steps from immediate administrator actions.
- Web client: Match GTK invitation and custom emoji administration, grouped field focus and spacing, profile email hints and compact composer formatting controls. Emoji completion shows Unicode and protected custom-image previews in both room and thread composers.
- Web client: Require Accept or Decline for incoming calls. Backdrop clicks and Escape leave them ringing, while caller cancellation and account teardown still remove the prompt.
- Web client: Show GTK's green, yellow, red and gray circles beside the four account presence choices, and keep status changes reflected in the account badge.
- Web client: Keep unfinished authenticator, backup-code and email changes visible in Security with Continue and Cancel. Recover accepted answers using their original operation, retain recovery codes until acknowledgement, and protect pending secrets in account-scoped encrypted browser storage.
- Web client: Confirm identity with the original proof operation and correct recovery-code labels, so expired-proof sensitive changes can continue after two-factor verification.
- Web client: Replace a stalled browser-storage upgrade with an actionable Retry screen, preserve saved drafts and accounts, and release database connections when another tab upgrades them.
- Web client: Keep account security status visible during authenticator setup and backup-code acknowledgement.
- Web client: Publish an encryption identity backup after an expired identity proof: ask for the password, then resume the original backup instead of failing, and show GTK's pending and cancelling backup states.
- Web client: Align the web screens with the running GTK client: login and verification steps, room groups and menus, conversation headers, timeline grouping, composers, threads, message actions, emoji, search, room information, members, profiles and scheduling calendars.
- Web client: Restore GTK settings and administration layouts, preserve category drafts and scroll position, use grouped security and encryption ceremonies, and render profile bios and room descriptions with safe markdown.
- Web client: Match voice controls, participant menus, incoming-call alerts and leave/rejoin navigation to GTK, including listen-only mute, connection states and device/capture failure captions. Closing the screen chooser stays quiet and releases its claim.
- Web client: Prevent a blank screen after second-factor login, repeated encryption warnings during refresh, and crypto settings becoming inactive after switching categories. Device reviews require the fingerprint to be typed before confirmation.
- Web client: Keep private-thread composers visible and update their controls after an in-flight send completes, preserving the draft. Retire pending channel-image operations when membership is withdrawn, and use the personal read revision for room-information favourites.
- Web client: Hydrate new DM, room and join receipts with personal membership state before opening them, preserving newer live state and preventing profile/encryption dialogs from closing during initial synchronization.
- Web client: Load the cached public shell offline even when module/style requests carry a different Origin header from their precache requests. Authenticated APIs remain excluded from the service-worker cache.

## [0.5.0] - 2026-10-12

### Added

- Admin-only, retry-safe account invitation creation, listing and revocation; secrets remain hashed in storage.
- Sign in with the verified email address of an account instead of its username, on `/auth/login` and `/auth/start`; a pending or unknown address fails like a wrong password.
- The Docker image is published to `ghcr.io/guillaume69/rocketvibe-server` on each release and carries a title, a description and its source repository (OCI labels).
- Web client: RocketVibe administrators can create, copy, list and revoke account invitation codes.
- Web client: Sign in with the verified email address of your account instead of your username.
- Web client: Setting up an authenticator on a RocketVibe account shows a QR code of the setup link to scan, next to the key for manual entry.

### Changed

- A verified email address belongs to one account: confirming an address another account already holds answers `409 email_address_taken`. Migration 0062 keeps addresses two accounts already shared as contacts but not as sign-in identifiers.

### Fixed

- Convert IPv4-mapped trusted proxy prefixes to their IPv4 width, preserving exact address boundaries and rejecting broader ambiguous mappings.
- Web client: The RocketVibe Security page shows an unfinished email address removal from this browser, with Continue (asking for the password only if the server needs it) and Cancel, instead of silently keeping it.
- Web client: Confirming an email address already linked to another account says so instead of showing a raw error code.
- Web client: The sign-up and recovery-code forms label their username field "Username", since they do not take an email address.
- Web client: The profile page and the add-member field label the username field "Username", not the sign-in label "Username or email".
- Web client: Invitation signup and password recovery authenticate after receiving the account response, including second-factor challenges.
- Web client: Typing /giphy opens a compact GIF grid immediately. Search updates as you type in both the command and sharing-menu pickers; choosing a GIF highlights it, and Enter or the shared Send button sends it. Search changes discard old selections and stale responses, and cancellation preserves the draft.
- Web client: Fold room-list sections per account, keyed by section rather than by its translated title: signing in as someone else no longer inherits the previous account's folds, and changing the language keeps them.

## [0.4.0] - 2026-10-11

### Added

- Owner-managed channel images: authenticated, versioned PNG reads, bounded PNG/JPEG uploads, idempotent room-command receipts and the additive room_avatars capability. Private room images remain restricted to current members.
- Quick polls and game-night RSVP cards with durable, idempotent answers, optional poll expiry and author closure.
- Private sticker shelves, typed image messages and transient, connected-only voice reactions.
- Optional server-side GIPHY search, configured with a private RV_GIPHY_CONFIG_FILE; keys never travel to apps.
- Thread list and following: `GET /api/v1/rooms/{id}/threads` lists a room's threads, all or the ones I follow, latest reply first, paged, with my unread replies; `PUT /api/v1/messages/{id}/follow` follows or unfollows one, and my other sessions see it live. The root's author and every replier follow automatically. "Also send to the room": a thread reply sent with `also_in_room` also shows in the room's history for the clients that ask for it (`?also_in_room=true`). New capabilities `thread_list`, `thread_follow` and `thread_also_in_room`; older clients see nothing change.
- Web client: Quick polls, game-night RSVP cards, private sticker shelves and ephemeral voice reactions on RocketVibe servers in unencrypted rooms.
- Web client: A GIF search and selection picker for /giphy, preserving the draft on cancel and supporting thread replies. GIF search uses the RocketVibe server GIPHY configuration.
- Web client: A local, throttled reminder toast when speaking while muted in RocketVibe voice calls.
- Web client: Search messages across rooms, in this browser: the sidebar's search button or Ctrl+Shift+F finds words in the messages the browser already holds in every room, newest first under their room's name, and opens the one you pick. Encrypted conversations keep their own search, inside each one.
- Web client: Settings > App > Diagnostics downloads a short log of the app's recent events in this tab (errors, connection changes, version, browser) to send to a developer, without tokens, messages or names.

### Changed

- Web client: Signing out while the server cannot be reached still signs out of this browser, and now tells the server later: the session is closed on the server at the next start or as soon as the browser is back online.
- Web client: The browser keeps at most the 500 newest messages per room, trimmed once per session after catching up, as the desktop and mobile apps do; older ones come back when scrolling up.
- Web client: Richer message notifications: the author's photo, the message's picture (Chromium), and Mark as read and Like buttons that act without opening the tab. A reply field appears where the browser allows a third button; otherwise a click opens the room with the composer ready. Notifications play the app's own sound, and Settings > Notifications has a "rocket-vibe sound" switch to get the system's sound back.
- Web client: Videos are reduced before sending, like on the phone: H.264 MP4 at 720p and 2 Mbps, the sound kept, with a progress bar and Cancel above the composer. "Original quality" now covers videos too. A browser that cannot encode H.264 sends the original and says so before you send.
- Web client: Threads: a Threads button in the room header lists the room's threads (All or Following, latest reply first, more as you scroll), each with Follow / Unfollow and Open thread; the open thread has its own follow bell, kept in step with your other sessions. Replying follows a thread. In a thread, "Also send to the room" shows that one reply in the room's timeline too.

## [0.3.0] - 2026-10-11

### Added

- Scheduled messages: a member schedules a text message (a thread reply too) between one minute and 30 days ahead; the server sends it at that time as its author, once, even if no app runs, and keeps the ones it could not send for their author to see. Not in end-to-end encrypted rooms.
- Read receipts: the live frame carries how far the other members of a small room (50 members at most) read it. An account preference turns them off both ways: its reads are hidden and it sees no one's.
- Do not disturb: an account's preferences take quiet hours (a daily window in its time zone) and a mute until an instant (at most seven days). While either holds, no push is sent and no device rings for a call; messages still arrive. A client that does not know the new fields keeps them unchanged.
- Web client: Remind me: from a message's menu, a reminder in an hour, three hours, tomorrow at 09:00 or a time you pick. It is kept in this browser and fires as a notification (or a dialog) that opens the message; Reminders in the account menu lists and cancels them.
- Web client: Send later: the arrow beside Send schedules the message for in an hour, tomorrow at 08:00 or a time you pick (up to 30 days), and the server sends it then even with the tab closed. A "N scheduled" chip above the composer lists them, to cancel. Not in end-to-end encrypted rooms.
- Web client: During do not disturb, an incoming call shows in the tab without ringing.
- Web client: Read receipts: under your latest message, "Seen" in a direct conversation and "Seen by" with names in a group, live. Settings > My account turns them off, both ways.
- Web client: The bottom avatar opens a quick activity menu and carries its own presence badge. The separate server connection dot moves from the header to the account footer.
- Web client: Do not disturb: Settings > Notifications mutes notifications for an hour or until morning, or every day between two times (quiet hours). The server then holds back phone notifications and call rings too, and this tab stays quiet.
- Web client: Ctrl+K (Cmd+K) opens a room switcher, as on the desktop: type part of a room's name, the arrows pick, Enter opens it. The composer's link shortcut moves to Ctrl+Shift+K; New conversation stays in the "+" menu.
- Web client: Native RocketVibe MLS encryption through the shared Rust engine in a WebAssembly worker, with identity/device approval, verified peers and explicit group creation/admission reviews.
- Web client: Protected private conversations, drafts, threads, local search, message actions and encrypted attachments, plus identity recovery, history sharing/backups and storage-key controls.
- Web client: Browser frame encryption using the native MLS voice exporter, with refusal when encryption is unavailable.

### Changed

- The embedded web client supports native MLS encrypted conversations through WebAssembly and uses React rendering, with room switching, read receipts, quick activity choices, scheduled messages and do-not-disturb controls.
- Web client: A locked room's tile (now neutral grey), a private room in the administration, a staged file and a message's file card draw symbolic Adwaita icons instead of colour emoji, like the desktop.
- Web client: Render the browser application with React 19 and strict TypeScript, preserving the GTK theme, keyed media playback, ordinary/private threads and existing session/crypto engines.
- Web client: Load settings and administration panels on demand, with shared React dialogs, navigation, profile cards, message menus, dashboard and call controls.

### Fixed

- Behind a reverse proxy, the login, invitation, recovery and email limits count each client separately: `RV_TRUSTED_PROXIES` lists the proxies whose `X-Forwarded-For` names the client, and the Compose file sets it. Before, every client shared the proxy's address, and about thirty failed logins a minute locked everyone out.
- Web client: Clear scheduled-message text when switching accounts and discard late scheduling responses after leaving their room or thread, preserving the new conversation's draft.
- Web client: Observe LiveKit's asynchronous audio-output changes on the call-owned context, preventing late device-switch rejections after voice teardown.
- Web client: Refetch a read when the server requests delivery-lease revalidation, with bounded retries and no automatic mutation replay.
- Web client: Keep ordinary voice joins usable when the server omits its false E2EE flag, while continuing to reject encryption mismatches.
- Web client: Keep the selected settings category when the administration permission lookup finishes after the user has already changed pages.
- Web client: Reopen private views after a fresh membership snapshot without exposing ordinary cached content.
- Web client: Keep encrypted voice access independent of message sending, and finish identity recovery before loading controls that require a registered device.

## [0.2.0] - 2026-10-09

### Added

- First published release of the native RocketVibe chat server (Rust, PostgreSQL), as the apps and the web client use it: accounts with second factors, recovery and device sessions, public, private and direct rooms, threads, reactions, pins, stars, quotes, search, uploads and link previews, live sync over a WebSocket, push, private end-to-end encrypted rooms, voice over LiveKit, bots, workflows, slash commands, reports and in-app administration. Published as a Linux x86_64 binary.
- The server has an icon of its own, set and removed by an administrator from the apps (`PUT`/`DELETE /api/v1/admin/icon`, capability `instance_icon`), public at `GET /api/v1/instance/icon` and announced by `icon_revision` in the discovery document.
- Administrators add and remove custom emoji from the apps (`PUT`/`DELETE /api/v1/admin/emoji/{name}`, capability `custom_emoji_admin`), with per-administrator receipts and the administrator named in the operator journal.
- Embed the native web client in the server binary and Docker image, serving explicit application routes and immutable hashed assets without a Node runtime.
- Accept browser-recorded audio WebM with the same EBML header validation as video WebM.
- Web client: Server administration: a Server icon card on the Dashboard to set or remove the server's icon; the tab shows it as its icon.
- Web client: Server administration: a Custom emoji page where administrators add emoji (name, aliases, image) and delete them.
- Web client: GTK voice tile arrangement, connection header, native call controls and speaking halos in the call and room roster.
- Web client: GTK screen-share quality choices, main stage and camera/person strip, with the browser source picker and fullscreen following share takeover.
- Web client: Guarded screen sound and the native opt-in call mix; capture without confirmed call-audio exclusion keeps video only.
- Web client: Audio-device menu with real microphone gain and meter, output gain, deafen, browser noise suppression and retained per-person volume or local mute.
- Web client: Serialize screen claims with call teardown so a delayed share response cannot begin capture after leaving.
- Web client: Match the new master bots and workflows features: bot badges, scoped bot profiles and one-time keys, administrator policy, workflow triggers and steps, variable insertion, history, webhook URLs and message forms.
- Web client: Scope workflow command completion to the current room and dispatch hyphenated commands without plaintext fallback.
- Web client: Generate the feature labels and failure messages from the shared GTK catalog.
- Web client: Original RocketVibe unicorn favicon from the GTK application icon.
- Web client: Device-session details, renaming and confirmed revocation.
- Web client: Server-delivered, single-origin web client with the GTK theme, fonts, icons, emoji and sounds.
- Web client: GTK-style DOM composer with inline formatting, cursor-line markers, selection, undo/redo and plain-text paste.
- Web client: Durable session successor recovery after a lost response and serialized multi-tab renewal.
- Web client: Live ordinary conversations, threads, quotes, message actions, search, drafts and durable offline sending.
- Web client: Staged uploads and voice recordings, protected media caching, room/profile controls and administration.
- Web client: TOTP, recovery codes, verified email and email factors, device sessions and preferences.
- Web client: LiveKit audio/video calls, capture controls and browser notifications while the tab is alive.
- Web client: Encrypted rooms shown locked, with sending and media/call actions unavailable.

### Changed

- Web client: The account block shows a gear and opens a menu (Settings, Server administration for administrators, Sign out); sign out left the header. The header's "+" is a menu (New message, Browse channels, Create a channel), and the Channels and Direct messages headings carry their own "+".

### Fixed

- Preserve bot identity in live profile observations so author refreshes keep the BOT badge on bot and workflow messages.
- Web client: Open the GTK-style user profile from conversation avatars and author names, with live identity/presence, Message, Call and Report actions.
- Web client: Renew browser presence while connected, clear it on signout, and discard expired observations in an open profile.
- Web client: Fetch the DM's personal access state before opening it from a profile so Message and Call remain usable.
- Web client: Preserve a newly typed draft and a newly selected quote while an earlier send is being saved, including after switching conversations.
- Web client: Send queued text in creation order and continue with messages added while the queue is already sending.
- Web client: Ignore superseded reconnect, history, thread and message-action responses after account or conversation access changes.
- Web client: Remove delayed private previews and uploads after access withdrawal, and keep personal stars independent of public message revisions.
- Web client: Serialize signout with session renewal so an online signout revokes the current device session.
- Web client: Keep the new caller connected when another tab or device takes over the same account's voice session.
- Web client: Clean up a failed incoming-call acceptance, reject stale membership grants, stop delayed camera capture after leaving, and restore the avatar when a camera is muted.
- Web client: Show the result-variable field when adding HTTP or message steps to a workflow.
- Web client: Match GTK's administration dashboard typography, card rows, column spacing, responsive collapse and refresh icon inside the deployment header.
- Web client: Use the shared GTK administration labels and full native deployment, presence, room/message, upload and report fields; restore instance copying, moderation badges/navigation and the bot-policy switch's refusal behavior.
- Web client: Mark incoming messages read while their channel is visible, focused and at the latest message, even when the timeline never scrolls; preserve GTK's captured-message delay and cancel pending reads on navigation.
- Web client: Keep inactive tabs, earlier history and hidden call views unread, and dismiss room notifications after their unread messages have been read.
- Web client: Keep workflow messages marked BOT after live author-profile refreshes and page reloads.
- Web client: Report failed initial WebRTC connections instead of silently closing the connecting page, and allow a clean retry after the failure.
- Web client: Replace invented per-image 1600/960-pixel options with GTK's parked Original-quality choice; prepare JPEG at 1920 pixels and quality 82 only when sending.
- Web client: Match staged-file thumbnails, name/type/size rows and inline sound replay, with no separate stock-player or caption/quality dialog.
- Web client: Enqueue a file batch atomically in selection order and apply the caption to its first file only.
- Web client: Use GTK's recording bar, elapsed counter, cancel action and stop-to-listen control; cancel releases the microphone and stages nothing.
- Web client: Show image attachments in GTK's standalone cropped frame, with its inline size limits and full-size viewer geometry.
- Web client: Add the native image context menu for copying, saving as PNG and downloading for another application; close and clear private viewers when room access is withdrawn.
- Web client: Keep audio, video and embedded-site players connected during message updates, including fullscreen video during live reactions.
- Web client: Match GTK's video attachment frame, first image, inline controls, elapsed/remaining counters and file caption; put audio controls below the file header.
- Web client: Recognize canonical YouTube, Dailymotion and Vimeo links, including short and live URLs, deduplicate them and show at most three native-style cards per message.
- Web client: Identify video embeds with the service origin while withholding room paths and bearer tokens, and restore the thumbnail when playback is stopped.
- Web client: Show protected download progress using the attachment's known size, including chunked responses without a content length.
- Web client: Preserve the voice-recording stop control through live upload refreshes, and stop delayed microphone capture after room or session changes.
- Web client: Apply microphone processing before publication, and stop capture on processor failure or a failed retry before displaying the listening state.
- Web client: Detect quiet speech from decoded audio with GTK's thresholds, meter decay and speaking hangover, and send the native deafen attribute.
- Web client: Return the sidebar call panel to the active call's room.
- Web client: Match GTK settings categories, icons, profile subpages and administration navigation; remove text zoom and clock controls without GTK equivalents.
- Web client: Use thin rounded scrollbars, bounded administrator-list avatars and a styled profile-photo picker.
- Web client: Enter voice channels automatically, show their participants under the room and display the call in the main pane.
- Web client: Play audio attachments in place with seek, pause and volume controls, retaining playback during live reactions.
- Web client: Match GTK initials and 24-hour conversation times.
- Web client: Center unread and mention counters vertically and horizontally in their badges.
- Web client: Remove the redundant server field from sign-in; the service origin is shown as plain text.
- Web client: Center the conversation title in its header as GTK does.
- Web client: Serialize call teardown before rejoining and ignore stale voice grants after leaving or signing out.
- Web client: Restore drafts before enabling the editor so opening a fresh room cannot erase the first typed characters.

[Unreleased]: https://github.com/Guillaume69/rocket-vibe/compare/vibez-v0.8.0...HEAD
[0.8.0]: https://github.com/Guillaume69/rocket-vibe/compare/vibez-v0.7.0...vibez-v0.8.0
[0.7.0]: https://github.com/Guillaume69/rocket-vibe/compare/server-v0.5.0...vibez-v0.7.0
[0.5.0]: https://github.com/Guillaume69/rocket-vibe/compare/server-v0.4.0...server-v0.5.0
[0.4.0]: https://github.com/Guillaume69/rocket-vibe/compare/server-v0.3.0...server-v0.4.0
[0.3.0]: https://github.com/Guillaume69/rocket-vibe/compare/server-v0.2.0...server-v0.3.0
[0.2.0]: https://github.com/Guillaume69/rocket-vibe/releases/tag/server-v0.2.0
