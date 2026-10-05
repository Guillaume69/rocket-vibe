# Search

Two searches, both server-side and debounced: finding people and channels to start a conversation (`spotlight`), and finding messages inside the open room (`chat.search`). Neither app searches its local database, and neither app searches messages across rooms: `chat.search` requires a `roomId`.

## Shared rules

- **One request per typing pause, not per key**: REST is limited to 10 calls per minute. Mobile waits 300 ms (`ui/debouncedSearch.ts`), GTK 300 ms for spotlight and 350 ms for messages, SwiftUI 250 ms and 300 ms.
- **Late answers are dropped** by a sequence or generation counter: without it, the slow answer for "a" would overwrite the fresh results for "ab" (the REST client's replay after a 429 makes this a real case).
- **An empty query resets everything at once**, results and error alike, without a request.
- Errors show inline ("search failed"); "no result" is shown only once a request for the current text has answered. Mobile derives "searching" from the query whose results are on screen (`answered`), so the debounce window never shows a false "no result".

## Starting a conversation (spotlight)

`GET spotlight?query=` returns users and public rooms. Picking a user opens or creates the DM (`im.create`, idempotent on the server); picking a channel joins it (`channels.join`). The returned room is ingested right away so navigation does not wait for the stream.

- Mobile: `app/search.tsx`, reached from the room list. Users first, then channels. A DM goes through `actions.openOrCreateDm`, a channel through `channels.join`, then the screen is replaced by the room. A ref blocks double taps; errors share the screen's message line with the search.
- GTK: the "New conversation" dialog (`rv-gtk/src/spotlight.rs`), results from `rooms::spotlight_results` (users first, then rooms, each marked when already joined). `Chat::go_to` opens a DM with `Session::open_dm`, joins a channel only if not already a member (`Session::join_channel`), catches up the room list, then opens the room.
- SwiftUI: the sidebar's search field (`.searchable` in `ChatView.swift`) replaces the room sections with spotlight results while it holds text; a pick goes through `AppModel.go(to:)`.

This is the only place the apps call `spotlight`; `@` mention completion deliberately uses local recent authors instead ([composer](composer.md#mentions-and-emoji)).

## Messages in a room (`chat.search`)

`GET chat.search?roomId=&searchText=&count=50`, opened from the room header's search button.

- Mobile: `app/message-search.tsx`. Results are **ephemeral**: normalised with `toMessage` like any server document, rendered with the regular `MessageRow`, and never written to SQLite (isolated old messages have no place in the local window). They are read-only: no long press (the action sheet reads the database by id, and an old result may not be there), no reaction toggling, each with its own header. A tap goes back to the room at the message (`ui/messageJump.ts`; a context window when it is older than the local history, see [room-view.md](room-view.md)), or opens the thread of a reply that lives there.
- GTK: a dialog (`details::search` in `rv-gtk/src/details.rs`) listing author, date and the rendered body. A click closes it and **goes to the message**: a thread reply opens its thread, anything else is revealed in the room, in the history around it when it is older than what is loaded, whatever its age (`Chat::jump_to`, the context window of [room-view.md](room-view.md)). A toast says so only when the server cannot give the message back.
- SwiftUI: `SearchView` in `Details.swift`, the same list; a tap jumps through `RoomModel.jump(to:)`, which opens the history around an old message as GTK does. It does not special-case thread replies.

## Parity

Both apps: spotlight for new conversations, `chat.search` in a room, jumping from a result to the message whatever its age. Neither: a search across rooms, or a filter over the local room list.

## Sources

- apps/mobile/ui/debouncedSearch.ts
- apps/mobile/app/search.tsx
- apps/mobile/app/message-search.tsx
- apps/mobile/app/index.tsx
- apps/mobile/app/room/[rid].tsx
- apps/mobile/providers/rocketchat/actions.ts
- apps/mobile/lib/normalize.ts
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/context.rs
- apps/desktop/crates/rv-core/src/rooms.rs
- apps/desktop/crates/rv-core/src/info.rs
- apps/desktop/crates/rv-gtk/src/spotlight.rs
- apps/desktop/crates/rv-gtk/src/details.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/macos/Sources/RocketVibe/ChatView.swift
- apps/desktop/macos/Sources/RocketVibe/Details.swift
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
