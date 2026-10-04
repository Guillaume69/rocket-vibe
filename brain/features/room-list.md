# Room list

The home screen of both apps: every room the account is subscribed to, grouped into Unread, Favourites, Channels and Direct messages, each ordered by latest activity, with a preview, an unread badge and a presence dot on direct messages. The list is a projection of the local SQLite database; the sync engine writes, the list re-reads.

## Shared rules

- **Data.** Two documents per room: the room (`rooms.get`, stream `<uid>/rooms-changed`) gives name, type, last message, read-only, encryption and photo version; the subscription (`subscriptions.get`, stream `<uid>/subscriptions-changed`) gives unread count, mentions, the `alert` flag, `open` (hidden or not), the favourite star `f` and `ls` (last seen). Both are fetched as deltas (`updatedSince`) at each catch-up; see [offline-and-sync.md](offline-and-sync.md).
- **Sections**, in this order, each keeping the incoming order (latest activity first) and dropped when empty:
  1. **Unread**: `unread > 0` or `alert`, all room types mixed. `alert` matters on its own: a mention can raise it without moving the counter.
  2. **Favourites**: rooms starred on the server (`f`), when nothing is unread.
  3. **Channels**: everything that is not a DM (`t` other than `d`).
  4. **Direct messages** (`t == 'd'`).
- **Folding.** Tapping or clicking a section title folds it; folded, it shows its count. With a single section there is no title at all, so nothing can be folded (otherwise it could never be unfolded). The folded set is remembered across launches.
- **Ordering.** By the last message's timestamp, descending. Mobile takes `lastMessage.ts`, falling back to the room's `lm`.
- **Hidden rooms.** A subscription with `open: false` is left out.
- **DM names and partners.** On 8.5 a DM's rid is a random id, not the two uids concatenated, so the other participant comes from the room's `uids`, and only for two-person DMs (a group DM has no single presence). A DM has no `name`/`fname` in `rooms.get`; its display name comes from `usernames`, excluding me only when I am provably in the list (mobile `versSalon` in `lib/normaliser.ts`).
- **Presence.** Kept in memory only, never persisted (a stale presence from cache is worse than none). Loaded with `users.presence` at each connection, then kept current by `stream-notify-logged` / `user-status`, whose args are `[[uid, username, statusCode, statusText]]` with codes 0 offline, 1 online, 2 away, 3 busy. The dedicated `stream-user-presence` uses a proprietary protocol the minimal DDP clients do not speak. Past about 200 connections the server sets `Presence_broadcast_disabled` and goes quiet; nothing depends on presence.
- **Previews.** The last message flattened to one line of plain text (markdown syntax removed). A message that is only a file has an empty `msg`, so the preview falls back to the attachment's `description` then `title`. A system message (a join, a call) is translated at render time from its stored type, so a language switch applies immediately. Encrypted rooms never show ciphertext.

## Mobile

- **Screen.** `app/index.tsx` (`EcranAccueil`) is both gatekeeper (no session redirects to `/connexion`) and list. It runs **two live queries, one per table** (`salons` (rooms) ordered by `horodatage_dernier_message`, and `abonnements` (subscriptions)), because drizzle's `useLiveQuery` only listens to the table in its `FROM`: a join would miss writes that only touch subscriptions (read on another device, room hidden). The merge happens in JS.
- **Projection.** `ui/sectionsAccueil.ts` (`construireSections`, `replierSections`) is pure and unit-tested. A room without a subscription row stays visible rather than flickering. `ui/sectionsRepliees.ts` keeps the folded set in Secure Store under `sections-repliees`, read synchronously at module load so the first render is already folded; it is global to the device, not per server.
- **Row.** `LigneSalon`: avatar tile (`AvatarSalon`, see [avatars.md](avatars.md)), name in bold when the room is in alert, one-line preview, and `BadgeNonLus` (yellow, `99+` cap). No timestamp and no separate mention marker in the row. Encrypted rooms show a 🔒 before the name and a grey padlock tile while E2EE is locked; their preview reads "encrypted messages" until a message is decrypted locally, at which point `MAJ_APERCU_CHIFFRE` stores a clear preview. `apercuTexte` (`lib/markdown.ts`) and `apercuSysteme` (`lib/messagesSysteme.ts`) build the text.
- **Presence.** `MoteurPresence` (`lib/presence.ts`) holds the statuses; `usePresence` (`ui/presence.ts`) reads them through `useSyncExternalStore`, and a row without a DM partner does not subscribe at all. An unknown status draws nothing. Colours come from theme tokens via `couleursPresence`.
- **Header.** Brand, settings gear and the `BarreSynchro` comet, lit while the global catch-up runs (`useActivite('global')`).
- **New conversation.** A fixed first row opens `/recherche` (spotlight search, DM creation, channel join); see [search.md](search.md).

## Desktop

- **Core.** `rv-core/src/rooms.rs` (`sections`) implements the same four sections; `Store::rooms` (`rv-core/src/store.rs`) is one SQL query joining `rooms` and `subscriptions` on `open = 1`, ordered by `last_message_ts`. Unlike mobile, a room with no subscription row is not listed. The `mentions` column sums user and group mentions.
- **GTK.** `rv-gtk/src/chat.rs` (`load_rooms`) rebuilds a `gio::ListStore` of headers and rooms only when the rows changed (or when forced by a presence, photo or E2EE change). Folded sections are kept in the config file `rocket-vibe-rs/collapsed-sections`. `rv-gtk/src/rows.rs` (`room_widget`) draws the tile with photo, name, short time, preview and `widgets::unread_badge`, which reads `@n` with a pink style when there are mentions and a plain yellow count otherwise. Previews of system messages are prefixed with the author (`i18n::system_message`). An encrypted room's last message is stored encrypted (`last_encrypted`) and decrypted for the preview when the session is unlocked; locked, the preview reads "Encrypted message". The sidebar header has a connection dot (online, connecting, offline) and the sync comet.
- **Presence.** `rv-core/src/live.rs` parses `user-status`; `Session::presence` returns `None` until `users.presence` has answered once, then treats any uid it did not list as offline (the route only lists people who are not offline).
- **Counts.** `unread_rooms` (rooms with something unread) goes to the window title; `badge` (DM unreads plus mentions elsewhere, or a dot for plain unread chatter) goes to the dock or taskbar through `rv-gtk/src/badge.rs`. See [notifications.md](notifications.md).
- **New conversation.** A spotlight dialog (`rv-gtk/src/spotlight.rs`, `rooms::spotlight_results`: users first, then public rooms).
- **SwiftUI.** `RoomListView` in `macos/Sources/RocketVibe/ChatView.swift` uses `rv-ffi`'s `rooms()` (the same `rooms::sections`), `Section(isExpanded:)` for folding, and the same `collapsed-sections` file (`AppModel`). The badge reads `@n` on mentions.

## Parity

[Parity](../parity.md) §2 is implemented, Favourites included (`rooms::Section::Favorites`, `sectionsAccueil` key `favoris`). Visible differences: desktop shows the time and an `@` badge on mentions, mobile does neither; desktop keeps the padlock tile on encrypted rooms even when unlocked, mobile switches back to the normal tile; desktop treats an unlisted user as offline once presence loaded, mobile shows nothing for an unknown status.

## Sources

- apps/mobile/app/index.tsx
- apps/mobile/ui/sectionsAccueil.ts
- apps/mobile/ui/sectionsRepliees.ts
- apps/mobile/ui/presence.ts
- apps/mobile/ui/kit.tsx
- apps/mobile/lib/presence.ts
- apps/mobile/lib/normaliser.ts
- apps/mobile/lib/markdown.ts
- apps/mobile/lib/messagesSysteme.ts
- apps/mobile/lib/rattrapage.ts
- apps/mobile/db/schema.ts
- apps/desktop/crates/rv-core/src/rooms.rs
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
