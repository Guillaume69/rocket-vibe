# Search

Three searches, debounced: finding people and channels to start a conversation (`spotlight`, server), finding messages inside the open room (`chat.search`, server), and, on mobile, finding messages across rooms on the device (local SQLite), since `chat.search` requires a `roomId` and asking every room would spend the REST rate limit.

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
- Web Vibez: New message opens the same 420 by 480 spotlight, with a focused search entry, people before public channels, and a Create room button leading to the separate grouped conversation form. Empty text reads no directory; a 300 ms pause reads `/api/v1/users` and capability-gated `/api/v1/rooms/public?q=`, retaining at most 20 matching people. Sequence, account and dialog fences discard delayed answers. Picking a person opens or creates the real DM; picking an unjoined channel joins it. Creation and join receipts are personalized before navigation, with membership lifetime checks. Narrow windows use the native bottom-sheet arrangement. The sidebar Create a channel route opens the grouped form directly.

Mobile Mattermost and kChat accounts have no `spotlight`: the screen asks `Provider.searchPeople` instead (`MmActions.searchPeople`, `POST /users/search {term, limit: 20}`, me and deactivated accounts left out), as for WhatsApp; their channels are not offered there. The desktop's `mattermost::actions::spotlight` reads people and channels.

### Group direct messages

Several people can be started together on Rocket.Chat, Mattermost and kChat accounts (not Vibez, whose server has no group DMs, nor Slack, Teams or WhatsApp). One picked person opens the ordinary DM; two to seven (`GROUP_DM_MAX`: Mattermost's fixed 8 members and Rocket.Chat's default `DirectMesssage_maxUsers`, me included) open the group DM, the same set giving the same room back. Rocket.Chat: `im.create {usernames: "a,b"}`, which silently drops an unknown username. Mattermost/kChat: ids resolved (`/users/username/<u>` when the search gave none), `POST /channels/group [me, ...ids]`, then `group_channel_show` set `true` and the channel revealed in the sidebar. Server facts in `CLAUDE.md` and `docs/MATTERMOST.md` 6.3.

- Mobile: where `ProviderActions.openOrCreateGroupDm` exists, each person row of `app/search.tsx` carries a checkbox; once someone is picked, a tap on a row picks too. The picked show as chips above the list (a tap removes one) with Start; an eighth is refused with a line. `ActionsRC.openOrCreateGroupDm`, `MmActions.openOrCreateGroupDm`; the room is ingested and opened like a DM.
- GTK: `spotlight::open_chat` takes a `group` callback when `Session::group_dms_supported`: a check button at the end of each person row, the chips and Start in a bar above the results, a row activation toggling once someone is picked. `ChatPage::go_to_group` runs `Session::open_group_dm`, catches up, then opens the room. Strings `group_dm.*` (not shipped to the web catalog).
- SwiftUI: the + menu's New group message opens `NewGroupSheet` (`NewGroup.swift`, a `modalOverlay` sheet closing on its backdrop): the spotlight's people only, a tap toggling them, chips, Start through `AppModel.startGroup` (`ChatSession.openGroupDm` in rv-ffi, `groupDmMax()`).

This is the only place the apps call `spotlight`; `@` mention completion deliberately uses local recent authors instead ([composer](composer.md#mentions-and-emoji)).

## Messages in a room (`chat.search`)

`GET chat.search?roomId=&searchText=&count=50`, opened from the room header's search button.

- Mobile: `app/message-search.tsx`. Results are **ephemeral**: normalised with `toMessage` like any server document, rendered with the regular `MessageRow`, and never written to SQLite (isolated old messages have no place in the local window). They are read-only: no long press (the action sheet reads the database by id, and an old result may not be there), no reaction toggling, each with its own header. A tap goes back to the room at the message (`ui/messageJump.ts`; a context window when it is older than the local history, see [room-view.md](room-view.md)), or opens the thread of a reply that lives there.
- GTK: a dialog (`details::search` in `rv-gtk/src/details.rs`) listing author, date and the rendered body. A click closes it and **goes to the message**: a thread reply opens its thread, anything else is revealed in the room, in the history around it when it is older than what is loaded, whatever its age (`Chat::jump_to`, the context window of [room-view.md](room-view.md)). A toast says so only when the server cannot give the message back.
- SwiftUI: `SearchView` in `Details.swift`, the same list; a tap jumps through `RoomModel.jump(to:)`, which opens the history around an old message as GTK does. It does not special-case thread replies.

## Messages across rooms (mobile, on the device)

A search button in the room list's header opens `app/search-messages.tsx`. `ui/localSearch.ts` holds the session's search, mounted by `ui/sync.tsx` with the database like the emoji usage store; `createLocalSearch` (`db/store.ts`) runs `SEARCH_MESSAGES` (`db/upserts.ts`): `text LIKE ? ESCAPE` with `searchPattern` escaping `%`, `_` and the backslash, ordinary messages and decrypted `e2e` ones (a locked one has no text), newest first, 60 at most, ids only; the screen then reads the rows and their rooms through drizzle. `LIKE` ignores ASCII case only (accents count). It covers what the device holds, whatever the server kind: the last 500 messages per room on mobile, plus history already opened; the screen says so. A tap opens the room at the message (`requestJump` before the push), or the thread of a reply not shown in the room. Private Vibez conversations keep their own on-device search, per room (`CryptoConversationAccess.search`).

## Messages across rooms (desktop, on the device)

`Store::search_messages` (`rv-core/src/store.rs`) reads the stored messages with `LIKE ? ESCAPE '\'` (`%`, `_` and `\` escaped), newest first, 60 at most, over what the store keeps (each room's 500 newest after retention, plus history opened since). The desktop never stores decrypted text (only my own messages still in the outbox), so `Session::search_local` also reads `Store::sealed_messages` and decrypts them while the room keys are unlocked. Rocket.Chat, Mattermost and kChat; not on a native Vibez session.

- GTK: a search button in the sidebar header, or Ctrl+Shift+F (`chat.rs`), opens `rv-gtk/src/local_search.rs`: the hits under their room's name; a click opens the room at the message, or the thread for a reply.
- SwiftUI: `LocalSearchSheet` (`macos/Sources/RocketVibe/LocalSearch.swift`), from a sidebar button, Cmd+Shift+F.

## Messages across rooms (web, in the browser)

Ctrl+Shift+F opens `localSearch` (`apps/web/src/panels.ts`). The native-provider header follows GTK's hidden sidebar-search button. The dialog has an entry, a line explaining that it covers messages already in this browser and that encrypted conversations are searched inside each one, then compact activatable previews as you type (300 ms pause, Enter at once). `searchLocal` (`apps/web/src/local-search.ts`) reads the in-memory model (`Model.messages`, persisted as the `cache` snapshot): the server snapshot's 50 newest roots and 50 newest replies per room, history and live messages since, at most 500 per room after retention. Substring match ignores letter case with `toLocaleLowerCase`, accents counted; deleted/system messages, withdrawn rooms and encrypted rooms are excluded; newest first, 60 at most. Choosing a preview closes the dialog and calls `App.jumpTo`, opening the surrounding room or the thread for a reply. Encrypted MLS text never enters the model: it lives in the open `PrivateChat` and is searched per room through the crypto worker. Unit tests `tests/local-search.test.ts`, browser test `tests/global-search.mjs`.

## Parity

All apps: spotlight for new conversations, `chat.search` in a room, jumping from a result to the message whatever its age, search across rooms on the device. The joined rooms are filtered by name in the [room switcher](room-switcher.md) (mobile: the room list's filter).

## Sources

- apps/desktop/crates/rv-core/src/store.rs
- apps/desktop/crates/rv-gtk/src/local_search.rs
- apps/desktop/macos/Sources/RocketVibe/LocalSearch.swift
- apps/web/src/local-search.ts
- apps/web/src/panels.ts
- apps/web/src/new-conversation.ts
- apps/web/src/room-state.ts
- apps/web/src/conversation-parity.css
- apps/web/tests/gtk-forms.mjs
- apps/web/tests/shell-parity.mjs
- apps/web/tests/global-search.mjs

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
- apps/desktop/crates/rv-core/src/mattermost/actions.rs
- apps/desktop/crates/rv-core/src/rocketchat/actions.rs
- apps/desktop/macos/Sources/RocketVibe/NewGroup.swift
- apps/mobile/providers/mattermost/actions.ts
- apps/desktop/crates/rv-gtk/src/details.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/macos/Sources/RocketVibe/ChatView.swift
- apps/desktop/macos/Sources/RocketVibe/Details.swift
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
