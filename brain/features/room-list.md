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
- **Folding.** Tapping or clicking a section title folds it; folded, it shows its count. With a single section there is no title at all, so nothing can be folded (otherwise it could never be unfolded). The folded set is remembered across launches, per account (server and user): folding Channels on one server leaves the others as they were. A category is remembered by `group:<category id>`. Before 2026-10-12 one folded set served every account; each signed-in account starts from it once, then it is deleted. The server's own `collapsed` flag is not read.
- **Ordering.** By the last message's timestamp, descending. Mobile takes `lastMessage.ts`, falling back to the room's `lm`.
- **Hidden rooms.** A subscription with `open: false` is left out.
- **DM names and partners.** On 8.5 a DM's rid is a random id, not the two uids concatenated, so the other participant comes from the room's `uids`, and only for two-person DMs (a group DM has no single presence). A DM has no `name`/`fname` in `rooms.get`; its display name comes from `usernames`, excluding me only when I am provably in the list (mobile `toRoom` in `lib/normalize.ts`).
- **Real names or usernames (Rocket.Chat).** The apps follow the server's public setting `UI_Use_Real_Name` (off by default, off on `chat.barrut.me`), read once per session from `settings.public?_id=UI_Use_Real_Name`, like the server's own clients (user decision, 2026-10-09, [decisions](../decisions.md#protocol)). Off: usernames everywhere, pushes included. On: a two-person DM shows its peer's real name and message authors theirs, falling back to the username. The real names come from each message's `u.name`, `me`, `users.info` and a DM subscription's `fname` (the other person's name); a group DM keeps its usernames. The full subscriptions list of the once-per-session reconciliation backfills every DM's `fname`, so DMs no catch-up touched since the upgrade are named too (mobile `reconcileRooms` in `lib/catchUp.ts` through `saveDmNames`, desktop `reconcile_rooms` in `rv-core/src/sync.rs` through `note_dm_name`). Mobile: `users.name` (migration 0025, `db/upserts.ts` `UPSERT_USER`, `UPSERT_IDENTITY`, `UPDATE_DM_PEER_NAME`), the flag in `ui/realNames.ts` (kept per server in SecureStore for the first render), fed into the display-name store (`lib/displayNames.ts`, Mattermost's) by `ui/identities.tsx`, DM titles through `roomTitle` (`ui/identityStore.ts`). Desktop: the store's `people` (`uid`, `name`, `seen`: an older message's name never replaces a newer one) and `server_settings` tables (`rv-core/src/store.rs`, `ROOM_TITLE` in the list and notification queries, `real_names`, `person_name`, `note_person`, `note_author`, `note_dm_name`, `set_real_names`), `Session::person_label` for authors in GTK and SwiftUI. Search shows a channel's `fname` like the list (mobile `app/search.tsx`, `rooms::spotlight_results`).
- **Presence.** Kept in memory only, never persisted (a stale presence from cache is worse than none). Loaded with `users.presence` at each connection, then kept current by `stream-notify-logged` / `user-status`, whose args are `[[uid, username, statusCode, statusText]]` with codes 0 offline, 1 online, 2 away, 3 busy. The dedicated `stream-user-presence` uses a proprietary protocol the minimal DDP clients do not speak. Past about 200 connections the server sets `Presence_broadcast_disabled` and goes quiet; nothing depends on presence.
- **Previews.** The last message flattened to one line of plain text (markdown syntax removed). A message that is only a file has an empty `msg`, so the preview falls back to the attachment's `description` then `title`. A system message (a join, a call) is translated at render time from its stored type, so a language switch applies immediately. Encrypted rooms never show ciphertext.

## Mobile

- **Screen.** `app/index.tsx` (`HomeScreen`) is both gatekeeper (no session redirects to `/login`) and list. It runs **two live queries, one per table** (`rooms` ordered by `last_message_ts`, and `subscriptions`), because drizzle's `useLiveQuery` only listens to the table in its `FROM`: a join would miss writes that only touch subscriptions (read on another device, room hidden). The merge happens in JS.
- **Projection.** `ui/homeSections.ts` (`buildSections`, `collapseSections`) is pure and unit-tested. The subscription columns `group_id`, `group_name`, `group_rank` (migration `0023_sidebar_groups`) carry the category. A room without a subscription row stays visible rather than flickering. `ui/collapsedSections.ts` keeps every account's folded set in one Secure Store entry, `collapsed-sections-by-account` (`FOLDS_BY_ACCOUNT_KEY`): a JSON object keyed by `foldAccount` (`<server without trailing slash>|<user id>`), each value an array of section keys (`unread`, `favorites`, `rooms`, `directMessages`, `group:<id>`); `readFoldsByAccount` / `writeFoldsByAccount` in `ui/homeSections.ts`. It is read synchronously at module load so the first render is already folded; `useCollapsedSections(account)` and `toggleCollapsedSection(account, key)` take the account `app/index.tsx` derives from the session. The old device-wide array under `collapsed-sections` (moved first from the pre-0016 key `sections-repliees` by `readMovedKeySync`, its French section keys mapped by `readCollapsedSections`) is swept once at load: every account of `listKnownServers` with a session gets it unless it has folds of its own (`seedFolds`), then it is deleted; until then an account without folds reads it. Sign-out drops the account's entry (`forgetCollapsedSections`, from `clearTraces` in `ui/session.tsx`).
- **Row.** `RoomRow`: avatar tile (`RoomAvatar`, see [avatars.md](avatars.md)), name in bold when the room is in alert, one-line preview, the last message's time (`listTimeFormatter`, `ui/messages.ts`: the hour today, the short weekday within 7 days, the date beyond, the same rule as GTK's `short_time`) and `UnreadBadge` (yellow, `99+` cap; `@n` on the accent pink when the subscription carries mentions, like the desktop). A long press offers "Mark as unread" (`ProviderActions.markUnread`, Rocket.Chat `subscriptions.unread {roomId}`), or "Mark as read" while the room is in alert (`markAllRead`, `subscriptions.read {rid, readThreads: true}`: a plain read leaves `alert` set while threads are unread); the rebroadcast subscription carries the badge. Encrypted rooms show a lock icon before the name (and "Encrypted room" to a screen reader) and a grey padlock tile while E2EE is locked; their preview reads "encrypted messages" until a message is decrypted locally, at which point `UPDATE_ENCRYPTED_PREVIEW` stores a clear preview. `textPreview` (`lib/markdown.ts`) and `systemPreview` (`lib/systemMessages.ts`) build the text.
- **Presence.** `PresenceEngine` (`lib/presence.ts`) holds the statuses; `usePresence` (`ui/presence.ts`) reads them through `useSyncExternalStore`, and a row without a DM partner does not subscribe at all. An unknown status draws nothing. Colours come from theme tokens via `presenceColors`.
- **Header.** Server-bar toggle, brand, message search and the `SyncBar` comet, lit while the global catch-up runs (`useActivity('global')`). Settings is in the bottom account bar. Its avatar opens the compact native activity sheet (`app/presence.tsx`) and carries a presence badge; the username and settings gear remain visible.
- **New conversation.** A fixed first row opens `/search` (spotlight search, DM creation, channel join); see [search.md](search.md). A second row, "Create a room", opens the `app/new-room.tsx` form sheet (a name, Private on by default, a voice channel where the server offers voice) on RocketVibe and Rocket.Chat accounts (`NewConversationRow` in `app/index.tsx`). On Rocket.Chat it calls `ActionsRC.createChannel` (`groups.create` when private, else `channels.create`), ingests the returned room, then opens it; `creationRefusal` turns a refusal into "name taken", "name refused by the server" or "cannot create this kind of room".
- **Creating a Rocket.Chat channel.** The creator is the owner and only member: a public channel is then found through search, a private group reached by its invite link. The name goes as typed (trimmed): the server's own rule decides (`UTF8_Channel_Names_Validation`, `[0-9a-zA-Z-_.]+` by default, so no spaces or accents), and a taken name is refused whatever its kind. Mattermost and kChat accounts are not offered creation. The server facts are in `CLAUDE.md` ("Creating rooms").

## Desktop

- **Core.** `rv-core/src/rooms.rs` (`sections`) implements the same sections, a category being `Section::Group { id, name }`, and `Section::key` gives the folded-sections key for GTK and SwiftUI alike; `rv-core/src/collapsed_sections.rs` keeps the folds per account (`server_rail::key`, `<base url>|<user id>`) in `collapsed-sections.json` of the shared config dir (`load`, `toggle`), and `sync`, run with the signed-in accounts wherever they are loaded (`rv-gtk/src/secrets.rs`, `rv-ffi/src/accounts.rs#load_all`), drops the removed accounts and seeds the others from the old device-wide `collapsed-sections` file, which it then deletes (not when the keychain answered no account); the subscription columns `group_id`, `group_name`, `group_rank` come from the last `MIGRATIONS` step; `Store::rooms` (`rv-core/src/store.rs`) is one SQL query joining `rooms` and `subscriptions` on `open = 1`, ordered by `last_message_ts`. Unlike mobile, a room with no subscription row is not listed. The `mentions` column sums user and group mentions.
- **Unread or read again (Rocket.Chat).** The right-click room menu (GTK `room_menu`, SwiftUI `.contextMenu`) has the favourite toggle, then "Mark as unread" (`Session::mark_unread`, `subscriptions.unread {roomId}`), or "Mark as read" when the room is in alert (`Session::mark_room_read`, `subscriptions.read {rid, readThreads: true}`). `Writer::set_unread_mark` shows the badge at once without touching `updated_at`, so the subscription the stream brings replaces it. Marking the OPEN room unread leaves it first (`ChatPage::leave_room`, `AppModel.leaveRoom`): the pending read timer is dropped, `Session::close_room` releases its subscriptions, nothing is selected, so neither `schedule_read` nor `window_activated` reads it again, as the official web client leaves the room. An empty room answers `error-no-message-for-unread`, worded apart. Gated by `Session::unread_marks_available` (not Mattermost or kChat; the native session offers no such items). Opening a room still reads it without `readThreads`, so a room with unread threads stays in Unread after being read. Smoke step `RV_SMOKE_DETAILS=unread`.
- **Quote previews.** A last message that starts with quote links previews by its own words, a forward (a quote with no words) as "↪ Quoted message" (`actions::preview_words` in `rv-core/src/actions.rs`, read by GTK `rows.rs` and rv-ffi's room preview), as on mobile.
- **GTK.** `rv-gtk/src/chat.rs` (`load_rooms`) updates a `gio::ListStore` of headers and rooms only when the rows changed, replacing just the items between the unchanged head and tail of the list (a RocketVibe room's item carries its peer's presence, so a presence change replaces that row); a Rocket.Chat presence, photo or E2EE change forces every row to be rebuilt. RocketVibe rows read each room's last message alone (`NativeStore::last_message`). The page loads the account's folds when a session is set (`set_session`, `set_native_session`, through `folded_sections`) and `toggle_section` writes them back through `collapsed_sections::toggle`. `rv-gtk/src/rows.rs` (`room_widget`) draws the tile with photo, name, short time, preview and `widgets::unread_badge`, which reads `@n` with a pink style when there are mentions and a plain yellow count otherwise. Previews of system messages are prefixed with the author (`i18n::system_message`). An encrypted room's last message is stored encrypted (`last_encrypted`) and decrypted for the preview when the session is unlocked; locked, the preview reads "Encrypted message". The sidebar header has a server-bar toggle. The connection dot (online, connecting, offline) lives separately in the account footer and remains a reconnect button. One sync comet, overlaid on the window's top edge across both panes, sweeps while connecting or loading history (`ChatPage::update_comet`).
- **Presence.** `rv-core/src/live.rs` parses `user-status`; `Session::presence` returns `None` until `users.presence` has answered once, then treats any uid it did not list as offline (the route only lists people who are not offline).
- **Counts.** `unread_rooms` (rooms with something unread) goes to the window title; `badge` (DM unreads plus mentions elsewhere, or a dot for plain unread chatter) goes to the dock or taskbar through `rv-gtk/src/badge.rs`. See [notifications.md](notifications.md).
- **New conversation.** The sidebar header's "+" is a menu (user decision, 2026-10-09: a bare "+" said nothing): "New message" opens the spotlight dialog (`rv-gtk/src/spotlight.rs`, `rooms::spotlight_results`: users first, then public rooms), "Create a channel" the room creation form, offered on RocketVibe and Rocket.Chat accounts (GTK `ChatPage::creates_channels` and `create_channel`: the native form on RocketVibe, `rv-gtk/src/new_channel.rs` on Rocket.Chat, over `Session::create_channel` and `Session::channels_creatable`; SwiftUI `AppModel.createsChannels`, the same `NewRoomSheet` calling `createChannel` when the account is not native). The section headers carry a "+" too: Direct messages finds a person, Channels creates a channel and shows only where one can be created (GTK through the same check, SwiftUI `RoomSections.canCreate`). The spotlight dialog's Create button follows the same check. A refusal is said in the form, which keeps the typed name (`rocketchat::actions::creation_refusal`, the `new_channel.*` keys). GTK `chat.rs` (`action_popover`, `section_header`'s `add`); SwiftUI `RoomListView` (a `Menu`, "New message" focusing the sidebar search, the headers' "+" through `RoomSections.add`). Web: the same menu with "Browse channels" as a third entry, each opening `newConversation` on its tab (`panels.ts`), and the same section "+", chosen by the section's key (`app.ts#renderRooms`). Mobile already labels its rows ("New conversation", "Create a room") and keeps them.
- **Account menu** (user decision, 2026-10-09, [decisions](../decisions.md#desktop)). The account block at the sidebar's foot shows a gear and opens a menu: Settings, Server administration for an administrator, Sign out, which left the header where it sat next to "+". GTK `ChatPage::account_menu` and web `App.accountMenu` open it at once and ask the administrator status the first time it opens, cached per account (`ChatPage.administrator`, `App.administrator {key, value}`; GTK never asks on Mattermost, web only with the `administration` capability); when the answer comes, the row is inserted into the menu still open. SwiftUI `AccountBar` (a `Menu`, built synchronously) shows the row from `AppModel.administrator`, asked when a session starts and each time the settings open. Web menus come from `dom.ts#actionMenu` / `menuRow` (a light-dismiss popover: a click outside closes it with no action, a second click on its opener closes it rather than stacking another). Mobile keeps its header gear.
- **SwiftUI.** `RoomListView` in `macos/Sources/RocketVibe/ChatView.swift` uses `rv-ffi`'s `rooms()` (the same `rooms::sections`; a `RoomGroup` carries its `key` and, for `.group`, its `title`), `Section(isExpanded:)` for folding, and the same per-account folds (`AppModel.collapsed`, keyed by `RoomGroup.key`, loaded in `begin` and written by `toggle` through `rv-ffi`'s `Client.collapsedSections` / `toggleCollapsedSection` with `Account.key`). The badge reads `@n` on mentions.
- **Web.** `src/ui/rooms.tsx` folds by the section's key (`unread`, `favorites`, `channels`, `direct`) under `rv-fold:<Account.key>:<section>` in localStorage (`src/folds.ts`, tested in `tests/folds.test.ts`). The browser holds one account at a time, so `App.activate` calls `adoptFolds`: the other accounts' folds go, and the folds of earlier versions, kept under the section's translated title (`rv-fold:<title>`), become this account's for the current language, then go.

## Parity

[Parity](../parity.md) §2 is implemented, Favourites and sidebar categories included (`rooms::Section::Favorites` and `Section::Group`, `homeSections` keys `favorites` and `group:<id>`). Visible differences: desktop keeps the padlock tile on encrypted rooms even when unlocked, mobile switches back to the normal tile; desktop treats an unlisted user as offline once presence loaded, mobile shows nothing for an unknown status.

## Account activity shortcut

GTK and SwiftUI split the footer into an avatar activity menu and the name/gear account menu. The avatar offers Online, Away, Busy and Offline; its badge reflects my activity, independently of the server connection dot beside the account controls. A status choice reads the current profile and keeps its status text. Native accounts use the existing revision-checked, persisted profile operations; legacy accounts use the provider's status action. GTK ignores completions from a previous session. SwiftUI reuses MyProfileModel's account and pending-operation guards. Native own-profile revisions refresh the badge when another client changes my choice; legacy presence events update it.

Web provides the same avatar shortcut, presence badge and footer connection control. It refreshes my chosen status when my live profile revision changes. There is no web server-bar button because the browser uses a single serving origin. Mobile uses the bottom avatar and a keyboard-free native form sheet, keeps the status message, and fences completions to the originating account. A successful choice confirms my activity into PresenceEngine immediately, even when the server does not broadcast; a snapshot begun before the save cannot undo it.

The quick activity picker preserves profile text. Mattermost and kChat use the status-only endpoint, retaining their entire custom status including emoji and expiry. Legacy desktop activity confirmations keep a newer streamed status and cannot be undone by an older presence snapshot. Native clients display the current own-profile response, including when a durable operation replays an earlier receipt. Mobile publishes successful own-profile revisions to subscribed avatar controls even without live profile observations. SwiftUI scopes refreshes and saves to the account and retries failed profile reads with backoff.

## Sources

- apps/mobile/app/index.tsx
- apps/mobile/app/presence.tsx
- apps/mobile/ui/homeSections.ts
- apps/mobile/providers/mattermost/categories.ts
- apps/mobile/ui/collapsedSections.ts
- apps/mobile/ui/session.tsx
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
- apps/desktop/crates/rv-core/src/collapsed_sections.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-ffi/src/accounts.rs
- apps/desktop/macos/Sources/RocketVibeKit/AppModel.swift
- apps/web/src/folds.ts
- apps/web/src/ui/rooms.tsx
- apps/desktop/crates/rv-core/src/mattermost/categories.rs
- apps/desktop/crates/rv-core/src/store.rs
- apps/desktop/crates/rv-core/src/live.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/normalize.rs
- apps/mobile/app/new-room.tsx
- apps/mobile/providers/rocketchat/actions.ts
- apps/desktop/crates/rv-core/src/rocketchat/actions.rs
- apps/desktop/crates/rv-core/tests/channels.rs
- apps/desktop/crates/rv-gtk/src/new_channel.rs
- apps/desktop/crates/rv-ffi/src/rocket_chat.rs
- apps/desktop/macos/Sources/RocketVibe/NewRoom.swift
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-core/src/native/profiles.rs
- apps/desktop/crates/rv-core/src/native/store.rs
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

- `apps/mobile/providers/mattermost/activity.ts`
- `apps/mobile/providers/rocketvibe/chat.ts`
- `apps/desktop/crates/rv-core/src/live.rs`
- `apps/desktop/macos/Sources/RocketVibeKit/MyProfileModel.swift`
