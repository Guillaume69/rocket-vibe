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

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| Server + username/email + password login (`POST login`) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| 2FA: TOTP, password (SHA-256) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| 2FA by email: send and resend the code | done | partial | partial | done | Desktop requests the code automatically when the server has not sent one, with no resend control. Web: Native provider: see [web-client](features/web-client.md). |
| Session in the system keychain, resumed at launch; a 401 on an authenticated call signs out | done | done | done | mapped | Web: Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Server probe before login (`/api/info`, `settings.public`) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Choose the server type at sign-in (automatic, Rocket.Chat, RocketVibe, Mattermost, kChat) | done | done | done | n/a | SwiftUI checked by the Linux build of RocketVibeKit and the macOS CI build only. Web: One account on the serving origin, explicit user decision. |
| Mattermost server: login with MFA, rooms, history, threads, live messages, unread, who types, presence, text and files, reactions, edits, deletions, pins, stars, search - [mattermost-and-kchat](features/mattermost-and-kchat.md) | done | done | done | n/a | Push and quotes are not mapped on that server. Mobile: stars changed in another client show only once the room's starred list is read again. SwiftUI: the Swift parts (sign-in and kChat server picker, category sections, ended kMeet row) are checked by the Linux build of RocketVibeKit and the macOS CI build only. Web: Serving native origin only; external providers are outside the accepted web scope. |
| kChat: a room read in another kChat client clears here at once (`badge_updated`) | done | done | done | n/a | Web: Serving native origin only; external providers are outside the accepted web scope. |
| kChat server (Infomaniak): Infomaniak sign-in or API token, Pusher real time, team servers of the account | partial | partial | partial | n/a | Run on a real kChat account with an API token (mobile on the emulator, desktop core through `kchat-smoke`, GTK and SwiftUI on that same core). Mobile: "Sign in with Infomaniak" not yet run. GTK, SwiftUI: API token only, no "Sign in with Infomaniak" (its redirect is a custom URL scheme the desktop apps do not register). Web: Serving native origin only; external providers are outside the accepted web scope. |
| Known servers offered on the login screen | done | done | done | n/a | Web: One account on the serving origin, explicit user decision. |
| Several servers side by side, switch without signing out | done | done | done | n/a | One database per (server, account) everywhere. Web: One account on the serving origin, explicit user decision. |
| Server rail: a button per account, "+" to add one, a dot on another account with unread | done | done | done | n/a | Other accounts read once a minute (mobile: in the foreground only). Mobile: a push lights the dot at once only where it reaches JS (iOS); Android waits for the next read. SwiftUI checked by the Linux build only. Web: One account on the serving origin, explicit user decision. |
| Server rail tiles show the server's own icon (Rocket.Chat `favicon_192` asset when set, RocketVibe instance icon), else the initial | done | done | done | mapped | Mattermost and kChat keep the initial. SwiftUI checked by the macOS CI build only. Web: no rail (one account per origin); the tab's favicon shows the RocketVibe server's icon. |
| Hide the server rail (Settings > Accounts, off by default), switching and adding staying in that page | done | done | done | n/a | Device-wide: SecureStore on mobile, one config file GTK and SwiftUI share. SwiftUI checked by the macOS CI build only. Web: One account on the serving origin, explicit user decision. |
| Several accounts on the same server | missing | done | done | n/a | Mobile holds one account per server. Web: One account on the serving origin, explicit user decision. |
| Sign out: `logout` sent, keychain item and local data removed | done | done | partial | done | Mobile keeps the account's SQLite file on purpose; GTK deletes `.sqlite`, `-wal` and `-shm`; SwiftUI deletes the `.sqlite` only, leaving `-wal` and `-shm`. Web: Native provider: see [web-client](features/web-client.md). |
| Replay of a sign-out that failed offline | done | missing | missing | missing | Mobile retries it at the next start. Desktop has no push token to remove, but the server session stays open. Web: No browser implementation yet. |

## 2. Room list - [room-list](features/room-list.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| Rooms sorted by last activity, live (`rooms.get`/`subscriptions.get` deltas, `rooms-changed`/`subscriptions-changed`) | done | done | done | mapped | Web: Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Avatar, name, preview, unread badge | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Rocket.Chat: people named as the server's `UI_Use_Real_Name` says (message authors, two-person DMs, notifications, typing), pushes included | partial | partial | partial | n/a | All three: group DMs keep usernames, `@mentions` stay `@username`, a real name changed elsewhere is not broadcast by 8.5 (it shows from the next message or profile). Mobile also names push senders by the payload's `senderName`. SwiftUI checked by the macOS CI build only. Web: Serving native origin only. |
| Time of the last message and an `@n` badge on mentions | missing | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Encrypted rooms: padlock tile, "Encrypted message" preview | done | partial | partial | done | Desktop keeps the padlock tile once unlocked; mobile switches back to the room's tile. Web: Locked metadata; no encrypted content or sending. src/app.ts. |
| Sync indicator while connecting or loading | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Sections: Unread, Favourites, Channels, Direct messages | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Mattermost and kChat sidebar categories as sections, in my sidebar order | done | done | done | n/a | SwiftUI: the view is checked by the macOS CI build only. Within a category the order stays latest activity first, not the server's manual or alphabetical sort. Web: Serving native origin only; external providers are outside the accepted web scope. |
| Presence dot on DMs (`users.presence`, `user-status`) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| System and video-call messages translated in previews | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| New conversation: `spotlight`, open a DM (`im.create`), join a channel (`channels.join`) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Rocket.Chat: create a channel or a private group (`channels.create`, `groups.create`) | missing | missing | missing | partial | On a RocketVibe server the apps create rooms; on Rocket.Chat none does. Set aside by the user on 2026-10-07. Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Unread total on the app | done | done | done | done | Mobile: launcher badge; GTK: window title, Windows tray, macOS Dock; SwiftUI: Dock. Web: Native provider: see [web-client](features/web-client.md). |

## 3. Room view - [room-view](features/room-view.md), [media-playback](features/media-playback.md), [avatars](features/avatars.md), [emoji](features/emoji.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| History with paging on scroll up, live messages and edits, live deletions | done | done | done | done | Mobile keeps the 3 rooms last left subscribed; desktop gets new messages and edits for every room (`__my_messages__`), deletions for the open room only. Web: Native provider: see [web-client](features/web-client.md). |
| Author grouping (5 min), day separators, time | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Mark as read on open and while viewing | done | done | done | done | Mobile throttles with a 10 s floor; desktop needs the window focused and scrolled to the bottom. Web: Captured 1.5-second root reads, including no-scroll workflow arrivals, cancel on navigation; modal/history and controlled visibility-event cases qualified in tests/reads.mjs. |
| Edited marker, sending state, failed with retry | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Markdown from the server's `md`, local parse as fallback | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| `mailto:` links open | missing | done | done | done | Mobile opens http(s) only. Web: Native provider: see [web-client](features/web-client.md). |
| Mentions of me highlighted apart from other mentions | missing | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| `:shortcode:` emoji (6222 codes, same table) and custom emoji images | done | done | done | done | Mobile keeps custom emoji offline in SQLite; desktop refetches them each session. Web: Native provider: see [web-client](features/web-client.md). |
| Images inline (original), viewer, protected-file token only to our origin | done | done | done | done | Web: GTK inline size/crop/title and viewer/menu captures compared on the same uploads; PNG export, live retention and withdrawal qualified. OS clipboard permission remains unqualified; external-app action maps to PNG download. tests/images.mjs. |
| Photo avatars over gradient tiles, updated live | done | partial | partial | done | Desktop: a DM's tile uses `/avatar/uid/<uid>` with no version, so the partner's new photo reaches the room list only at the next session. Web: Native provider: see [web-client](features/web-client.md). |
| Read-only rooms: no composer | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Header: room info, DM presence, search in room, start a call | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| New-messages bar at the first unread | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Pill over the list jumping to the first unread while it is above the view | done | done | done | done | "N new messages since HH:MM", gone once the marker has been on screen or the pill tapped. Mobile `ui/newMessagesPill.ts`, GTK `MessageList::update_new_pill`, SwiftUI `RoomView.newMessagesPill`. Web: Native provider: see [web-client](features/web-client.md). |
| Typing indicator (`user-activity`) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Mentions open the profile | done | done | done | partial | Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Link previews from `message.urls` | done | done | done | partial | Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| YouTube / Dailymotion / Vimeo cards | mapped | done | done | partial | Desktop plays in the card; mobile opens the app or the browser. Web: Native-style canonical cards, protected preview images, origin-only embed identity and live retention are qualified with intercepted provider responses. Real vendor streaming remains unqualified. |
| Video and audio attachments, voice messages (player) | done | done | done | done | SwiftUI plays them in a modal overlay, GTK in place. Web: Actual protected video playback/seek/volume/fullscreen, live retention and access withdrawal; same fixture plays in Fedora GTK. Inline audio qualified in tests/features.mjs. |
| Other files: download, open | done | done | done | mapped | Web: Protected local-copy download maps GTK's default-application action; browsers cannot directly launch arbitrary installed applications. |
| Quotes as cards (nested up to 2) | done | done | done | partial | Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| System messages, the full translated set | done | done | done | partial | Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Video-call message card with Join | done | done | done | partial | Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Reactions row, toggle (`chat.react`) | done | done | done | partial | Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Thread chip opens the thread | done | done | done | partial | Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Upload strip: progress, waiting, failed with retry or discard | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Encrypted rooms: locked state, "Unlock to read" | done | done | done | done | Web: Locked metadata; no encrypted content or sending. src/app.ts. |

## 4. Composer - [composer](features/composer.md), [uploads](features/uploads.md), [voice-messages](features/voice-messages.md), [slash-commands](features/slash-commands.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| Send through the outbox, retry | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Enter sends, Shift+Enter new line | n/a | done | done | done | Mobile: return inserts a line, a send button sends. Web: Native provider: see [web-client](features/web-client.md). |
| Drafts per room and thread | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| `@` mention completion (recent authors, `@all`, `@here`) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| `:` emoji completion | done | done | done | done | Mobile matches substrings and shows up to 30; desktop matches prefixes and shows 8. Web: Native provider: see [web-client](features/web-client.md). |
| Emoji picker (search, categories) | done | done | done | done | SwiftUI has its own grid, and the system's Emoji & Symbols works in its composer. Web: Native provider: see [web-client](features/web-client.md). |
| Formatting toolbar and live styling | missing | done | missing | done | Web: DOM editor, GTK span styles and cursor-line markers; apps/web/tests/composer.mjs. |
| Spell check | mapped | done | done | mapped | Mobile: the system keyboard's. Web: Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Up arrow in an empty field edits my last message | n/a | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| List continuation on Enter | missing | done | missing | done | Web: Native provider: see [web-client](features/web-client.md). |
| Reply with quote (permalink prefix) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Attach files | done | done | done | done | Desktop: file chooser, drag-and-drop and paste, in place of the Android share sheet. Web: Native provider: see [web-client](features/web-client.md). |
| Pre-send preview with captions and quality | done | done | done | done | Web: GTK 40-pixel thumbnail/type/size, full-size preview and parked Original choice; actual JPEG 1920/82 reduction, atomic ordered batch and first-file caption qualified in tests/images.mjs. |
| Reduce photos before sending | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Reduce videos before sending (H.264 720p) | done | missing | missing | missing | Web: No browser implementation yet. |
| Checks against `FileUpload_MaxFileSize` and `FileUpload_MediaTypeWhiteList` | done | done | done | partial | Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Two-step upload (`rooms.media`, `rooms.mediaConfirm`) with progress | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Voice recording | done | done | done | done | Mobile and SwiftUI send AAC `.m4a`, GTK Ogg/Opus. Web: Browser MediaRecorder codec, GTK bar/clock/cancel/stop and inline staged replay; actual capture cancellation and constructor/start failures qualified in tests/features.mjs. |
| Replay and caption a voice message before sending | done | done | done | done | SwiftUI checked by the macOS CI build only. Web: Native provider: see [web-client](features/web-client.md). |
| Slash commands (`commands.list`, `commands.run`) and their private answers | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Slash commands on a RocketVibe server (`/api/v1/commands`), text commands written by the client so they work in encrypted rooms | done | done | done | n/a | SwiftUI checked by the Linux build of RocketVibeKit and the macOS CI build only. Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Every command listed after `/` in a titled panel, narrowed as one types, completed with a tap or Tab/Enter | done | done | done | done | SwiftUI checked by the macOS CI build only. Web: Native provider: see [web-client](features/web-client.md). |

## 5. Message actions - [message-actions](features/message-actions.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| Quick reactions and removing mine | done | done | done | done | The 5 emoji this account reacts with most, counted on the device (every reaction added, from the menu, the picker or a chip), filled with `+1 heart joy tada open_mouth pray`; aliases count as one emoji ([emoji](features/emoji.md#quick-reactions-and-reacting-with-any-emoji)). Mobile counts in the account's SQLite; GTK and SwiftUI share one file per account. Web: Native provider: see [web-client](features/web-client.md). |
| React with any emoji (picker from the menu, the server's custom emoji included) | done | done | done | done | Mobile: "+" swaps the sheet's actions for the picker grid; GTK: "+" opens the picker in a popover; SwiftUI: "React with another emoji…" opens it in a popover on the row. Private RocketVibe conversations: standard emoji only. On Rocket.Chat, which accepts only its own emoji codes in `chat.react`, all three send an accepted alias and hide the glyphs it has no code for, from the picker and the quick row ([emoji](features/emoji.md#quick-reactions-and-reacting-with-any-emoji)). Web: Native provider: see [web-client](features/web-client.md). |
| Report a message to the administrators (`chat.reportMessage`, RocketVibe `reports`) | done | done | done | done | Someone else's non-system message, never a private conversation; a required reason of at most 1,000 characters ([administration](features/administration.md)). SwiftUI checked by the Linux build of RocketVibeKit and the macOS CI build only. Web: Native provider: see [web-client](features/web-client.md). |
| Reply (quote), reply in thread | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Copy text | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Share an attachment | done | mapped | mapped | mapped | Desktop: download or open. Web: Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Edit within the server's time limit and permissions (`chat.update`) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Delete (`chat.delete`) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Confirmation before deleting | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Pin (`chat.pinMessage`) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Pinned and starred lists, jump to the message | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Jump to a message of any age (the history around it) | done | done | done | done | A context window around the message ([room-view](features/room-view.md), "Jumps"). Web: Native provider: see [web-client](features/web-client.md). |

## 6. Threads - [threads](features/threads.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| Thread view: root and replies, live, composer targeting the thread | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Files and voice messages in a thread | done | done | done | done | Encrypted RocketVibe threads included. SwiftUI checked by the macOS CI build only. Web: Native provider: see [web-client](features/web-client.md). |
| List of a room's threads, following a thread, "also send to the room" | missing | missing | missing | missing | Web: No browser implementation yet. |

## 7. Search - [search](features/search.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| Search messages in the room (`chat.search`) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Open a result at its message | done | done | done | done | SwiftUI does not open a thread reply in its thread. Web: Native provider: see [web-client](features/web-client.md). |
| Search across rooms | missing | missing | missing | missing | Web: No browser implementation yet. |

## 8. Room info and profiles - [room-info-and-profiles](features/room-info-and-profiles.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| Room info (`rooms.info`) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Favourite a room | done | done | done | done | Mobile from room info, desktop from the room list. Web: Native provider: see [web-client](features/web-client.md). |
| User profile (`users.info`), Message and Call buttons | done | done | done | partial | Web: Avatar/name/menu access, native facts/live presence, GTK card geometry, Message/Call/Report and own-card rules are qualified in tests/profiles.mjs. Bio markdown remains debt. |
| My profile: avatar, status, name, bio, email and username (with password and 2FA) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Remove my photo (`users.resetAvatar`) | missing | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Live avatar changes (`updateAvatar`) | done | done | done | done | Web: Native provider: see [web-client](features/web-client.md). |
| Report a user from the profile (`moderation.reportUser`, RocketVibe `reports`) | done | done | done | done | Not on my own profile ([administration](features/administration.md)). SwiftUI checked by the Linux build of RocketVibeKit and the macOS CI build only. Web: Native provider: see [web-client](features/web-client.md). |
| Room members, room settings, roles | missing | missing | missing | done | Web: Native provider: see [web-client](features/web-client.md). |

## 9. Settings - [settings](features/settings.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| Settings in categories (account, notifications, language, voice, encryption, security, devices, bots, accounts, app), each shown only with content, Sign out under them | done | done | done | done | Mobile: a list of full pages (`app/settings/`); GTK: a sidebar dialog of 85 % of the window closed by Escape, its close button or a backdrop click; SwiftUI: an overlay of the window with the same closings, opened by Command-comma and the gear ([settings](features/settings.md)). Voice only on desktop, for a RocketVibe account with voice (the sidecar's devices and noise remover); mobile has no voice settings. Web: Native category order/icons, conditional content, profile subpages and separate administration are compared with actual GTK. Server provider/account switching and encryption are excluded by scope. |
| A click or tap outside a modal (dialog, alert, confirmation, sheet, overlay) closes it like Cancel, never running its action | done | done | done | done | Mobile: every `Alert` through `ui/alerts.ts#dismissible`, sheets dismissed by a tap outside. GTK: every dialog and alert through `widgets::present`. SwiftUI: every modal is an overlay of the window (`Modals.swift`). The platforms' own file choosers keep their behaviour (GTK's `FileDialog`, macOS's `NSOpenPanel`). An incoming call is ignored that way, not declined. SwiftUI checked by the Linux build of RocketVibeKit and the macOS CI build only. Web: Native provider: see [web-client](features/web-client.md). |
| Profile card, notification preference, language, E2EE status, account, server | done | done | done | partial | Mobile edits `pushNotifications`, desktop `desktopNotifications`. Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| French and English, automatic by default | done | done | done | done | Live on mobile, after a restart on desktop. Web: Native provider: see [web-client](features/web-client.md). |
| Accounts list in settings | n/a | done | done | n/a | Mobile: one account per server. Web: One account on the serving origin, explicit user decision. |
| Notification check | mapped | done | partial | partial | Mobile: FCM diagnostic; GTK: backend description and test notification; SwiftUI: test notification and a link to the system settings, no backend description. Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| App version in settings | done | done | done | done | The App category (mobile `expoConfig.version`, GTK `CARGO_PKG_VERSION`, SwiftUI the bundle's short version). Web: Native provider: see [web-client](features/web-client.md). |
| Logs folder | missing | done | missing | missing | Web: No browser implementation yet. |
| New versions | n/a | done | missing | mapped | Mobile goes through the store or the APK; GTK checks GitHub releases ([desktop-updates](features/desktop-updates.md)). Web: Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |

## 10. Notifications - [notifications](features/notifications.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| DMs and mentions notified, click opens the room | done | done | done | mapped | Mobile by push, even with the app killed; desktop while the app runs. Web: Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Reply from the notification | done | done | done | missing | Where the desktop platform supports it. Web: No browser implementation yet. |
| Nothing of encrypted rooms' content | done | done | done | done | Web: Locked metadata; no encrypted content or sending. src/app.ts. |
| Running with the window closed, starting at login | mapped | done | missing | partial | Mobile: push arrives with the app closed. GTK: Windows tray, macOS Dock; Linux quits on close. Web: Installable public shell; closed-tab Web Push and OS autostart absent. |

## 11. End-to-end encryption - [e2ee](features/e2ee.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| Unlock with the E2E password, decrypt messages and previews, lock again | done | done | done | n/a | Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Room keys AES-128 and AES-256 | done | done | done | n/a | Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Send, edit and answer in a thread, encrypted | done | done | done | n/a | Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Encrypted files, both directions | done | done | done | n/a | Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Key kept across launches | done | done | done | n/a | Keystore on mobile, system keychain on desktop. Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Create an encrypted room | missing | missing | missing | n/a | Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: create an encrypted room (MLS group): prepare the device for invitations, review and confirm creation, admission and device changes | done | done | done | n/a | From any native room the user belongs to, before the group exists too; the server allows creation to the owner (any member of a DM) in a room with no plaintext history. Mobile from the room info, GTK and SwiftUI from the room details. SwiftUI checked by the macOS CI build only. Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: a new device asks for history, another device of the account reviews and shares it, the new device imports it ([e2ee-history](features/e2ee-history.md)) | done | done | done | n/a | Same settings block in all three; SwiftUI checked by the macOS CI build only. Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: history backup with a separate code (enable, join, continuous upload, restore) | done | done | done | n/a | Same settings block in all three; SwiftUI checked by the macOS CI build only. Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: edit and delete own private messages, pending on the target until accepted ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | done | done | n/a | Text only. Mobile from the long-press sheet, GTK and SwiftUI from the message menu and Up in an empty composer; SwiftUI checked by the macOS CI build only. Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: react to private messages, pending on the target until accepted ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | done | done | n/a | Standard and catalog emojis. Mobile: long-press sheet and reaction chips; GTK: quick reactions in the message menu and chips; SwiftUI: the react action and chips. SwiftUI checked by the macOS CI build only. Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: search an encrypted room on the device ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | done | done | n/a | Same search screen as ordinary rooms; nothing goes to the server. SwiftUI checked by the macOS CI build only. Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: send and open encrypted files in private rooms ([e2ee-private-files](features/e2ee-private-files.md)) | done | done | done | n/a | In the room and from a thread, voice messages included. Mobile compresses on request, desktop sends originals. SwiftUI checked by the macOS CI build only. Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: storage key renewed every 30 days and on request, old keys destroyed ([e2ee-storage-keys](features/e2ee-storage-keys.md)) | done | done | done | n/a | Same settings block in all three; background check after private refreshes. SwiftUI checked by the macOS CI build only. Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: hand control of the account to another device with a history share ([e2ee-delegation](features/e2ee-delegation.md)) | done | done | done | n/a | Destructive second confirmation in the share review of all three; cannot be taken back. SwiftUI checked by the macOS CI build only. Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: recovered history shown in conversations | done | done | done | n/a | The shared projection continues into recovered messages past the device's own oldest one; all three read it unchanged. Reply counts of recovered roots and quotes of recovered messages stay own-only. Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |

## 12. Calls - [calls](features/calls.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| Start and join a Jitsi call (`video-conference.start`, `.join`), Rocket.Chat servers | done | done | done | n/a | Locked on the call's origin: mobile WebView, WebView2 on Windows, WKWebView on macOS; on Linux a Chromium app window, else the browser. Web: Native RocketVibe origin only; calls use LiveKit. |
| Meeting information: the link without the token (`video-conference.info`) | missing | done | missing | n/a | Web: Native RocketVibe origin only; calls use LiveKit. |
| kChat kMeet calls: start from the room, Join from the call card, ended call with its length | done | done | done | n/a | SwiftUI: checked by the macOS CI build only. Web: Serving native origin only; external providers are outside the accepted web scope. |
| Mattermost and kChat people named under the account's name format, with their custom status emoji | done | done | done | n/a | SwiftUI: author labels and DM names come from rv-ffi; the views are checked by the macOS CI build only. Web: Serving native origin only; external providers are outside the accepted web scope. |
| Mattermost and kChat lists only the conversations the account lists (closed ones hidden, the Direct Messages limit) | done | done | done | n/a | Web: Serving native origin only; external providers are outside the accepted web scope. |
| Mattermost and kChat conversation list settings (name format, direct messages shown), synced with the account | done | done | done | n/a | SwiftUI: checked by the macOS CI build only. Web: Serving native origin only; external providers are outside the accepted web scope. |

## 12b. Voice (RocketVibe server) - [voice](features/voice.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| Voice channels: speaker mark, entered on selection, writable | done | done | done | partial | Desktop needs the `rv-voice` sidecar beside the app, which every package carries. SwiftUI's voice is checked by the macOS CI build only. Web: Firefox/Chromium autojoin, bidirectional audio, live occupants and retry after a reported ICE failure are qualified by voice-connection.mjs; voice.mjs qualifies ringing, media and sharing. Physical-device and exhaustive platform qualification remain. |
| People connected under each room of the list, ring lit while speaking in your session | done | done | done | done | Web: Native identifier-based avatars, room occupants, PCM speaking halos and person menus. Real GTK/browser interop and two-browser voice tests. |
| Voice screen: a tile per person sharing all the room, glowing while they speak, chat one step away | done | done | done | done | GTK keeps 16:9 tiles (`tile_grid.rs`); mobile fills its cells, stacked on a phone held upright (`lib/voiceGrid.ts`). SwiftUI keeps GTK's 16:9 tiles (`arrangeTiles`). Web: GTK TileGrid geometry, connected header, speaking halo and chat navigation are implemented. Compared to actual GTK captures and qualified against a native GTK audio stream. Further camera/share layouts remain separate debt. |
| Who speaks told from the sound itself, a whisper included | done | done | done | partial | GTK: the sidecar reads its microphone (RNNoise's voice probability) and every remote track. Android: its microphone the same way, remote tracks through sinks, LiveKit's active speakers kept as a fallback. SwiftUI: the same sidecar. Web: Local/remote PCM thresholds, normalized meter decay and 350 ms hangover are ported from GTK and qualified with quiet real RTP. Browser noise suppression has no RNNoise voice-probability path. |
| "Voice connected" panel: mute, deafen, leave | done | done | done | done | Mobile adds the speaker route; the ongoing call notification also mutes and leaves. Web: Native controls and labels, real microphone mute and playback deafen, tested through LiveKit/Web Audio with restored individual gains. |
| Call from any room's header (joins its voice) | done | done | done | partial | GTK: also a profile's Call, which opens the DM and rings. Web: LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Direct call rings the other member, accept or decline, original ringtone | done | done | done | done | Mobile: in-app ring, full-screen ring from a push even locked. GTK: a dialog while the app runs (kept running in the tray or dock on Windows and macOS), no push. SwiftUI: an alert while the app runs, the dock bouncing when it is behind, no push. A click or tap outside the incoming prompt, Escape or Back ignores the call (prompt hidden, ringtone stopped, not declined) in all three. Web: original ringtone/ringback, live incoming prompt, accept/decline and ignore on close; tests exchange actual audio, verify decline stops the caller, and exclude delayed acceptance after signout/signin. |
| Call rows show the outcome (missed, declined, duration) and call back | done | done | done | partial | Both also preview the outcome in the room list. Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Create a voice channel | done | done | done | partial | Mobile gained "Create a room" with it; SwiftUI too (a modal overlay from the list's "+" button: name, private, voice channel). Web: LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Turn a room into a voice channel or back (room settings, owners) | done | done | done | partial | All three send `UpdateRoom.voice` only when the server announces voice, and show the switch to an owner of a room that is not direct. Mobile: in the room information's edit form. Web: LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Choose the microphone and speakers | mapped | done | done | partial | Mobile: the call menu's output (earpiece, speaker, wired, Bluetooth), the microphone following it, meets the phone's need. GTK: in the call menu and the settings' "Voice" group, kept per machine. SwiftUI: the call menu and the settings' Voice section, the same files as GTK. Web: LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Call menu beside the microphone: devices, input and output volume, input level, noise remover, deafen | done | done | done | partial | Mobile: a native sheet (`app/voice/menu.tsx`), with the screen share's quality; GTK: a popover, with the way to the voice settings. SwiftUI: a popover, as GTK. Web: Native menu entries implemented; real input/output gains, meter and deafen qualified. Browser-native suppression differs from GTK RNNoise; the idle menu is compared to a real GTK root capture; physical device switching and noise qualification remain. |
| Someone's volume here (0 to 200 %), or muted for oneself only, kept | done | done | done | done | GTK: right click under the room or on their tile; mobile: long press (`app/voice/person.tsx`). SwiftUI: a context menu under the room or on their tile. Web: Actual Web Audio gain and local-only mute, retained across rejoin in account-scoped storage; qualified in apps/web/tests/voice.mjs. |
| Noise remover (RNNoise) on the microphone, on by default | done | done | done | partial | Same Rust port (`nnnoiseless`): in the desktop sidecar, and in `crates/rv-voice-mobile` over JNI on Android. Web: Browser-native noiseSuppression is implemented and on by default. GTK uses nnnoiseless/RNNoise; matching the engine and qualifying physical capture remain debt. |
| Camera and one screen share per room, a new share replacing the current one | done | partial | partial | done | GTK has no camera on macOS (the permission needs an app bundle); Linux and Windows have both. The screen takes most of the page, the people a column at its right, on both apps. SwiftUI: no camera of its own (the sidecar captures none on macOS), others' cameras show. Web: Actual camera/screen RTP, stage/camera thumbnails and SFU takeover stop previous capture/sound. apps/web/tests/voice.mjs; actual GTK receiving the browser share is captured. |
| Choose what to share (a screen or a window) and its quality | partial | done | done | mapped | GTK: a picker with thumbnails, resolution and frame rate (Wayland: the portal picks). Android: the system's consent dialog offers one app or the whole screen from Android 14 only; the quality is in the call menu. Web: Browser consent picker supplies screen/window selection, as GTK Wayland delegates to its portal. Native resolution/cadence choices reach capture and sender; actual 720p/30 fps qualified. |
| A shared screen full screen | done | done | done | done | A tap on the stage (mobile), its button or a double click (GTK); it follows a takeover on GTK. SwiftUI: its own window in full screen, Escape or a double click comes back. Web: Native exit/double-click affordance, follows actual SFU takeover and closes on capture-ended events. apps/web/tests/voice.mjs. |
| Direct call: the other person leaving hangs up here, and the chat comes back | done | done | done | done | After a 2 s grace for a reconnection. SwiftUI: rv-ffi's supervisor hangs up. Web: Actual two-browser call test verifies automatic hangup and chat restoration on peer departure. |
| A shared screen's sound, without the call's voices unless asked | partial | partial | missing | partial | Android: apps' media and game sound mixed into the microphone track, never the call (Android does not capture it), so no option to add it. GTK: Windows (process loopback; a shared window, its program's sound only) and Linux (PipeWire, through rv-screen-audio; a window shares the whole sound), as its own track, the option in the settings' Voice group; macOS shares no sound. SwiftUI: macOS shares no sound, as GTK there. Web: Verified own-audio exclusion gates program-sound publication; otherwise video only. Native opt-in call mix and deafen are qualified over real RTP. Controlled program-sound fixture qualifies processing/cleanup; browser OS-loopback exclusion and platform capture remain debt. |
| Voice in encrypted rooms (end-to-end encrypted frames) | done | done | done | n/a | Key from the room's MLS group, LiveKit shared key; a device behind the group's head is told to accept the change first. Web: Encrypted rooms explicitly excluded by the user, 2026-10-08. |

## 13. Sharing and links - [sharing-and-links](features/sharing-and-links.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| `rocketvibe://room/<rid>?host=` opens the room | done | done | done | mapped | Mobile compares origins and asks before switching server; desktop matches the host name and switches account by itself. All three still accept the pre-rename `rocketvibe://salon/` form. Web: Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Share files and text into a room from other apps | done | mapped | mapped | mapped | Desktop: drop or paste. Web: Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |

## 14. Offline and resilience - [offline-and-sync](features/offline-and-sync.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| Local SQLite per (server, account), screens read the database | done | done | done | mapped | Web: Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Text outbox surviving restarts, retry on reconnection | done | done | done | partial | Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Reconnection with back-off, dead-socket probe, catch-up after the subscriptions are armed | done | done | done | partial | Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Rooms deleted server-side purged locally | done | partial | partial | partial | Desktop purges without mobile's snapshot taken before the request: a room created meanwhile can be purged until the next catch-up. Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| `chat.syncMessages` catch-up of edits and deletions | done | partial | partial | mapped | Desktop catches a room up once per session: a deletion in a room already caught up while another was open stays visible until it is caught up again. Web: Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Message retention (500 newest per room) | done | missing | missing | missing | Web: No browser implementation yet. |

## 15. Server administration - [administration](features/administration.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| Server administration for an administrator only: Dashboard (deployment, latest published version, users, rooms, messages, uploads, open reports; on Rocket.Chat the dated cached figures, refreshed on demand) | done | done | done | done | Rocket.Chat: `me.roles` has `admin`; RocketVibe: `administration` capability and `manage_accounts` or `manage_instance`. Entry: a link under the settings and the open server's rail menu (mobile long press, GTK right click or long press, SwiftUI context menu). SwiftUI checked by the Linux build of RocketVibeKit and the macOS CI build only. Web: GTK native overview fields, catalog and card layout compared with actual English/French GTK captures on the same native server; ten visual/settings cases qualify dashboard refresh, navigation, release filtering and policy refusal. |
| Moderation: reported messages and accounts, reasons, dismiss, delete the message, deactivate the author or account | done | done | done | done | Rocket.Chat reasons read lazily per item; RocketVibe gives up to 20 with the list. Rocket.Chat: each message's own count from `moderation.reports`; a message the admin cannot reach is deleted only through the explicit bulk delete of the author's reported messages. The open Rocket.Chat message report count is the sum of the per-author counts of the first 100 authors everywhere. SwiftUI checked by the Linux build of RocketVibeKit and the macOS CI build only. Web: Native provider: see [web-client](features/web-client.md). |
| Rooms list: every room, direct conversations, discussions and teams included, searched by the server | done | done | done | done | Read only: kind, counts, creation, read-only and encrypted marks; no last-message date on Rocket.Chat. SwiftUI checked by the Linux build of RocketVibeKit and the macOS CI build only. Web: Native provider: see [web-client](features/web-client.md). |
| Users list with actions: admin right, activation, deletion (confirmed); none on my own account | done | done | done | done | Bot badge on both products (RocketVibe `AdminUser.bot`); a RocketVibe bot is never offered the admin right. RocketVibe deletion keeps the messages under "Deleted user"; Rocket.Chat follows its erasure setting and also deletes the person's direct conversations; a last owner of rooms gets a second confirmation naming the rooms deleted and those whose owner changes. SwiftUI checked by the Linux build of RocketVibeKit and the macOS CI build only. Web: Native provider: see [web-client](features/web-client.md). |
| Server icon: set (a square image, 192 px PNG on Rocket.Chat) and remove from the Dashboard | done | done | done | done | Rocket.Chat `assets.setAsset`/`unsetAsset` on `favicon_192`; RocketVibe `/api/v1/admin/icon` with `instance_icon`. Mattermost and kChat: no administration in any app. SwiftUI views compiled by the macOS CI only. Web: RocketVibe only. |
| Custom emoji: list, add (name, aliases, PNG/JPEG/GIF image), delete (confirmed), on Rocket.Chat and RocketVibe | done | done | done | done | No editing: delete then add. Names checked by the app first (lowercase, digits, `_` `-`, 8 aliases, never a standard code). RocketVibe needs `custom_emoji_admin`. Mattermost and kChat: no administration in any app. SwiftUI views compiled by the macOS CI only. Web: RocketVibe only, like the rest of its administration. |
| Deleted RocketVibe account shown as "Deleted user" (author, reactions, quotes, notifications) | partial | partial | partial | partial | All three: messages ingested before the deletion keep the old name until the server sends them again, names the server computes (DM names) keep it, and private (E2EE) conversations do not apply it (desktop shows the author's raw id, mobile the username its `users` table knows). Mobile covers authors and quote authors; GTK and SwiftUI get authors, reactions, quotes and notifications from rv-core's native projection, plus the admin lists; SwiftUI's profile of a deleted account reads "Deleted user". Web: Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |

## 16. Bots (RocketVibe server) - [bots](features/bots.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| "BOT" badge on bot authors, members and profiles, with the owner on the profile | done | done | done | partial | Not on search results, pins or encrypted rows on mobile; messages cached before the update until the server resends them. SwiftUI views compiled by the macOS CI only. Web: Author badges survive real live profile observations and page reload in workflows.mjs; server observations preserve bot identity. Full GTK state qualification remains. |
| "My bots": list, create with scopes, edit display name, photo, description and scopes, delete | done | done | done | partial | Scope sentences and their API routes read from `GET /api/v1/bots/reference`. SwiftUI views compiled by the macOS CI only. Web: Implemented in apps/web/src/bots.ts, workflows.ts and workflow-forms.ts; full GTK state qualification remains. |
| Bot keys: create after a recent sign-in, shown once with copy and a curl example, list, revoke | done | done | done | partial | Never stored. SwiftUI views compiled by the macOS CI only. Web: Implemented in apps/web/src/bots.ts, workflows.ts and workflow-forms.ts; full GTK state qualification remains. |
| Administrators' switch "Users can create bots" | done | done | done | partial | Dashboard card, RocketVibe only. Web: Implemented in apps/web/src/bots.ts, workflows.ts and workflow-forms.ts; full GTK state qualification remains. |
| Bot badge in the administrators' user list | done | done | done | partial | Rocket.Chat already had it (`type` bot or app). Web: Implemented in apps/web/src/bots.ts, workflows.ts and workflow-forms.ts; full GTK state qualification remains. |
| Encrypted-room refusals worded (`bot_encrypted_room`, `crypto_bot_member`) | done | done | done | n/a | Wherever the app can trigger them: mobile and SwiftUI have no member-invitation screen, so there only the encryption refusal can show; mobile also hides the encryption actions when a bot is a member. Web: Native-origin client; browser encryption and Rocket.Chat provider explicitly excluded. |
| Rocket.Chat bots and integrations | n/a | n/a | n/a | n/a | Managed in Rocket.Chat itself. Web: Native-origin client; browser encryption and Rocket.Chat provider explicitly excluded. |

## 17. Workflows (RocketVibe server) - [workflows](features/workflows.md)

| Feature | Mobile | GTK | SwiftUI | Web | Notes |
|---|---|---|---|---|---|
| "Workflows" settings page: list (trigger in words, on or off, last run), create, edit, test now, turn off, delete, last 50 runs | done | done | done | partial | Whoever may create a bot. SwiftUI views compiled by the macOS CI only. Web: Implemented in apps/web/src/bots.ts, workflows.ts and workflow-forms.ts; full GTK state qualification remains. |
| Triggers: slash command, schedule (hour, day, chosen days of the week, IANA zone), someone joining, a reaction (any or one emoji), a message containing a text, webhook (URL shown once) | done | done | done | partial | The room triggers fire for people only. Web: Implemented in apps/web/src/bots.ts, workflows.ts and workflow-forms.ts; full GTK state qualification remains. |
| Steps: message (trigger's room or a fixed one, in the thread), wait, HTTP call, form; variables offered per step | done | done | partial | partial | SwiftUI inserts a variable at the cursor in the message text and request body, but appends it to a GET or DELETE step's URL (a one-line field). The thread option shows for reaction and message triggers only, in all three. Web: Implemented in apps/web/src/bots.ts, workflows.ts and workflow-forms.ts; full GTK state qualification remains. |
| Workflow commands in the composer's command list, per room | done | done | done | partial | `GET /api/v1/commands?room=`. Web: Implemented in apps/web/src/bots.ts, workflows.ts and workflow-forms.ts; full GTK state qualification remains. |
| Form card in the room ("For @recipient", "Answered by ..."), the message's text not repeated above it | done | done | done | partial | Web: Implemented in apps/web/src/bots.ts, workflows.ts and workflow-forms.ts; full GTK state qualification remains. |
| Answering a form: text, long text, number, choice, person (a list or the room's members), one answer or several (checkboxes) | done | done | done | partial | Mobile: a native sheet; GTK: an `adw::Dialog`; SwiftUI: an overlay; all three close on a backdrop click. Web: Implemented in apps/web/src/bots.ts, workflows.ts and workflow-forms.ts; full GTK state qualification remains. |
| Workflows on Rocket.Chat | n/a | n/a | n/a | n/a | Rocket.Chat has its own integrations. Web: Native-origin client; browser encryption and Rocket.Chat provider explicitly excluded. |

## Open debt

What each app owes, from the tables above. Rows missing in all three are product
gaps, listed last.

- **Mobile**: kChat "Sign in with Infomaniak" run on a real account; Mattermost stars changed elsewhere, live; several accounts per server; time and `@n` badge in the room list;
  `mailto:` links; mentions of me highlighted; formatting toolbar; list
  continuation; removing my photo; logs folder; meeting information.
- **GTK**: kChat "Sign in with Infomaniak"; email 2FA resend; replay of an offline sign-out; padlock tile once
  unlocked; DM avatar versions in the list; video reduction; reconciliation snapshot; catch-up of
  deletions in rooms already caught up; message retention.
- **SwiftUI**: everything GTK owes, plus `-wal` / `-shm` cleanup on sign-out;
  workflow variables inserted at the cursor in a one-line URL;
  formatting toolbar; list continuation; notification backend description; logs
  folder; new versions; running with the window closed and starting at login;
  meeting information.
- **All three**: thread list, following and "also send to the room"; search across
  rooms; room members, settings and roles; creating an encrypted room; creating a
  channel or private group on Rocket.Chat; "Deleted
  user" on messages ingested before the deletion, on server-computed names and in
  private conversations.
