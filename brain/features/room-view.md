# Room view

The screen of one room: its history read from the local database and paged back from the server, live messages, edits and deletions, author grouping, day separators, a "new messages" bar at the first unread, markdown bodies, translated system messages, quotes, files, link and video cards, reactions and thread chips. Both apps render the same server data with the same rules; each draws it with its own toolkit.

## Shared behaviour

- **Source of the list.** The newest page (50 messages) of `channels.history` / `groups.history` / `im.history` is written to SQLite on opening; the screen shows what the database holds, so a cached room opens instantly and offline. Older pages are requested with `latest=<oldest local timestamp>` (keyset, never an offset). With `inclusive`, the boundary message comes back, so "the page holds one row" means the past is exhausted. The local history is the stretch that runs unbroken from the present back to the oldest page loaded: desktop sizes its window to exactly that (`Store::count_since`), so an older message stored on its own (starred, edited live) never shows above a hole.
- **Live.** New messages and edits for every room arrive on one subscription, `stream-room-messages` / `__my_messages__`. Deletions do not: they need `stream-notify-room/<rid>/deleteMessage`, one subscription per room, and edits and deletions missed while away are caught up with `chat.syncMessages` (`UPDATED` and `DELETED` are two calls). The typing indicator listens to `stream-notify-room/<rid>/user-activity` (not the deprecated `/typing`); each typist expires after 15 s because a "stopped" event from someone who lost the network never comes. Neither app **emits** typing: that would need a DDP method call, which the project's DDP clients do not make. Details in [offline-and-sync.md](offline-and-sync.md) and [rocket-chat.md](../architecture/rocket-chat.md).
- **Thread replies** stay out of the main flow unless sent with "also in the room" (`tshow`); see [threads.md](threads.md).
- **Grouping.** A message continues the one above (no avatar, no name) unless the author differs, more than **5 minutes** separate them, either is a system message (`e2e` excepted: it is someone's words), or a day boundary sits between them. A continuation shows its time in the avatar gutter only when the minute changed.
- **Day separators** ("Today", "Yesterday", a date) sit between two messages of different local days, never above the oldest loaded one (the next page may continue that day).
- **"New messages" bar.** Placed above the first message newer than the subscription's `ls` (last seen) that someone else sent, using a snapshot taken when the room opens: following the live value, the `subscriptions.read` sent right after would erase it before it is seen.
- **Mark as read.** `subscriptions.read` on opening, then again a moment (1.5 s) after new messages while the room is on screen. The route is rate limited (10 calls a minute).
- **Bodies.** The server pre-parses each message into `md`, the `@rocket.chat/message-parser` tree. Old messages (and bots) lack it, so each app parses the text locally into the same node shapes. Blocks: paragraph, heading, quote, code block, bullet, ordered and task lists, line break, big emoji. Inlines: bold, italic, strike, inline code, links, user and channel mentions, emoji. Unknown node types render their text rather than vanish. Only web links open (mobile http(s); desktop http(s) and `mailto:`): a forged `md` must not launch an arbitrary intent or scheme. A quote's permalink link (`[ ](...?msg=...)`) is dropped from the body, since the quoted message renders as a card. Emoji resolution is in [emoji.md](emoji.md).
- **System messages** (`t` set): `msg` carries the action's parameter (a username, a new topic), not a sentence; the author is `u`. A table maps types to translated sentences (`uj`, `ul`, `au`, `ru`, `r`, topic, announcement, description with their "removed" variants, pinned and unpinned including the `_e2e` variants, read-only, archived, muted, role added or removed, reactions allowed, `message-deleted-notification`...). An unknown type falls back to a generic sentence. A `videoconf` message becomes a call card with a Join button ([calls.md](calls.md)).
- **Attachments.** Images, audio, video and other files ([media-playback.md](media-playback.md), [uploads.md](uploads.md)); quotes as cards, nested up to 2 levels (the server's default `Message_QuoteChainLimit`); link previews from the server's `urls[]` metadata (OpenGraph, oEmbed, Twitter cards), at most 3 per message, deduplicated, and never a client-side fetch of the page; YouTube, Dailymotion and Vimeo links as video cards, excluded from the generic previews so a message never shows two cards.
- **Around each message.** Edited marker, sending and failed states with retry (the outbox, [offline-and-sync.md](offline-and-sync.md)), reactions ([message-actions.md](message-actions.md)), a thread chip with reply count and last reply time, and the author's avatar and name opening their profile ([room-info-and-profiles.md](room-info-and-profiles.md)).
- **Header.** Room tile and name, the DM partner's presence, room info, search in the room ([search.md](search.md)) and a call button when the server has a video-conference provider. A read-only room (`ro`) shows a note instead of the composer.

## Mobile

- **Screen.** `app/room/[rid].tsx` (`RoomScreen`, then `Room`). A `FlashList` with `inverted`: the query `ORDER BY ts DESC, id DESC LIMIT n` feeds it as is, and `onEndReached` (the visual top) loads the past. The secondary key `id` makes ties at the same millisecond deterministic. `maintainVisibleContentPosition` is disabled (its native correction fought the manual snap); an incoming message scrolls to the bottom only if it is mine or the user is within 120 px of it. The projection is throttled to 200 ms (`ui/smoothedData.ts`) so a burst becomes one shift.
- **Paging** (`loadMore`): first widen the local window by 50 (`setLimit`), then ask the server. `ui/roomPagination.ts` encodes two lessons paid in 429s: only a message strictly older than the boundary proves progress (`pageMovedBack`), and a boundary that did not move after two pages stops paging (`advanceBound`, `boundIsStuck`). `passExhausted` (past exhausted) latches, since FlashList v2 re-fires `onEndReached` on every data change.
- **Opening.** The room's streams are subscribed from the provider's `roomSubscriptions`; on leaving they are handed to `ui/hotRooms.ts` instead of released, so a recently left room stays live. `catchUpRoom` runs on opening unless the room stayed covered; the 50-message history reloads only once per connection generation (`ui/loadedRooms.ts`).
- **Projections**, all pure and tested: `ui/unreadBar.ts` (`insertUnreadBar`; data is newest-first and the list inverted, so the oldest unread is the last match), `ui/daySeparator.ts`, `ui/messageGrouping.ts` (`continuationIds`, `repeatedTimeIds`).
- **Mark as read.** Debounce 1.5 s plus a 10 s floor (`READ_FLOOR_MS`): a pending call absorbs later arrivals instead of being re-armed, and is flushed at once when the screen closes or the app goes to background.
- **Jumps.** From pinned or starred lists (`ui/messageJump.ts`): `ui/bringMessage.ts` brings the message into the local window, paging back from the oldest local message (at most 4 pages, never an isolated page around the target, which would leave a hidden gap), then the list scrolls to it and highlights it. `ui/backToLatest.ts` shows a "latest messages" button once scrolled more than a screen away.
- **Row.** `ui/messageRow.tsx` (`MessageRow`, shared with the thread screen). `MessageContent` picks markdown (`messageTree` in `lib/markdown.ts`, which falls back to `parse()` from `@rocket.chat/message-parser`), a substitute for locked encrypted or empty messages, a system sentence (`systemText`, `lib/systemMessages.ts`, sentences in `ui/messages.ts` keys `sys.*`) or `CallCard`. `ui/markdown.tsx` renders the tree to nested native `<Text>` (no WebView, no markdown library, per [decisions.md](../decisions.md)); `RenderGuard` is an error boundary per message, keyed on its content so an edit that fixes a malformed `md` re-renders. Mentions open the profile (`@all` and `@here` do not). `Quote` draws `message_link` attachments. `ui/linkCard.tsx` (`lib/linkPreview.ts`) and `ui/embedCard.tsx` (`lib/videoLinks.ts`) draw the cards. `ui/roomHeader.tsx` is the header.

## Desktop

- **Core.** `rv-core/src/timeline.rs` (`group`, `mark_new`, `is_system`) lays the rows out for every UI. `rv-core/src/markdown.rs` (`render`) turns `md`, or the text parsed by `rv-core/src/parse.rs` (a local reader producing message-parser's node shapes), into `Block`s of Pango markup; my own mentions and `@all`/`@here` get a highlight, user mentions link to `rv-user:` and channels to `rv-room:`. `rv-core/src/content.rs` extracts quotes (`QUOTE_DEPTH`), files, card attachments, link previews and video links. System sentences come from `rv-core/src/i18n.rs` (`system_message`).
- **Opening.** `Session::open_room` (`rv-core/src/session.rs`) moves the per-room subscriptions (`deleteMessage`, `user-activity`) from the previous room to this one, so only the open room hears deletions and typing; sends `subscriptions.read`; loads the newest page; and runs `catch_up_room` once per session per room (`synced`).
- **GTK.** `rv-gtk/src/chat.rs` (`open_room`, `older_page`, `schedule_read`, `jump_to`) and `rv-gtk/src/message_list.rs` (`MessageList`, a `gtk::ListView`, newest at the bottom, rows applied as splices that keep the scroll position). Mark-as-read fires 1.5 s after a change only if the window is active, the room visible and the list pinned to the bottom; returning to the window marks what arrived meanwhile. `reveal` scrolls to a message (a notification via `open_message`) once loaded. `jump_to` (pinned, starred, a search result) reveals a loaded message; one that is not, however old, opens a **context window** (`rv-core/src/context.rs`, `Window`): the page up to the message from `chat.getMessage` and `history?latest=`, then what follows it, held in memory and never stored. The list is then **detached** (`MessageList::set_detached`): never pinned, the button back to the latest always shown. Scrolling up pages older; scrolling down reads forward, and since `history?oldest=` answers the newest page of a range, `Window::newer` sizes `[from, to]` from the window's pace, halves a range that comes back full, doubles a sparse one, tries the whole rest after an empty step, and reads a range still full at one second backwards page by page, so the window never holds a hole. A window row the store also holds is shown in its stored version, which live events keep current. When the window reaches the oldest local message (or the present), it is written to the store and the list becomes the live one again (`merge_context`); the latest button, or sending a message, leaves it instead. A jump-to-latest button floats over the list. Selection can run across texts and messages in reading order (`selection_text`). `rv-gtk/src/rows.rs` (`message_widget`) builds rows, `markdown_view.rs` the text widgets (hovering an emoji or a mention shows a card), `cards.rs` the quotes, files, previews, video and call cards.
- **SwiftUI.** `RoomModel` (`macos/Sources/RocketVibeKit/RoomModel.swift`) loads, pages (`loadOlder`) and jumps (`jump(to:)`) over `rv-ffi`, which applies `timeline::group` and `mark_new`; `RoomView.swift` and `BodyView.swift` draw a `LazyVStack` with an `AttributedString` built from rv-core's blocks.

## Parity

[Parity](../parity.md) §3 is implemented on both sides. Differences that show: desktop highlights mentions of me, mobile colours every mention the same; desktop allows `mailto:` links; desktop listens to deletions and typing for the open room only, mobile keeps recently left rooms hot; mobile throttles mark-as-read with a 10 s floor, desktop requires the window to be focused and scrolled to the bottom; YouTube-style cards play inside the card on desktop and open the app or browser on mobile ([media-playback.md](media-playback.md)).

## Sources

- apps/mobile/app/room/[rid].tsx
- apps/mobile/ui/messageRow.tsx
- apps/mobile/ui/markdown.tsx
- apps/mobile/ui/roomHeader.tsx
- apps/mobile/ui/messageGrouping.ts
- apps/mobile/ui/daySeparator.ts
- apps/mobile/ui/unreadBar.ts
- apps/mobile/ui/roomPagination.ts
- apps/mobile/ui/smoothedData.ts
- apps/mobile/ui/messageJump.ts
- apps/mobile/ui/bringMessage.ts
- apps/mobile/ui/backToLatest.ts
- apps/mobile/ui/hotRooms.ts
- apps/mobile/ui/loadedRooms.ts
- apps/mobile/ui/linkCard.tsx
- apps/mobile/ui/embedCard.tsx
- apps/mobile/lib/markdown.ts
- apps/mobile/lib/systemMessages.ts
- apps/mobile/lib/linkPreview.ts
- apps/mobile/lib/videoLinks.ts
- apps/mobile/lib/typing.ts
- apps/mobile/lib/quote.ts
- apps/mobile/providers/rocketchat/history.ts
- apps/desktop/crates/rv-core/src/context.rs
- apps/desktop/crates/rv-core/src/timeline.rs
- apps/desktop/crates/rv-core/src/markdown.rs
- apps/desktop/crates/rv-core/src/parse.rs
- apps/desktop/crates/rv-core/src/content.rs
- apps/desktop/crates/rv-core/src/i18n.rs
- apps/desktop/crates/rv-core/src/live.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/sync.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/message_list.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-gtk/src/markdown_view.rs
- apps/desktop/crates/rv-gtk/src/cards.rs
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
- apps/desktop/macos/Sources/RocketVibe/BodyView.swift
