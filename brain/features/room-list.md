# Room list

The home screen of both apps: every room the account is subscribed to, grouped into Unread, Favourites, my own sidebar categories (Mattermost and kChat), Channels and Direct messages, each ordered by latest activity, with a preview, an unread badge and a presence dot on direct messages. The list is a projection of the local SQLite database; the sync engine writes, the list re-reads.

## Shared rules

- **Data.** Two documents per room: the room (`rooms.get`, stream `<uid>/rooms-changed`) gives name, type, last message, read-only, encryption and photo version; the subscription (`subscriptions.get`, stream `<uid>/subscriptions-changed`) gives unread count, mentions, the `alert` flag, `open` (hidden or not), the favourite star `f` and `ls` (last seen). Both are fetched as deltas (`updatedSince`) at each catch-up; see [offline-and-sync.md](offline-and-sync.md).
- **Sections**, in this order, each keeping the incoming order (latest activity first) and dropped when empty:
  1. **Unread**: `unread > 0` or `alert`, all room types mixed. `alert` matters on its own: a mention can raise it without moving the counter.
  2. **Favourites**: rooms starred on the server (`f`), when nothing is unread.
  3. **My categories** (Mattermost and kChat only): one section per sidebar category of my own, titled with its name, for rooms that are neither unread nor favourite.
  4. **Channels**: everything that is not a DM (`t` other than `d`).
  5. **Direct messages** (`t == 'd'`).
- **Sidebar order.** A Mattermost subscription carries `group_rank`, its category's position in my sidebar (team index × 1000 + position in `order`); after Unread, the sections are sorted by the smallest rank of their rooms, so they follow my order (TECH, Infra, Favourites, Channels...). Without ranks (Rocket.Chat, RocketVibe, a server older than 5.32) the order above stands. A favourite always goes to Favourites, even while its row still names the category it left. Within a section, order stays latest activity first: Mattermost's per-category `sorting` (manual, alphabetical) is not followed. See [mattermost-and-kchat](mattermost-and-kchat.md) and `docs/MATTERMOST.md` §4.8.
- **Listed conversations (Mattermost and kChat).** A direct or group conversation closed in my sidebar (`direct_channel_show` / `group_channel_show` "false") is not listed, and the Direct messages section keeps only my `limit_visible_dms_gms` most recent (40 by default); favourites, my categories, anything unread and a conversation opened in the session always show. The subscription's `open` carries it (`MmSidebar`, `categories::Sidebar`; `docs/MATTERMOST.md` §4.9). A direct message's name follows the account's name format and ends with the person's custom status emoji (`app/index.tsx`, GTK `rows.rs`, rv-ffi room names).
- **Folding.** Tapping or clicking a section title folds it; folded, it shows its count. With a single section there is no title at all, so nothing can be folded (otherwise it could never be unfolded). The folded set is remembered across launches; a category is remembered by `group:<category id>`. The server's own `collapsed` flag is not read.
- **Ordering.** By the last message's timestamp, descending. Mobile takes `lastMessage.ts`, falling back to the room's `lm`.
- **Hidden rooms.** A subscription with `open: false` is left out.
- **DM names and partners.** On 8.5 a DM's rid is a random id, not the two uids concatenated, so the other participant comes from the room's `uids`, and only for two-person DMs (a group DM has no single presence). A DM has no `name`/`fname` in `rooms.get`; its display name comes from `usernames`, excluding me only when I am provably in the list (mobile `toRoom` in `lib/normalize.ts`).
- **Real names or usernames (Rocket.Chat).** The apps follow the server's public setting `UI_Use_Real_Name` (off by default, off on `chat.barrut.me`), read once per session from `settings.public?_id=UI_Use_Real_Name`, like the server's own clients (user decision, 2026-10-09, [decisions](../decisions.md#protocol)). Off: usernames everywhere, pushes included. On: a two-person DM shows its peer's real name and message authors theirs, falling back to the username. The real names come from each message's `u.name`, `me`, `users.info` and a DM subscription's `fname` (the other person's name); a group DM keeps its usernames. The full subscriptions list of the once-per-session reconciliation backfills every DM's `fname`, so DMs no catch-up touched since the upgrade are named too (mobile `reconcileRooms` in `lib/catchUp.ts` through `saveDmNames`, desktop `reconcile_rooms` in `rv-core/src/sync.rs` through `note_dm_name`). Mobile: `users.name` (migration 0025, `db/upserts.ts` `UPSERT_USER`, `UPSERT_IDENTITY`, `UPDATE_DM_PEER_NAME`), the flag in `ui/realNames.ts` (kept per server in SecureStore for the first render), fed into the display-name store (`lib/displayNames.ts`, Mattermost's) by `ui/identities.tsx`, DM titles through `roomTitle` (`ui/identityStore.ts`). Desktop: the store's `people` (`uid`, `name`, `seen`: an older message's name never replaces a newer one) and `server_settings` tables (`rv-core/src/store.rs`, `ROOM_TITLE` in the list and notification queries, `real_names`, `person_name`, `note_person`, `note_author`, `note_dm_name`, `set_real_names`), `Session::person_label` for authors in GTK and SwiftUI. Search shows a channel's `fname` like the list (mobile `app/search.tsx`, `rooms::spotlight_results`).
- **Presence.** Kept in memory only, never persisted (a stale presence from cache is worse than none). Loaded with `users.presence` at each connection, then kept current by `stream-notify-logged` / `user-status`, whose args are `[[uid, username, statusCode, statusText]]` with codes 0 offline, 1 online, 2 away, 3 busy. The dedicated `stream-user-presence` uses a proprietary protocol the minimal DDP clients do not speak. Past about 200 connections the server sets `Presence_broadcast_disabled` and goes quiet; nothing depends on presence.
- **Previews.** The last message flattened to one line of plain text (markdown syntax removed). A message that is only a file has an empty `msg`, so the preview falls back to the attachment's `description` then `title`. A system message (a join, a call) is translated at render time from its stored type, so a language switch applies immediately. Encrypted rooms never show ciphertext.

## Mobile

- **Screen.** `app/index.tsx` (`HomeScreen`) is both gatekeeper (no session redirects to `/login`) and list. It runs **two live queries, one per table** (`rooms` ordered by `last_message_ts`, and `subscriptions`), because drizzle's `useLiveQuery` only listens to the table in its `FROM`: a join would miss writes that only touch subscriptions (read on another device, room hidden). The merge happens in JS.
- **Projection.** `ui/homeSections.ts` (`buildSections`, `collapseSections`) is pure and unit-tested. The subscription columns `group_id`, `group_name`, `group_rank` (migration `0023_sidebar_groups`) carry the category. A room without a subscription row stays visible rather than flickering. `ui/collapsedSections.ts` keeps the folded set in Secure Store under `collapsed-sections` (section keys `unread`, `favorites`, `rooms`, `directMessages`), read synchronously at module load so the first render is already folded; it is global to the device, not per server. A value still under the pre-0016 key `sections-repliees` is moved on first read (`readMovedKeySync`, `lib/storageKeys.ts`), and the old French section keys it holds are mapped to the new ones (`readCollapsedSections` in `ui/homeSections.ts`).
- **Row.** `RoomRow`: avatar tile (`RoomAvatar`, see [avatars.md](avatars.md)), name in bold when the room is in alert, one-line preview, and `UnreadBadge` (yellow, `99+` cap). No timestamp and no separate mention marker in the row. Encrypted rooms show a 🔒 before the name and a grey padlock tile while E2EE is locked; their preview reads "encrypted messages" until a message is decrypted locally, at which point `UPDATE_ENCRYPTED_PREVIEW` stores a clear preview. `textPreview` (`lib/markdown.ts`) and `systemPreview` (`lib/systemMessages.ts`) build the text.
- **Presence.** `PresenceEngine` (`lib/presence.ts`) holds the statuses; `usePresence` (`ui/presence.ts`) reads them through `useSyncExternalStore`, and a row without a DM partner does not subscribe at all. An unknown status draws nothing. Colours come from theme tokens via `presenceColors`.
- **Header.** Brand, settings gear and the `SyncBar` comet, lit while the global catch-up runs (`useActivity('global')`).
- **New conversation.** A fixed first row opens `/search` (spotlight search, DM creation, channel join); see [search.md](search.md).

## Desktop

- **Core.** `rv-core/src/rooms.rs` (`sections`) implements the same sections, a category being `Section::Group { id, name }`, and `Section::key` gives the folded-sections file's key for GTK and SwiftUI alike; the subscription columns `group_id`, `group_name`, `group_rank` come from the last `MIGRATIONS` step; `Store::rooms` (`rv-core/src/store.rs`) is one SQL query joining `rooms` and `subscriptions` on `open = 1`, ordered by `last_message_ts`. Unlike mobile, a room with no subscription row is not listed. The `mentions` column sums user and group mentions.
- **GTK.** `rv-gtk/src/chat.rs` (`load_rooms`) rebuilds a `gio::ListStore` of headers and rooms only when the rows changed (or when forced by a presence, photo or E2EE change). Folded sections are kept in the config file `rocket-vibe-rs/collapsed-sections`. `rv-gtk/src/rows.rs` (`room_widget`) draws the tile with photo, name, short time, preview and `widgets::unread_badge`, which reads `@n` with a pink style when there are mentions and a plain yellow count otherwise. Previews of system messages are prefixed with the author (`i18n::system_message`). An encrypted room's last message is stored encrypted (`last_encrypted`) and decrypted for the preview when the session is unlocked; locked, the preview reads "Encrypted message". The sidebar header has a connection dot (online, connecting, offline). One sync comet, overlaid on the window's top edge across both panes, sweeps while connecting or loading history (`ChatPage::update_comet`).
- **Presence.** `rv-core/src/live.rs` parses `user-status`; `Session::presence` returns `None` until `users.presence` has answered once, then treats any uid it did not list as offline (the route only lists people who are not offline).
- **Counts.** `unread_rooms` (rooms with something unread) goes to the window title; `badge` (DM unreads plus mentions elsewhere, or a dot for plain unread chatter) goes to the dock or taskbar through `rv-gtk/src/badge.rs`. See [notifications.md](notifications.md).
- **New conversation.** The sidebar header's "+" is a menu (user decision, 2026-10-09: a bare "+" said nothing): "New message" opens the spotlight dialog (`rv-gtk/src/spotlight.rs`, `rooms::spotlight_results`: users first, then public rooms), "Create a channel" the room creation form, offered on RocketVibe only (no app creates Rocket.Chat channels yet). The section headers carry a "+" too: Direct messages finds a person, Channels creates a channel and shows only where one can be created (RocketVibe: GTK when the page has a native session, SwiftUI `RoomSections.canCreate`). GTK `chat.rs` (`action_popover`, `section_header`'s `add`); SwiftUI `RoomListView` (a `Menu`, "New message" focusing the sidebar search, the headers' "+" through `RoomSections.add`). Web: the same menu with "Browse channels" as a third entry, each opening `newConversation` on its tab (`panels.ts`), and the same section "+", chosen by the section's key (`app.ts#renderRooms`). Mobile already labels its rows ("New conversation", "Create a room") and keeps them.
- **Account menu** (user decision, 2026-10-09, [decisions](../decisions.md#desktop)). The account block at the sidebar's foot shows a gear and opens a menu: Settings, Server administration for an administrator, Sign out, which left the header where it sat next to "+". GTK `ChatPage::account_menu` and web `App.accountMenu` open it at once and ask the administrator status the first time it opens, cached per account (`ChatPage.administrator`, `App.administrator {key, value}`; GTK never asks on Mattermost, web only with the `administration` capability); when the answer comes, the row is inserted into the menu still open. SwiftUI `AccountBar` (a `Menu`, built synchronously) shows the row from `AppModel.administrator`, asked when a session starts and each time the settings open. Web menus come from `dom.ts#actionMenu` / `menuRow` (a light-dismiss popover: a click outside closes it with no action, a second click on its opener closes it rather than stacking another). Mobile keeps its header gear.
- **SwiftUI.** `RoomListView` in `macos/Sources/RocketVibe/ChatView.swift` uses `rv-ffi`'s `rooms()` (the same `rooms::sections`; a `RoomGroup` carries its `key` and, for `.group`, its `title`), `Section(isExpanded:)` for folding, and the same `collapsed-sections` file (`AppModel`, keyed by `RoomGroup.key`). The badge reads `@n` on mentions.

## Parity

[Parity](../parity.md) §2 is implemented, Favourites and sidebar categories included (`rooms::Section::Favorites` and `Section::Group`, `homeSections` keys `favorites` and `group:<id>`). Visible differences: desktop shows the time and an `@` badge on mentions, mobile does neither; desktop keeps the padlock tile on encrypted rooms even when unlocked, mobile switches back to the normal tile; desktop treats an unlisted user as offline once presence loaded, mobile shows nothing for an unknown status.

## Sources

- apps/mobile/app/index.tsx
- apps/mobile/ui/homeSections.ts
- apps/mobile/providers/mattermost/categories.ts
- apps/mobile/ui/collapsedSections.ts
- apps/mobile/lib/storageKeys.ts
- apps/mobile/ui/presence.ts
- apps/mobile/ui/kit.tsx
- apps/mobile/lib/presence.ts
- apps/mobile/lib/normalize.ts
- apps/mobile/lib/markdown.ts
- apps/mobile/lib/systemMessages.ts
- apps/mobile/lib/catchUp.ts
- apps/mobile/db/schema.ts
- apps/desktop/crates/rv-core/src/rooms.rs
- apps/desktop/crates/rv-core/src/mattermost/categories.rs
- apps/desktop/crates/rv-core/src/store.rs
- apps/desktop/crates/rv-core/src/live.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/normalize.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-gtk/src/widgets.rs
- apps/desktop/crates/rv-gtk/src/badge.rs
- apps/desktop/crates/rv-gtk/src/spotlight.rs
- apps/desktop/macos/Sources/RocketVibe/ChatView.swift
- apps/desktop/macos/Sources/RocketVibeKit/AppModel.swift
- apps/mobile/ui/realNames.ts
- apps/mobile/ui/identities.tsx
- apps/mobile/ui/identityStore.ts
- apps/mobile/db/upserts.ts
- apps/mobile/db/store.ts
- apps/mobile/db/migrations/0025_user_names.sql
- apps/mobile/app/search.tsx
- apps/desktop/crates/rv-core/src/sync.rs
- apps/web/src/app.ts
- apps/web/src/dom.ts
- apps/web/src/panels.ts
