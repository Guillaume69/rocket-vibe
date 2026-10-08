# Web client execution

Reference: [RFC 0003](rfcs/0003-web-client.md). Direction selected on 2026-10-08: a real browser client, delivered by the RocketVibe server, with GTK as the visual reference.

Current state: dedicated worktree and branch, architecture and initial parity inventory only. No web application is implemented. The following inventory is copied from the existing three-app matrix; implementation must verify each GTK/provider behavior in the current sources, including newer native voice, administration and security features.

## Construction

- [ ] Inventory both GTK providers, their screens and actual behavior; complete the initial matrix below with current voice, administration and security capabilities.
- [ ] Capture GTK reference states in the Fedora container; extract shared design values, fonts and icon assets.
- [ ] Serve production web assets directly from the server, preserving API/socket routing and error behavior.
- [ ] Reproduce the GTK login, rail, room list, timeline, composer, threads, menus and preferences.
- [ ] Implement authentication, browser-local state, live sync, persisted outbox and account switching.
- [ ] Complete room/message actions, search, files, media, voice, calls, profiles and administration where GTK exposes them.
- [ ] Qualify browser encryption, recovery, history and multi-tab durability; keep private plaintext and keys on the device.
- [ ] Implement or explicitly map notifications, platform behavior and additional server/provider support.
- [ ] Add the web app to the brain and parity contract as functionality lands.
- [ ] Pass real-server browser flows and GTK/browser visual comparisons; verify the server distribution and deployed client.

A construction batch is not full delivery. GTK functional and visual parity is the requested end state.

## Initial inherited GTK inventory

Web status starts at missing. GTK status records the initial existing matrix and is not a new verification claim. Platform features require explicit mappings and evidence before changing their web status.

| Feature | GTK baseline | Web | Evidence or debt |
|---|---|---|---|
| Server + username/email + password login (`POST login`) | done | missing | Not implemented. |
| 2FA: TOTP, password (SHA-256) | done | missing | Not implemented. |
| 2FA by email: send and resend the code | partial | missing | Not implemented. |
| Session in the system keychain, resumed at launch; a 401 on an authenticated call signs out | done | missing | Not implemented. |
| Server probe before login (`/api/info`, `settings.public`) | done | missing | Not implemented. |
| Choose the server type at sign-in (automatic, Rocket.Chat, RocketVibe) | done | missing | Not implemented. |
| Known servers offered on the login screen | done | missing | Not implemented. |
| Several servers side by side, switch without signing out | done | missing | Not implemented. |
| Server rail: a button per account, "+" to add one, a dot on another account with unread | done | missing | Not implemented. |
| Several accounts on the same server | done | missing | Not implemented. |
| Sign out: `logout` sent, keychain item and local data removed | done | missing | Not implemented. |
| Replay of a sign-out that failed offline | missing | missing | Not implemented. |
| Rooms sorted by last activity, live (`rooms.get`/`subscriptions.get` deltas, `rooms-changed`/`subscriptions-changed`) | done | missing | Not implemented. |
| Avatar, name, preview, unread badge | done | missing | Not implemented. |
| Time of the last message and an `@n` badge on mentions | done | missing | Not implemented. |
| Encrypted rooms: padlock tile, "Encrypted message" preview | partial | missing | Not implemented. |
| Sync indicator while connecting or loading | done | missing | Not implemented. |
| Sections: Unread, Favourites, Channels, Direct messages | done | missing | Not implemented. |
| Presence dot on DMs (`users.presence`, `user-status`) | done | missing | Not implemented. |
| System and video-call messages translated in previews | done | missing | Not implemented. |
| New conversation: `spotlight`, open a DM (`im.create`), join a channel (`channels.join`) | done | missing | Not implemented. |
| Rocket.Chat: create a channel or a private group (`channels.create`, `groups.create`) | missing | missing | Not implemented. |
| Unread total on the app | done | missing | Not implemented. |
| History with paging on scroll up, live messages and edits, live deletions | done | missing | Not implemented. |
| Author grouping (5 min), day separators, time | done | missing | Not implemented. |
| Mark as read on open and while viewing | done | missing | Not implemented. |
| Edited marker, sending state, failed with retry | done | missing | Not implemented. |
| Markdown from the server's `md`, local parse as fallback | done | missing | Not implemented. |
| `mailto:` links open | done | missing | Not implemented. |
| Mentions of me highlighted apart from other mentions | done | missing | Not implemented. |
| `:shortcode:` emoji (6222 codes, same table) and custom emoji images | done | missing | Not implemented. |
| Images inline (original), viewer, protected-file token only to our origin | done | missing | Not implemented. |
| Photo avatars over gradient tiles, updated live | partial | missing | Not implemented. |
| Read-only rooms: no composer | done | missing | Not implemented. |
| Header: room info, DM presence, search in room, start a call | done | missing | Not implemented. |
| New-messages bar at the first unread | done | missing | Not implemented. |
| Pill over the list jumping to the first unread while it is above the view | done | missing | Not implemented. |
| Typing indicator (`user-activity`) | done | missing | Not implemented. |
| Mentions open the profile | done | missing | Not implemented. |
| Link previews from `message.urls` | done | missing | Not implemented. |
| YouTube / Dailymotion / Vimeo cards | done | missing | Not implemented. |
| Video and audio attachments, voice messages (player) | done | missing | Not implemented. |
| Other files: download, open | done | missing | Not implemented. |
| Quotes as cards (nested up to 2) | done | missing | Not implemented. |
| System messages, the full translated set | done | missing | Not implemented. |
| Video-call message card with Join | done | missing | Not implemented. |
| Reactions row, toggle (`chat.react`) | done | missing | Not implemented. |
| Thread chip opens the thread | done | missing | Not implemented. |
| Upload strip: progress, waiting, failed with retry or discard | done | missing | Not implemented. |
| Encrypted rooms: locked state, "Unlock to read" | done | missing | Not implemented. |
| Send through the outbox, retry | done | missing | Not implemented. |
| Enter sends, Shift+Enter new line | done | missing | Not implemented. |
| Drafts per room and thread | done | missing | Not implemented. |
| `@` mention completion (recent authors, `@all`, `@here`) | done | missing | Not implemented. |
| `:` emoji completion | done | missing | Not implemented. |
| Emoji picker (search, categories) | done | missing | Not implemented. |
| Formatting toolbar and live styling | done | missing | Not implemented. |
| Spell check | done | missing | Not implemented. |
| Up arrow in an empty field edits my last message | done | missing | Not implemented. |
| List continuation on Enter | done | missing | Not implemented. |
| Reply with quote (permalink prefix) | done | missing | Not implemented. |
| Attach files | done | missing | Not implemented. |
| Pre-send preview with captions and quality | done | missing | Not implemented. |
| Reduce photos before sending | done | missing | Not implemented. |
| Reduce videos before sending (H.264 720p) | missing | missing | Not implemented. |
| Checks against `FileUpload_MaxFileSize` and `FileUpload_MediaTypeWhiteList` | done | missing | Not implemented. |
| Two-step upload (`rooms.media`, `rooms.mediaConfirm`) with progress | done | missing | Not implemented. |
| Voice recording | done | missing | Not implemented. |
| Replay and caption a voice message before sending | done | missing | Not implemented. |
| Slash commands (`commands.list`, `commands.run`) and their private answers | done | missing | Not implemented. |
| Slash commands on a RocketVibe server (`/api/v1/commands`), text commands written by the client so they work in encrypted rooms | done | missing | Not implemented. |
| Every command listed after `/` in a titled panel, narrowed as one types, completed with a tap or Tab/Enter | done | missing | Not implemented. |
| Quick reactions and removing mine | done | missing | Not implemented. |
| React with any emoji (picker from the menu, the server's custom emoji included) | done | missing | Not implemented. |
| Report a message to the administrators (`chat.reportMessage`, RocketVibe `reports`) | done | missing | Not implemented. |
| Reply (quote), reply in thread | done | missing | Not implemented. |
| Copy text | done | missing | Not implemented. |
| Share an attachment | mapped | missing | Not implemented. |
| Edit within the server's time limit and permissions (`chat.update`) | done | missing | Not implemented. |
| Delete (`chat.delete`) | done | missing | Not implemented. |
| Confirmation before deleting | done | missing | Not implemented. |
| Pin (`chat.pinMessage`) | done | missing | Not implemented. |
| Pinned and starred lists, jump to the message | done | missing | Not implemented. |
| Jump to a message of any age (the history around it) | done | missing | Not implemented. |
| Thread view: root and replies, live, composer targeting the thread | done | missing | Not implemented. |
| Files and voice messages in a thread | done | missing | Not implemented. |
| List of a room's threads, following a thread, "also send to the room" | missing | missing | Not implemented. |
| Search messages in the room (`chat.search`) | done | missing | Not implemented. |
| Open a result at its message | done | missing | Not implemented. |
| Search across rooms | missing | missing | Not implemented. |
| Room info (`rooms.info`) | done | missing | Not implemented. |
| Favourite a room | done | missing | Not implemented. |
| User profile (`users.info`), Message and Call buttons | done | missing | Not implemented. |
| My profile: avatar, status, name, bio, email and username (with password and 2FA) | done | missing | Not implemented. |
| Remove my photo (`users.resetAvatar`) | done | missing | Not implemented. |
| Live avatar changes (`updateAvatar`) | done | missing | Not implemented. |
| Report a user from the profile (`moderation.reportUser`, RocketVibe `reports`) | done | missing | Not implemented. |
| Room members, room settings, roles | missing | missing | Not implemented. |
| Settings in categories (account, notifications, language, voice, encryption, security, devices, accounts, app), each shown only with content, Sign out under them | done | missing | Not implemented. |
| A click or tap outside a modal (dialog, alert, confirmation, sheet, overlay) closes it like Cancel, never running its action | done | missing | Not implemented. |
| Profile card, notification preference, language, E2EE status, account, server | done | missing | Not implemented. |
| French and English, automatic by default | done | missing | Not implemented. |
| Accounts list in settings | done | missing | Not implemented. |
| Notification check | done | missing | Not implemented. |
| App version in settings | done | missing | Not implemented. |
| Logs folder | done | missing | Not implemented. |
| New versions | done | missing | Not implemented. |
| DMs and mentions notified, click opens the room | done | missing | Not implemented. |
| Reply from the notification | done | missing | Not implemented. |
| Nothing of encrypted rooms' content | done | missing | Not implemented. |
| Running with the window closed, starting at login | done | missing | Not implemented. |
| Unlock with the E2E password, decrypt messages and previews, lock again | done | missing | Not implemented. |
| Room keys AES-128 and AES-256 | done | missing | Not implemented. |
| Send, edit and answer in a thread, encrypted | done | missing | Not implemented. |
| Encrypted files, both directions | done | missing | Not implemented. |
| Key kept across launches | done | missing | Not implemented. |
| Create an encrypted room | missing | missing | Not implemented. |
| RocketVibe server: create an encrypted room (MLS group): prepare the device for invitations, review and confirm creation, admission and device changes | done | missing | Not implemented. |
| RocketVibe server: a new device asks for history, another device of the account reviews and shares it, the new device imports it ([e2ee-history](features/e2ee-history.md)) | done | missing | Not implemented. |
| RocketVibe server: history backup with a separate code (enable, join, continuous upload, restore) | done | missing | Not implemented. |
| RocketVibe server: edit and delete own private messages, pending on the target until accepted ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | missing | Not implemented. |
| RocketVibe server: react to private messages, pending on the target until accepted ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | missing | Not implemented. |
| RocketVibe server: search an encrypted room on the device ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | missing | Not implemented. |
| RocketVibe server: send and open encrypted files in private rooms ([e2ee-private-files](features/e2ee-private-files.md)) | done | missing | Not implemented. |
| RocketVibe server: storage key renewed every 30 days and on request, old keys destroyed ([e2ee-storage-keys](features/e2ee-storage-keys.md)) | done | missing | Not implemented. |
| RocketVibe server: hand control of the account to another device with a history share ([e2ee-delegation](features/e2ee-delegation.md)) | done | missing | Not implemented. |
| RocketVibe server: recovered history shown in conversations | done | missing | Not implemented. |
| Start and join a Jitsi call (`video-conference.start`, `.join`), Rocket.Chat servers | done | missing | Not implemented. |
| Meeting information: the link without the token (`video-conference.info`) | done | missing | Not implemented. |
| Voice channels: speaker mark, entered on selection, writable | done | missing | Not implemented. |
| People connected under each room of the list, ring lit while speaking in your session | done | missing | Not implemented. |
| Voice screen: a tile per person sharing all the room, glowing while they speak, chat one step away | done | missing | Not implemented. |
| Who speaks told from the sound itself, a whisper included | done | missing | Not implemented. |
| "Voice connected" panel: mute, deafen, leave | done | missing | Not implemented. |
| Call from any room's header (joins its voice) | done | missing | Not implemented. |
| Direct call rings the other member, accept or decline, original ringtone | done | missing | Not implemented. |
| Call rows show the outcome (missed, declined, duration) and call back | done | missing | Not implemented. |
| Create a voice channel | done | missing | Not implemented. |
| Turn a room into a voice channel or back (room settings, owners) | done | missing | Not implemented. |
| Choose the microphone and speakers | done | missing | Not implemented. |
| Call menu beside the microphone: devices, input and output volume, input level, noise remover, deafen | done | missing | Not implemented. |
| Someone's volume here (0 to 200 %), or muted for oneself only, kept | done | missing | Not implemented. |
| Noise remover (RNNoise) on the microphone, on by default | done | missing | Not implemented. |
| Camera and one screen share per room, a new share replacing the current one | partial | missing | Not implemented. |
| Choose what to share (a screen or a window) and its quality | done | missing | Not implemented. |
| A shared screen full screen | done | missing | Not implemented. |
| Direct call: the other person leaving hangs up here, and the chat comes back | done | missing | Not implemented. |
| A shared screen's sound, without the call's voices unless asked | partial | missing | Not implemented. |
| Voice in encrypted rooms (end-to-end encrypted frames) | done | missing | Not implemented. |
| `rocketvibe://room/<rid>?host=` opens the room | done | missing | Not implemented. |
| Share files and text into a room from other apps | mapped | missing | Not implemented. |
| Local SQLite per (server, account), screens read the database | done | missing | Not implemented. |
| Text outbox surviving restarts, retry on reconnection | done | missing | Not implemented. |
| Reconnection with back-off, dead-socket probe, catch-up after the subscriptions are armed | done | missing | Not implemented. |
| Rooms deleted server-side purged locally | partial | missing | Not implemented. |
| `chat.syncMessages` catch-up of edits and deletions | partial | missing | Not implemented. |
| Message retention (500 newest per room) | missing | missing | Not implemented. |
| Server administration for an administrator only: Dashboard (deployment, latest published version, users, rooms, messages, uploads, open reports; on Rocket.Chat the dated cached figures, refreshed on demand) | done | missing | Not implemented. |
| Moderation: reported messages and accounts, reasons, dismiss, delete the message, deactivate the author or account | done | missing | Not implemented. |
| Rooms list: every room, direct conversations, discussions and teams included, searched by the server | done | missing | Not implemented. |
| Users list with actions: admin right, activation, deletion (confirmed); none on my own account | done | missing | Not implemented. |
| Deleted RocketVibe account shown as "Deleted user" (author, reactions, quotes, notifications) | partial | missing | Not implemented. |

## Sources

- brain/parity.md
- docs/protocol/PARITY.md
- apps/desktop/crates/rv-gtk/src
- apps/desktop/crates/rv-core/src/native
