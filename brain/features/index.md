# Features index

What the apps do. Each doc describes the feature, then its `## Mobile` and
`## Desktop` sides (GTK, with SwiftUI differences) and their parity. The
two-way parity tracker is [../parity.md](../parity.md). Back to
[../BRAIN.md](../BRAIN.md).

## Session and data

| Doc | What's here |
|---|---|
| [login-and-servers.md](login-and-servers.md) | Server probe, password login, 2FA (TOTP, email, password), optimistic session resume, revocation on a real 401, deferred sign-out; one account per server on mobile, several per server on desktop. |
| [offline-and-sync.md](offline-and-sync.md) | Catch-up layers (global delta, history, per-room `chat.syncMessages`, reconciliation), mobile hot rooms and connection generations, write queue and outbox, retention, desktop's `__my_messages__` stream, known differences. |
| [settings.md](settings.md) | What is stored where, the same clickable categories in all three apps (mobile pages, GTK sidebar dialog, SwiftUI overlay): account, notifications, language, encryption, security, devices, accounts, app. |
| [administration.md](administration.md) | Server administration for an administrator (Dashboard, Moderation, Rooms, Users), reporting a message or a user, the Rocket.Chat mapping and the RocketVibe contract, deleted accounts shown as "Deleted user". |

## Reading

| Doc | What's here |
|---|---|
| [room-list.md](room-list.md) | Unread, Favourites, Channels and Direct-messages sections and their rules, folding, ordering by activity, previews, badges, presence, encrypted rooms. |
| [room-view.md](room-view.md) | History window and keyset paging, live messages, edits and deletions, author grouping, day separators, new-messages bar, mark-as-read, markdown, system messages, quotes and cards, jumps, typing indicator. |
| [threads.md](threads.md) | Root and replies fetched apart, paging by 100 up to 20 pages, reconnection guard, live replies, the thread composer and its limits. |
| [search.md](search.md) | Debounced server search with stale answers dropped: `spotlight` for people and channels, `chat.search` in a room. |
| [media-playback.md](media-playback.md) | Protected-file URLs, original images, viewers, lazily created players, GStreamer and CPU-frame paths on desktop, video-site cards. |
| [avatars.md](avatars.md) | Avatar URLs, `?etag=` cache busting and where the version comes from, the no-photo marker, the placeholder, setting your own photo. |
| [emoji.md](emoji.md) | The shortcode table generated from emoji-toolkit, rendering order, the custom emoji index, `:` completion, pickers, quick reactions counted per account on the device. |
| [room-info-and-profiles.md](room-info-and-profiles.md) | Room info, user profiles (local time, Message, Call), mobile profile prefetch, editing my own profile and status. |

## Writing

| Doc | What's here |
|---|---|
| [composer.md](composer.md) | Where a send goes (outbox, upload queue, `commands.run`), drafts per room and thread, quote replies, `@` mentions, editing, GTK formatting and spell check, staged attachments. |
| [slash-commands.md](slash-commands.md) | `commands.list` with i18n keys, the RocketVibe server's commands, text commands written by the client, the command panel, `commands.run`, unknown names sent as text, the private answer above the composer. |
| [uploads.md](uploads.md) | `rooms.media` then `rooms.mediaConfirm` behind a persisted queue, the saved `fileId` and the local check that avoids duplicates, re-arming after a kill, retries, progress, validation, protected downloads. |
| [voice-messages.md](voice-messages.md) | AAC `.m4a` on mobile and SwiftUI, Ogg/Opus through GStreamer on GTK, replay and caption before sending, playback. |
| [message-actions.md](message-actions.md) | Which actions show (time limits, permissions, encrypted and system messages), the endpoints, the menus per app (quick reactions, any emoji, Report), pinned and starred lists. |

## Around the chat

| Doc | What's here |
|---|---|
| [notifications.md](notifications.md) | Mobile FCM chain (native token, patched server bundle, data-only push, `push.get` for hidden content, WorkManager catch-up, inline reply, iOS extension, badge); desktop notifier on D-Bus, WinRT or UserNotifications, and badge. |
| [e2ee.md](e2ee.md) | Encrypted rooms for the user: lock tile, placeholders, unlock, key kept across launches, encrypted sends and media, notifications without ciphertext. |
| [e2ee-history.md](e2ee-history.md) | RocketVibe server: encrypted history requested by a new device, reviewed and shared by another device of the account, imported page by page. |
| [e2ee-delegation.md](e2ee-delegation.md) | RocketVibe server: the controller hands the account root to another registered device inside a history share, adopted only if it is the account's own. |
| [e2ee-storage-keys.md](e2ee-storage-keys.md) | RocketVibe server: storage key renewal (state and blocks re-sealed, old key destroyed, resumable), expired KeyPackage keys destroyed. |
| [e2ee-private-files.md](e2ee-private-files.md) | RocketVibe server: files sealed on the device (`rv-file-v1`), the key only in the encrypted message, opened into the private cache while a view shows them. |
| [e2ee-private-actions.md](e2ee-private-actions.md) | RocketVibe server: encrypted amendments (the author's edits and deletions, any member's reactions) shown pending until accepted, and private search on the device. |
| [voice.md](voice.md) | RocketVibe server: voice sessions over LiveKit in every room, voice channels, ringing direct calls, who speaks; the Android module, the controller and screens; the desktop sidecar and core. |
| [calls.md](calls.md) | Rocket.Chat servers: Jitsi over `video-conference.*`, availability probe, the mobile WebView exception and its origin lock, desktop call windows per platform. |
| [sharing-and-links.md](sharing-and-links.md) | `rocketvibe://room/<rid>?host=` deep links, the incoming share screen, the outgoing-link guard, desktop drag and paste. |
| [desktop-updates.md](desktop-updates.md) | GitHub release discovery, cached check and dismissal, in-place replacement on Linux, installer on Windows, DMG on macOS. |
