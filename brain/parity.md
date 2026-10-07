# Parity

What a user can do in each app, tracked both ways: the Android app (`apps/mobile`),
the GTK app (`apps/desktop`, Linux, Windows, macOS) and the SwiftUI app
(`apps/desktop/macos`, over the same rv-core). Neither app is the reference. A row
that is not `done` or `mapped` in an app is debt that app owes, and is listed again
under [Open debt](#open-debt). The rule that keeps this file true is in `CLAUDE.md`
("Parity"); the mechanism behind each row is in the linked feature doc.

Status: `done` · `partial` · `missing` · `mapped` (the same need met by the
platform's own mechanism, said in the note) · `n/a` (the need does not exist on that
platform).

The SwiftUI app is proven by rv-ffi's and the view models' tests against the test
server and by CI on a Mac (build, signature, notarization, sample messages, soak);
its screens have not yet been walked against a server on a Mac, which the testers'
beta does.

## 1. Login, session, servers - [login-and-servers](features/login-and-servers.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| Server + username/email + password login (`POST login`) | done | done | done | |
| 2FA: TOTP, password (SHA-256) | done | done | done | |
| 2FA by email: send and resend the code | done | partial | partial | Desktop requests the code automatically when the server has not sent one, with no resend control. |
| Session in the system keychain, resumed at launch; a 401 on an authenticated call signs out | done | done | done | |
| Server probe before login (`/api/info`, `settings.public`) | done | done | done | |
| Choose the server type at sign-in (automatic, Rocket.Chat, RocketVibe) | done | done | done | SwiftUI checked by the Linux build of RocketVibeKit and the macOS CI build only. |
| Known servers offered on the login screen | done | done | done | |
| Several servers side by side, switch without signing out | done | done | done | One database per (server, account) everywhere. |
| Server rail: a button per account, "+" to add one, a dot on another account with unread | done | done | done | Other accounts read once a minute (mobile: in the foreground only). Mobile: a push lights the dot at once only where it reaches JS (iOS); Android waits for the next read. SwiftUI checked by the Linux build only. |
| Several accounts on the same server | missing | done | done | Mobile holds one account per server. |
| Sign out: `logout` sent, keychain item and local data removed | done | done | partial | Mobile keeps the account's SQLite file on purpose; GTK deletes `.sqlite`, `-wal` and `-shm`; SwiftUI deletes the `.sqlite` only, leaving `-wal` and `-shm`. |
| Replay of a sign-out that failed offline | done | missing | missing | Mobile retries it at the next start. Desktop has no push token to remove, but the server session stays open. |

## 2. Room list - [room-list](features/room-list.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| Rooms sorted by last activity, live (`rooms.get`/`subscriptions.get` deltas, `rooms-changed`/`subscriptions-changed`) | done | done | done | |
| Avatar, name, preview, unread badge | done | done | done | |
| Time of the last message and an `@n` badge on mentions | missing | done | done | |
| Encrypted rooms: padlock tile, "Encrypted message" preview | done | partial | partial | Desktop keeps the padlock tile once unlocked; mobile switches back to the room's tile. |
| Sync indicator while connecting or loading | done | done | done | |
| Sections: Unread, Favourites, Channels, Direct messages | done | done | done | |
| Presence dot on DMs (`users.presence`, `user-status`) | done | done | done | |
| System and video-call messages translated in previews | done | done | done | |
| New conversation: `spotlight`, open a DM (`im.create`), join a channel (`channels.join`) | done | done | done | |
| Unread total on the app | done | done | done | Mobile: launcher badge; GTK: window title, Windows tray, macOS Dock; SwiftUI: Dock. |

## 3. Room view - [room-view](features/room-view.md), [media-playback](features/media-playback.md), [avatars](features/avatars.md), [emoji](features/emoji.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| History with paging on scroll up, live messages and edits, live deletions | done | done | done | Mobile keeps the 3 rooms last left subscribed; desktop gets new messages and edits for every room (`__my_messages__`), deletions for the open room only. |
| Author grouping (5 min), day separators, time | done | done | done | |
| Mark as read on open and while viewing | done | done | done | Mobile throttles with a 10 s floor; desktop needs the window focused and scrolled to the bottom. |
| Edited marker, sending state, failed with retry | done | done | done | |
| Markdown from the server's `md`, local parse as fallback | done | done | done | |
| `mailto:` links open | missing | done | done | Mobile opens http(s) only. |
| Mentions of me highlighted apart from other mentions | missing | done | done | |
| `:shortcode:` emoji (6222 codes, same table) and custom emoji images | done | done | done | Mobile keeps custom emoji offline in SQLite; desktop refetches them each session. |
| Images inline (original), viewer, protected-file token only to our origin | done | done | done | |
| Photo avatars over gradient tiles, updated live | done | partial | partial | Desktop: a DM's tile uses `/avatar/uid/<uid>` with no version, so the partner's new photo reaches the room list only at the next session. |
| Read-only rooms: no composer | done | done | done | |
| Header: room info, DM presence, search in room, start a call | done | done | done | |
| New-messages bar at the first unread | done | done | done | |
| Typing indicator (`user-activity`) | done | done | done | |
| Mentions open the profile | done | done | done | |
| Link previews from `message.urls` | done | done | done | |
| YouTube / Dailymotion / Vimeo cards | mapped | done | done | Desktop plays in the card; mobile opens the app or the browser. |
| Video and audio attachments, voice messages (player) | done | done | done | SwiftUI plays them in a sheet, GTK in place. |
| Other files: download, open | done | done | done | |
| Quotes as cards (nested up to 2) | done | done | done | |
| System messages, the full translated set | done | done | done | |
| Video-call message card with Join | done | done | done | |
| Reactions row, toggle (`chat.react`) | done | done | done | |
| Thread chip opens the thread | done | done | done | |
| Upload strip: progress, waiting, failed with retry or discard | done | done | done | |
| Encrypted rooms: locked state, "Unlock to read" | done | done | done | |

## 4. Composer - [composer](features/composer.md), [uploads](features/uploads.md), [voice-messages](features/voice-messages.md), [slash-commands](features/slash-commands.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| Send through the outbox, retry | done | done | done | |
| Enter sends, Shift+Enter new line | n/a | done | done | Mobile: return inserts a line, a send button sends. |
| Drafts per room and thread | done | done | done | |
| `@` mention completion (recent authors, `@all`, `@here`) | done | done | done | |
| `:` emoji completion | done | done | done | Mobile matches substrings and shows up to 30; desktop matches prefixes and shows 8. |
| Emoji picker (search, categories) | done | done | done | SwiftUI has its own grid, and the system's Emoji & Symbols works in its composer. |
| Formatting toolbar and live styling | missing | done | missing | |
| Spell check | mapped | done | done | Mobile: the system keyboard's. |
| Up arrow in an empty field edits my last message | n/a | done | done | |
| List continuation on Enter | missing | done | missing | |
| Reply with quote (permalink prefix) | done | done | done | |
| Attach files | done | done | done | Desktop: file chooser, drag-and-drop and paste, in place of the Android share sheet. |
| Pre-send preview with captions and quality | done | done | done | |
| Reduce photos before sending | done | done | done | |
| Reduce videos before sending (H.264 720p) | done | missing | missing | |
| Checks against `FileUpload_MaxFileSize` and `FileUpload_MediaTypeWhiteList` | done | done | done | |
| Two-step upload (`rooms.media`, `rooms.mediaConfirm`) with progress | done | done | done | |
| Voice recording | done | done | done | Mobile and SwiftUI send AAC `.m4a`, GTK Ogg/Opus. |
| Replay and caption a voice message before sending | done | done | done | SwiftUI checked by the macOS CI build only. |
| Slash commands (`commands.list`, `commands.run`) and their private answers | done | done | done | |
| Slash commands on a RocketVibe server (`/api/v1/commands`), text commands written by the client so they work in encrypted rooms | done | done | done | SwiftUI checked by the Linux build of RocketVibeKit and the macOS CI build only. |
| Every command listed after `/` in a titled panel, narrowed as one types, completed with a tap or Tab/Enter | done | done | done | SwiftUI checked by the macOS CI build only. |

## 5. Message actions - [message-actions](features/message-actions.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| Quick reactions and removing mine | done | done | done | Only the six quick ones from the menu, everywhere. |
| Reply (quote), reply in thread | done | done | done | |
| Copy text | done | done | done | |
| Share an attachment | done | mapped | mapped | Desktop: download or open. |
| Edit within the server's time limit and permissions (`chat.update`) | done | done | done | |
| Delete (`chat.delete`) | done | done | done | |
| Confirmation before deleting | done | done | done | |
| Pin (`chat.pinMessage`) | done | done | done | |
| Pinned and starred lists, jump to the message | done | done | done | |
| Jump to a message of any age (the history around it) | done | done | done | A context window around the message ([room-view](features/room-view.md), "Jumps"). |

## 6. Threads - [threads](features/threads.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| Thread view: root and replies, live, composer targeting the thread | done | done | done | |
| Files and voice messages in a thread | done | done | done | Encrypted RocketVibe threads included. SwiftUI checked by the macOS CI build only. |
| List of a room's threads, following a thread, "also send to the room" | missing | missing | missing | |

## 7. Search - [search](features/search.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| Search messages in the room (`chat.search`) | done | done | done | |
| Open a result at its message | done | done | done | SwiftUI does not open a thread reply in its thread. |
| Search across rooms | missing | missing | missing | |

## 8. Room info and profiles - [room-info-and-profiles](features/room-info-and-profiles.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| Room info (`rooms.info`) | done | done | done | |
| Favourite a room | done | done | done | Mobile from room info, desktop from the room list. |
| User profile (`users.info`), Message and Call buttons | done | done | done | |
| My profile: avatar, status, name, bio, email and username (with password and 2FA) | done | done | done | |
| Remove my photo (`users.resetAvatar`) | missing | done | done | |
| Live avatar changes (`updateAvatar`) | done | done | done | |
| Room members, room settings, roles | missing | missing | missing | |

## 9. Settings - [settings](features/settings.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| Profile card, notification preference, language, E2EE status, account, server | done | done | done | Mobile edits `pushNotifications`, desktop `desktopNotifications`. |
| French and English, automatic by default | done | done | done | Live on mobile, after a restart on desktop. |
| Accounts list in settings | n/a | done | done | Mobile: one account per server. |
| Notification check | mapped | done | missing | Mobile: FCM diagnostic; GTK: backend description and test notification. |
| Logs folder | missing | done | missing | |
| New versions | n/a | done | missing | Mobile goes through the store or the APK; GTK checks GitHub releases ([desktop-updates](features/desktop-updates.md)). |

## 10. Notifications - [notifications](features/notifications.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| DMs and mentions notified, click opens the room | done | done | done | Mobile by push, even with the app killed; desktop while the app runs. |
| Reply from the notification | done | done | done | Where the desktop platform supports it. |
| Nothing of encrypted rooms' content | done | done | done | |
| Running with the window closed, starting at login | mapped | done | missing | Mobile: push arrives with the app closed. GTK: Windows tray, macOS Dock; Linux quits on close. |

## 11. End-to-end encryption - [e2ee](features/e2ee.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| Unlock with the E2E password, decrypt messages and previews, lock again | done | done | done | |
| Room keys AES-128 and AES-256 | done | done | done | |
| Send, edit and answer in a thread, encrypted | done | done | done | |
| Encrypted files, both directions | done | done | done | |
| Key kept across launches | done | done | done | Keystore on mobile, system keychain on desktop. |
| Create an encrypted room | missing | missing | missing | |
| RocketVibe server: create an encrypted room (MLS group): prepare the device for invitations, review and confirm creation, admission and device changes | done | done | done | From any native room the user belongs to, before the group exists too; the server allows creation to the owner (any member of a DM) in a room with no plaintext history. Mobile from the room info, GTK and SwiftUI from the room details. SwiftUI checked by the macOS CI build only. |
| RocketVibe server: a new device asks for history, another device of the account reviews and shares it, the new device imports it ([e2ee-history](features/e2ee-history.md)) | done | done | done | Same settings block in all three; SwiftUI checked by the macOS CI build only. |
| RocketVibe server: history backup with a separate code (enable, join, continuous upload, restore) | done | done | done | Same settings block in all three; SwiftUI checked by the macOS CI build only. |
| RocketVibe server: edit and delete own private messages, pending on the target until accepted ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | done | done | Text only. Mobile from the long-press sheet, GTK and SwiftUI from the message menu and Up in an empty composer; SwiftUI checked by the macOS CI build only. |
| RocketVibe server: react to private messages, pending on the target until accepted ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | done | done | Standard and catalog emojis. Mobile: long-press sheet and reaction chips; GTK: quick reactions in the message menu and chips; SwiftUI: the react action and chips. SwiftUI checked by the macOS CI build only. |
| RocketVibe server: search an encrypted room on the device ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | done | done | Same search screen as ordinary rooms; nothing goes to the server. SwiftUI checked by the macOS CI build only. |
| RocketVibe server: send and open encrypted files in private rooms ([e2ee-private-files](features/e2ee-private-files.md)) | done | done | done | In the room and from a thread, voice messages included. Mobile compresses on request, desktop sends originals. SwiftUI checked by the macOS CI build only. |
| RocketVibe server: storage key renewed every 30 days and on request, old keys destroyed ([e2ee-storage-keys](features/e2ee-storage-keys.md)) | done | done | done | Same settings block in all three; background check after private refreshes. SwiftUI checked by the macOS CI build only. |
| RocketVibe server: hand control of the account to another device with a history share ([e2ee-delegation](features/e2ee-delegation.md)) | done | done | done | Destructive second confirmation in the share review of all three; cannot be taken back. SwiftUI checked by the macOS CI build only. |
| RocketVibe server: recovered history shown in conversations | done | done | done | The shared projection continues into recovered messages past the device's own oldest one; all three read it unchanged. Reply counts of recovered roots and quotes of recovered messages stay own-only. |

## 12. Calls - [calls](features/calls.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| Start and join a Jitsi call (`video-conference.start`, `.join`), Rocket.Chat servers | done | done | done | Locked on the call's origin: mobile WebView, WebView2 on Windows, WKWebView on macOS; on Linux a Chromium app window, else the browser. |
| Meeting information: the link without the token (`video-conference.info`) | missing | done | missing | |

## 12b. Voice (RocketVibe server) - [voice](features/voice.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| Voice channels: speaker mark, entered on selection, writable | done | done | missing | Desktop needs the `rv-voice` sidecar beside the app, which every package carries. |
| People connected under each room of the list, ring lit while speaking in your session | done | done | missing | |
| Voice screen: a card per person, glowing while they speak, chat one step away | done | done | missing | |
| "Voice connected" panel: mute, deafen, leave | done | done | missing | Mobile adds the speaker route; the ongoing call notification also mutes and leaves. |
| Call from any room's header (joins its voice) | done | done | missing | GTK: also a profile's Call, which opens the DM and rings. |
| Direct call rings the other member, accept or decline, original ringtone | done | done | missing | Mobile: in-app ring, full-screen ring from a push even locked. GTK: a dialog while the app runs (kept running in the tray or dock on Windows and macOS), no push. |
| Call rows show the outcome (missed, declined, duration) and call back | done | done | missing | Both also preview the outcome in the room list. |
| Create a voice channel | done | done | missing | Mobile gained "Create a room" with it. |
| Turn a room into a voice channel or back (room settings, owners) | missing | done | missing | GTK sends `UpdateRoom.voice` only when the server announces voice. |
| Choose the microphone and speakers | mapped | done | missing | Mobile: the speaker route button (earpiece, speaker, Bluetooth) meets the phone's need. GTK: a "Voice" group in the settings, kept per machine. |
| Camera and one screen share per room, a new share replacing the current one | done | partial | missing | GTK has no camera on macOS (the permission needs an app bundle); Linux and Windows have both. The screen takes most of the page, the people a column at its right, on both apps. |
| A shared screen's sound, without the call's voices unless asked | partial | partial | missing | Android: apps' media and game sound mixed into the microphone track, never the call (Android does not capture it), so no option to add it. GTK: Windows only, as its own track, the option in the settings' Voice group; Linux and macOS share no sound yet (Linux needs the call routed to its own output first). |
| Voice in encrypted rooms (end-to-end encrypted frames) | done | done | missing | Key from the room's MLS group, LiveKit shared key; a device behind the group's head is told to accept the change first. |

## 13. Sharing and links - [sharing-and-links](features/sharing-and-links.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| `rocketvibe://room/<rid>?host=` opens the room | done | done | done | Mobile compares origins and asks before switching server; desktop matches the host name and switches account by itself. All three still accept the pre-rename `rocketvibe://salon/` form. |
| Share files and text into a room from other apps | done | mapped | mapped | Desktop: drop or paste. |

## 14. Offline and resilience - [offline-and-sync](features/offline-and-sync.md)

| Feature | Mobile | GTK | SwiftUI | Notes |
|---|---|---|---|---|
| Local SQLite per (server, account), screens read the database | done | done | done | |
| Text outbox surviving restarts, retry on reconnection | done | done | done | |
| Reconnection with back-off, dead-socket probe, catch-up after the subscriptions are armed | done | done | done | |
| Rooms deleted server-side purged locally | done | partial | partial | Desktop purges without mobile's snapshot taken before the request: a room created meanwhile can be purged until the next catch-up. |
| `chat.syncMessages` catch-up of edits and deletions | done | partial | partial | Desktop catches a room up once per session: a deletion in a room already caught up while another was open stays visible until it is caught up again. |
| Message retention (500 newest per room) | done | missing | missing | |

## Open debt

What each app owes, from the tables above. Rows missing in all three are product
gaps, listed last.

- **Mobile**: several accounts per server; time and `@n` badge in the room list;
  `mailto:` links; mentions of me highlighted; formatting toolbar; list
  continuation; removing my photo; logs folder; meeting information.
- **GTK**: email 2FA resend; replay of an offline sign-out; padlock tile once
  unlocked; DM avatar versions in the list; video reduction; reconciliation snapshot; catch-up of
  deletions in rooms already caught up; message retention.
- **SwiftUI**: everything GTK owes, plus `-wal` / `-shm` cleanup on sign-out;
  formatting toolbar; list continuation; notification check; logs folder; new
  versions; running with the window closed and starting at login; meeting
  information.
- **All three**: thread list, following and "also send to the room"; search across
  rooms; room members, settings and roles; creating an encrypted room.
