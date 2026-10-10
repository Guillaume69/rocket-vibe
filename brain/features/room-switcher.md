# Room switcher

A keyboard shortcut opens a dialog over the window that lists the account's rooms, searched by name as typed; Return opens the selected room, the arrows move the selection, a click on a row opens it, and a click outside or Escape closes it with nothing opened. It covers every room of the list, on any server kind (Rocket.Chat, Mattermost and kChat, RocketVibe), voice channels included (opening one joins its session, as a click in the list does).

## The rule

`rv_core::rooms::switcher_matches(rooms, query)` (`rv-core/src/rooms.rs`) keeps the rooms whose shown name or slug holds the query, case and accents aside (lowercase, then `native::workflows::fold`). A name that starts with the query comes first, then one with a word starting with it, then one holding it anywhere; ties go to the latest activity (`last_ts`). An empty query lists every room, latest activity first. The switcher only reads the room list the app already holds: no request.

## Mobile

Not offered: the room list has no filter of its own, and the search screen (`app/search.tsx`) is the server's spotlight (people and public rooms), not the joined rooms.

## Desktop

- **GTK**: Ctrl+K anywhere in the chat page (a `ShortcutController` on the split, beside Alt+Left/Right, `ChatPage::open_switcher` in `rv-gtk/src/chat.rs`). The dialog is `rv-gtk/src/switcher.rs`: a `SearchEntry` that keeps the focus, a `ListBox` in browse mode whose first row is selected after each search, Up/Down caught in the capture phase to move the selection and scroll it into view, Return activating the selected row. Each row shows the tile (with the photo on a Rocket.Chat or Mattermost account), the name (bold when unread) and the unread badge. `ChatPage` keeps a weak reference so a second Ctrl+K does not stack another dialog, and drops a pick whose room is no longer in the list (the account changed meanwhile). The link of the formatting toolbar moved to Ctrl+Shift+K (user decision, 2026-10-10, [decisions](../decisions.md)); `composer.rs` lets plain Ctrl+K through.
- **SwiftUI**: "Go to room…" in the menu bar, Cmd+K (`AppCommands` in `RocketVibeApp.swift`), off while the settings or the administration cover the window; it sets `AppModel.switching`, which `ChatView` shows as an in-window overlay (`RoomSwitcher.swift`): the search field, `onKeyPress` for the arrows, `onSubmit` for Return, `AppModel.select` to open. The order comes from rv-ffi's `switcher_matches` (`rv-ffi/src/model.rs`) over `AppModel.rooms`.
- Smoke: `RV_SMOKE_DETAILS=switcher:<room>` opens it twice (one dialog), types the room's name, checks it is listed first and selected, and that Return opens it (`rv-gtk/src/smoke.rs`).

## Web

Ctrl+K opens "New conversation" (`panels.ts#newConversation`: people, public rooms, creation), not a switcher of the joined rooms.

## Sources

- apps/desktop/crates/rv-core/src/rooms.rs
- apps/desktop/crates/rv-core/src/native/workflows.rs
- apps/desktop/crates/rv-gtk/src/switcher.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/composer.rs
- apps/desktop/crates/rv-gtk/src/smoke.rs
- apps/desktop/crates/rv-ffi/src/model.rs
- apps/desktop/macos/Sources/RocketVibe/RoomSwitcher.swift
- apps/desktop/macos/Sources/RocketVibe/RocketVibeApp.swift
- apps/desktop/macos/Sources/RocketVibe/ChatView.swift
- apps/desktop/macos/Sources/RocketVibeKit/AppModel.swift
- apps/web/src/app.ts
- apps/web/src/panels.ts
- apps/mobile/app/search.tsx
