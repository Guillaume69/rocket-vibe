# Web client execution

Reference: [RFC 0003](rfcs/0003-web-client.md). Direction selected on 2026-10-08: a real browser client, delivered by the RocketVibe server, with GTK as the visual reference.

Current state: real application implemented and embedded in the server. One serving origin/account; encrypted conversations explicitly unsupported. Statuses below describe native RocketVibe equivalents, not Rocket.Chat endpoint support.

## Construction and qualification

- [x] Dedicated worktree and branch; native server serves the built application.
- [x] Actual Fedora GTK reference build/capture; shared theme, fonts, icons, emoji and sounds.
- [x] Single-origin authentication, factors, live model, browser state and durable queues.
- [x] Ordinary rooms, threads, actions, search, files, recording, management and settings.
- [x] Browser LiveKit calls and security flows exercised against local services.
- [x] Brain, changelog and continuous browser build/test workflow.
- [ ] Full GTK visual-state comparison and all remaining per-row qualifications.
- [x] Browser DOM composer with GTK inline draft styling, selection, undo/redo and cursor-line markers.
- [ ] Offline signout replay and closed-tab Web Push.

The inherited inventory below retains the GTK feature descriptions. A native browser equivalent uses the native protocol, not the endpoint named for Rocket.Chat. "done" is implementation status; qualified scenarios are listed separately. This branch does not claim all GTK parity is complete.

## Verification evidence

Local 2026-10-08: 18 main conversation scenarios, nine advanced scenarios, four two-browser LiveKit scenarios, six actual TLS email/TOTP scenarios, three session-rotation/tab scenarios, one synthetic locked-room UI scenario and six styled-editor scenarios. Eleven model/API/composition tests pass. Server library: 193 passed, one intentionally ignored; clippy passes with warnings denied. GTK reference built through the mandatory Fedora script and captured with the same server fixture. The synthetic locked-room test verifies UI exclusion, not cryptographic behavior.

## GTK inventory

GTK baseline is inherited, not a new verification claim. Web status refers to the native provider; mappings and exclusions follow the accepted origin/account/encryption scope.

| Feature | GTK baseline | Web | Evidence or debt |
|---|---|---|---|
| Server + username/email + password login (`POST login`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| 2FA: TOTP, password (SHA-256) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| 2FA by email: send and resend the code | partial | done | Native provider: see [web implementation](../apps/web/README.md). |
| Session in the system keychain, resumed at launch; a 401 on an authenticated call signs out | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Server probe before login (`/api/info`, `settings.public`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Choose the server type at sign-in (automatic, Rocket.Chat, RocketVibe) | done | n/a | One account on the serving origin, explicit user decision. |
| Known servers offered on the login screen | done | n/a | One account on the serving origin, explicit user decision. |
| Several servers side by side, switch without signing out | done | n/a | One account on the serving origin, explicit user decision. |
| Server rail: a button per account, "+" to add one, a dot on another account with unread | done | n/a | One account on the serving origin, explicit user decision. |
| Several accounts on the same server | done | n/a | One account on the serving origin, explicit user decision. |
| Sign out: `logout` sent, keychain item and local data removed | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Replay of a sign-out that failed offline | missing | missing | No browser implementation yet. |
| Rooms sorted by last activity, live (`rooms.get`/`subscriptions.get` deltas, `rooms-changed`/`subscriptions-changed`) | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Avatar, name, preview, unread badge | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Time of the last message and an `@n` badge on mentions | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Encrypted rooms: padlock tile, "Encrypted message" preview | partial | done | Locked metadata; no encrypted content or sending. src/app.ts. |
| Sync indicator while connecting or loading | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Sections: Unread, Favourites, Channels, Direct messages | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Presence dot on DMs (`users.presence`, `user-status`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| System and video-call messages translated in previews | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| New conversation: `spotlight`, open a DM (`im.create`), join a channel (`channels.join`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Rocket.Chat: create a channel or a private group (`channels.create`, `groups.create`) | missing | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Unread total on the app | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| History with paging on scroll up, live messages and edits, live deletions | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Author grouping (5 min), day separators, time | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Mark as read on open and while viewing | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Edited marker, sending state, failed with retry | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Markdown from the server's `md`, local parse as fallback | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| `mailto:` links open | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Mentions of me highlighted apart from other mentions | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| `:shortcode:` emoji (6222 codes, same table) and custom emoji images | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Images inline (original), viewer, protected-file token only to our origin | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Photo avatars over gradient tiles, updated live | partial | done | Native provider: see [web implementation](../apps/web/README.md). |
| Read-only rooms: no composer | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Header: room info, DM presence, search in room, start a call | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| New-messages bar at the first unread | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Pill over the list jumping to the first unread while it is above the view | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Typing indicator (`user-activity`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Mentions open the profile | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Link previews from `message.urls` | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| YouTube / Dailymotion / Vimeo cards | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Video and audio attachments, voice messages (player) | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Other files: download, open | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Quotes as cards (nested up to 2) | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| System messages, the full translated set | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Video-call message card with Join | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Reactions row, toggle (`chat.react`) | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Thread chip opens the thread | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Upload strip: progress, waiting, failed with retry or discard | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Encrypted rooms: locked state, "Unlock to read" | done | done | Locked metadata; no encrypted content or sending. src/app.ts. |
| Send through the outbox, retry | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Enter sends, Shift+Enter new line | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Drafts per room and thread | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| `@` mention completion (recent authors, `@all`, `@here`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| `:` emoji completion | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Emoji picker (search, categories) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Formatting toolbar and live styling | done | done | DOM editor, GTK span styles and cursor-line markers; tests/composer.mjs. |
| Spell check | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Up arrow in an empty field edits my last message | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| List continuation on Enter | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Reply with quote (permalink prefix) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Attach files | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Pre-send preview with captions and quality | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Reduce photos before sending | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Reduce videos before sending (H.264 720p) | missing | missing | No browser implementation yet. |
| Checks against `FileUpload_MaxFileSize` and `FileUpload_MediaTypeWhiteList` | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Two-step upload (`rooms.media`, `rooms.mediaConfirm`) with progress | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Voice recording | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Replay and caption a voice message before sending | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Slash commands (`commands.list`, `commands.run`) and their private answers | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Slash commands on a RocketVibe server (`/api/v1/commands`), text commands written by the client so they work in encrypted rooms | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Every command listed after `/` in a titled panel, narrowed as one types, completed with a tap or Tab/Enter | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Quick reactions and removing mine | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| React with any emoji (picker from the menu, the server's custom emoji included) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Report a message to the administrators (`chat.reportMessage`, RocketVibe `reports`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Reply (quote), reply in thread | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Copy text | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Share an attachment | mapped | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Edit within the server's time limit and permissions (`chat.update`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Delete (`chat.delete`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Confirmation before deleting | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Pin (`chat.pinMessage`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Pinned and starred lists, jump to the message | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Jump to a message of any age (the history around it) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Thread view: root and replies, live, composer targeting the thread | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Files and voice messages in a thread | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| List of a room's threads, following a thread, "also send to the room" | missing | missing | No browser implementation yet. |
| Search messages in the room (`chat.search`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Open a result at its message | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Search across rooms | missing | missing | No browser implementation yet. |
| Room info (`rooms.info`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Favourite a room | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| User profile (`users.info`), Message and Call buttons | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| My profile: avatar, status, name, bio, email and username (with password and 2FA) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Remove my photo (`users.resetAvatar`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Live avatar changes (`updateAvatar`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Report a user from the profile (`moderation.reportUser`, RocketVibe `reports`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Room members, room settings, roles | missing | done | Native provider: see [web implementation](../apps/web/README.md). |
| Settings in categories (account, notifications, language, voice, encryption, security, devices, accounts, app), each shown only with content, Sign out under them | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| A click or tap outside a modal (dialog, alert, confirmation, sheet, overlay) closes it like Cancel, never running its action | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Profile card, notification preference, language, E2EE status, account, server | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| French and English, automatic by default | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Accounts list in settings | done | n/a | One account on the serving origin, explicit user decision. |
| Notification check | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| App version in settings | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Logs folder | done | missing | No browser implementation yet. |
| New versions | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| DMs and mentions notified, click opens the room | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Reply from the notification | done | missing | No browser implementation yet. |
| Nothing of encrypted rooms' content | done | done | Locked metadata; no encrypted content or sending. src/app.ts. |
| Running with the window closed, starting at login | done | partial | Installable public shell; closed-tab Web Push and OS autostart absent. |
| Unlock with the E2E password, decrypt messages and previews, lock again | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Room keys AES-128 and AES-256 | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Send, edit and answer in a thread, encrypted | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Encrypted files, both directions | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Key kept across launches | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Create an encrypted room | missing | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: create an encrypted room (MLS group): prepare the device for invitations, review and confirm creation, admission and device changes | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: a new device asks for history, another device of the account reviews and shares it, the new device imports it ([e2ee-history](features/e2ee-history.md)) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: history backup with a separate code (enable, join, continuous upload, restore) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: edit and delete own private messages, pending on the target until accepted ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| RocketVibe server: react to private messages, pending on the target until accepted ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| RocketVibe server: search an encrypted room on the device ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: send and open encrypted files in private rooms ([e2ee-private-files](features/e2ee-private-files.md)) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: storage key renewed every 30 days and on request, old keys destroyed ([e2ee-storage-keys](features/e2ee-storage-keys.md)) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: hand control of the account to another device with a history share ([e2ee-delegation](features/e2ee-delegation.md)) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: recovered history shown in conversations | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Start and join a Jitsi call (`video-conference.start`, `.join`), Rocket.Chat servers | done | n/a | Native RocketVibe origin only; calls use LiveKit. |
| Meeting information: the link without the token (`video-conference.info`) | done | n/a | Native RocketVibe origin only; calls use LiveKit. |
| Voice channels: speaker mark, entered on selection, writable | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| People connected under each room of the list, ring lit while speaking in your session | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Voice screen: a tile per person sharing all the room, glowing while they speak, chat one step away | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Who speaks told from the sound itself, a whisper included | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| "Voice connected" panel: mute, deafen, leave | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Call from any room's header (joins its voice) | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Direct call rings the other member, accept or decline, original ringtone | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Call rows show the outcome (missed, declined, duration) and call back | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Create a voice channel | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Turn a room into a voice channel or back (room settings, owners) | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Choose the microphone and speakers | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Call menu beside the microphone: devices, input and output volume, input level, noise remover, deafen | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Someone's volume here (0 to 200 %), or muted for oneself only, kept | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Noise remover (RNNoise) on the microphone, on by default | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Camera and one screen share per room, a new share replacing the current one | partial | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Choose what to share (a screen or a window) and its quality | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| A shared screen full screen | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Direct call: the other person leaving hangs up here, and the chat comes back | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| A shared screen's sound, without the call's voices unless asked | partial | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Voice in encrypted rooms (end-to-end encrypted frames) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| `rocketvibe://room/<rid>?host=` opens the room | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Share files and text into a room from other apps | mapped | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Local SQLite per (server, account), screens read the database | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Text outbox surviving restarts, retry on reconnection | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Reconnection with back-off, dead-socket probe, catch-up after the subscriptions are armed | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Rooms deleted server-side purged locally | partial | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| `chat.syncMessages` catch-up of edits and deletions | partial | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Message retention (500 newest per room) | missing | missing | No browser implementation yet. |
| Server administration for an administrator only: Dashboard (deployment, latest published version, users, rooms, messages, uploads, open reports; on Rocket.Chat the dated cached figures, refreshed on demand) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Moderation: reported messages and accounts, reasons, dismiss, delete the message, deactivate the author or account | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Rooms list: every room, direct conversations, discussions and teams included, searched by the server | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Users list with actions: admin right, activation, deletion (confirmed); none on my own account | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Deleted RocketVibe account shown as "Deleted user" (author, reactions, quotes, notifications) | partial | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |

## Sources

- brain/parity.md
- docs/protocol/PARITY.md
- apps/desktop/crates/rv-gtk/src
- apps/desktop/crates/rv-core/src/native
