# Parity with the Android app

What the mobile app (`../rocket-vibe`) lets a user do, and where the desktop
app stands. Mobile-only mechanisms are mapped to their desktop equivalent
rather than dropped.

`[x]` done · `[ ]` to do · `[~]` partial

## 1. Login, session, servers

- [x] Server + username/email + password login (`POST login`)
- [x] 2FA: TOTP, email (send and resend code), password (SHA-256)
- [x] Session kept in the system keychain, resumed at launch; a 401 on an authenticated call signs out
- [ ] Server probe before login (`/api/info`, `settings.public`): version, password login available
- [ ] Known servers offered on the login screen
- [ ] Several servers side by side, switch without signing out (one database per server and account)
- [~] Sign out: `logout` sent, keychain and cache wiped (no push token to remove on desktop)

## 2. Room list

- [x] Rooms sorted by last activity, live (`rooms.get`/`subscriptions.get` deltas, `rooms-changed`/`subscriptions-changed`)
- [x] Avatar (room photo, DM partner photo), name, preview, time, yellow unread badge (`@n` on mentions)
- [x] Encrypted rooms: 🔒 tile, "Encrypted message" preview
- [x] Sync comet while connecting or loading
- [ ] Sections: Unread, Channels, Direct messages
- [x] Presence dot on DMs (`users.presence`, `user-status`)
- [x] System and video-call messages translated in previews
- [ ] "New conversation": search users and channels (`spotlight`), open a DM (`im.create`), join a channel (`channels.join`)
- [ ] Unread total on the app (window title / launcher badge)

## 3. Room view

- [x] History with paging on scroll up, live messages and edits (`__my_messages__`), live deletions
- [x] Author grouping (5 min), day separators (Today, Yesterday, date), time in the gutter
- [x] Mark as read on open (`subscriptions.read`)
- [x] Edited marker, sending state, failed with retry
- [x] Markdown from the server's `md`: bold, italic, strike, inline code, code block, heading, quote, lists, tasks, links (http(s)/mailto), big emoji, mentions (mine highlighted), #channels
- [x] `:shortcode:` emoji to Unicode (6222 codes, same table as Android)
- [x] Images inline (original, not the thumbnail), viewer on click, protected-file token only to our origin
- [x] Photo avatars over gradient tiles
- [x] Read-only rooms: no composer
- [~] Header: room info, DM partner's presence, search in room, start a call (presence and call done)
- [x] "✦ new messages" bar at the first unread
- [x] Mark as read while viewing (debounced)
- [x] Typing indicator (`user-activity`)
- [ ] Custom emoji images (`emoji-custom.list`)
- [ ] Mentions open the profile
- [x] Link previews from `message.urls` (card, inline image)
- [x] YouTube/Dailymotion/Vimeo cards
- [x] Video attachments (player)
- [x] Audio and voice messages (player)
- [x] Other files: download, open
- [x] Quotes: the quoted message as a card (nested up to 2)
- [x] System messages: the full translated set
- [x] Video-call message card with Join
- [x] Reactions row, click to toggle (`chat.react`)
- [x] Thread chip opens the thread
- [ ] Upload strip: progress, waiting, failed with retry/discard
- [ ] Encrypted rooms: locked state, "Unlock to read"

## 4. Composer

- [x] Send with the optimistic outbox, retry
- [x] Enter sends, Shift+Enter new line, grows to 160 px then scrolls
- [x] Drafts kept per room and thread
- [x] `@` mention completion (recent authors, `@all`, `@here`)
- [x] `:` emoji completion
- [x] Emoji picker (search, categories)
- [x] Reply with quote (permalink prefix)
- [ ] Attach files (file chooser; desktop: drag-and-drop and paste replace the Android share sheet)
- [ ] Pre-send preview: captions, reduced/original quality
- [ ] Checks against `FileUpload_MaxFileSize` and `FileUpload_MediaTypeWhiteList`
- [ ] Upload in two steps (`rooms.media`, `rooms.mediaConfirm`) with progress
- [ ] Voice recording

## 5. Message actions

- [x] Quick reactions (👍 ❤️ 😂 🎉 😮 🙏) and removing mine
- [x] Reply (quote), reply in thread
- [x] Copy text
- [x] Download or open an attachment (desktop equivalent of Share)
- [x] Edit (`chat.update`) within the server's time limit and permissions
- [x] Delete (`chat.delete`)
- [x] Pin (`chat.pinMessage`)

## 6. Threads

- [x] Thread view: root and replies (`chat.getMessage`, `chat.getThreadMessages`), live, composer targeting the thread

## 7. Search

- [ ] Search messages in the room (`chat.search`)

## 8. Room info and profiles

- [ ] Room info: type, flags, members count, topic, announcement, description (`rooms.info`)
- [ ] User profile: avatar, name, username, presence, roles, local time, bio (`users.info`); Message and Call buttons
- [ ] My profile: avatar, status and presence, name, bio, email and username (with password and 2FA)
- [ ] Live avatar changes (`updateAvatar`)

## 9. Settings

- [ ] Settings page: profile card, notification preference (`users.setPreferences`), language, E2EE status, account, server
- [x] Languages: French and English, automatic by default

## 10. Notifications (desktop equivalent of Android push)

- [ ] Desktop notifications for DMs and mentions while the app runs (tray or background), click opens the room
- [ ] Reply from the notification, where the desktop supports it
- [ ] Nothing for encrypted rooms' content

## 11. End-to-end encryption (read only)

- [ ] Unlock with the E2E password (`e2e.fetchMyKeys`), decrypt messages and previews, lock again

## 12. Calls

- [ ] Start (`video-conference.start`) and join (`video-conference.join`) a Jitsi call (desktop: in the browser)

## 13. Sharing and links

- [ ] `rocketvibe://salon/<rid>?host=` links open the room (desktop entry registered as URL handler)
- [ ] Drop or paste files and text from other apps into a room (desktop equivalent of the share intent)

## 14. Offline and resilience

- [x] Local SQLite per server and account, screens from the database
- [x] Text outbox surviving restarts, retry on reconnection
- [x] Reconnection with back-off, dead-socket probe, catch-up after the subscriptions are armed
- [ ] Rooms deleted server-side purged locally (reconciliation)
- [ ] `chat.syncMessages` catch-up of edits and deletions in the open room
