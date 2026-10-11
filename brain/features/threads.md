# Threads

A thread is a root message plus the replies that carry its id as `tmid`. Both apps open a thread from the root's reply chip or from the "Reply in thread" action, show the root followed by the replies in chronological order, keep it live, and give it a composer of its own whose text messages carry `tmid`. On a Rocket.Chat server they also list a room's threads (all, or the ones I follow) and follow or unfollow a thread.

## The server contract

- A root carries `tcount` (reply count) and `tlm` (last reply time); a reply carries `tmid`, and `tshow: true` when the sender also posted it to the room.
- `chat.getThreadMessages?tmid=` returns the replies but **never the root** (it has no `tmid`), so a thread opened cold from a link would have no root without a separate `chat.getMessage?msgId=<root>`.
- `count: 0` ("everything") depends on the server setting `API_Allow_Infinite_Count`; disabled, it silently falls back to 50 and truncates the thread. Both apps therefore page defensively by full pages of 100, at most 20 pages (2 000 replies), stopping at the first short page.
- The room history is fetched with `showThreadMessages: false`, and the room view shows only messages with no `tmid` or with `tshow`. The local filter must match the server's, or a page made only of hidden replies would make keyset paging loop on the same spot.
- Live replies arrive on the same message streams as the room's messages ([offline and sync](offline-and-sync.md)).
- **List**: `chat.getThreadsList?rid=&count=&offset=[&type=following]` returns the roots, newest last reply first, with `total`. Its `type=unread` filter is not offered: no REST route reads ONE thread (REST `chat.getThreadMessages` leaves `tunread` alone, `subscriptions.read {readThreads: true}` clears the whole room's), so an unread list would never empty.
- **Following**: a root's `replies` is the uids of its followers (the author and every replier are added automatically). `chat.followMessage` / `chat.unfollowMessage {mid}` are idempotent and rebroadcast the root, so the followers stay live through ordinary ingestion. Exact behaviour in `CLAUDE.md`, "Threads: list and follow".
- Mattermost servers offer neither here: the Mattermost provider does not map its threads routes yet (not probed). The RocketVibe server has the list, following and "also send to the room" (below), but only the web client calls them so far: the mobile and desktop RocketVibe providers do not.

## The RocketVibe server

Contract in `docs/protocol/THREADS.md` ("List, following and also send to the room"), code in `apps/server/src/threads.rs`, migration `0058_thread_follows.sql`; three capabilities, `thread_list`, `thread_follow`, `thread_also_in_room`, all `false` on an older server.

- **List**: `GET /api/v1/rooms/{room}/threads?filter=all|following&before=&limit=` answers `ThreadList` of `ThreadEntry {root, last_reply_position, following, unread}` and a `next` cursor. A thread is a live root with at least one live reply, ordered by the position of its latest live reply (the cursor too), so a new reply moves it to the top. `unread` is the replies by others past my thread read position (`thread_read_states`, the same rule as the room counters). Members only; plaintext threads only (an encrypted room's roots are opaque MLS routing).
- **Following**: table `thread_follows (root, room, user, present, revision)`. `PUT /api/v1/messages/{id}/follow` with `SetMark` is shaped and replayed like a star (`message_actions` receipt, `409` on another body), a reply's id acting on its root. A reply makes its author follow again and, at the first reply, the root's author unless they already chose (`take_part`, from `store::send_in_tx`, so file and scheduled replies count); an explicit unfollow stays a row, so others' replies do not undo it. Each change journals a private `message_upsert` of the root for that account, carrying `personal_follow {present, revision}`; `marks::personalize` adds it to every account-scoped read, so the list, the thread page, history and snapshots agree.
- **Also send to the room**: `SendMessage.also_in_room` (replies only) is stored in `messages.also_in_room` and comes back as `Message.also_in_room`; the reply keeps its `reply_to`. Room history returns it among the roots only with `?also_in_room=true`, so an older client's keyset paging never lands on rows it filters out. The flag joins the send fingerprint only when set.

## Web

Over the RocketVibe server only, each part shown when its capability is announced (`apps/web/src`).

- **Thread list**: a speech-bubble button (`threads`, the same `chat-message-new` symbol as the desktop) in the room header, hidden in an encrypted room, opens `panels.ts` `threads`: a dialog (closes on its backdrop) with All / Following tabs, rows of the root (`messageRow`), "N replies · last <time>", the unread count, Follow / Unfollow and Open thread; the next page loads as the list scrolls to its end (and at once while it does not fill the dialog).
- **Following**: `App.followThread` sends the `PUT`, puts the returned root in the model and refreshes; `App.following` reads the newest `personal_follow` of the model's copy or the row's. `Model.put` (`store.ts`) merges `personal_follow` by its own revision like `personal_star`. The open thread's header has a bell (`ui/thread.tsx` `FollowButton`, `aria-pressed`); it and the list rows repaint on `rv-model-update` (fired by `App.refresh` after each sync frame), so a follow from another session shows live.
- **Also send to the room**: a checkbox above the thread composer, cleared after each send; `App.send(text, root, alsoInRoom)` puts `also_in_room` in the outbox payload, so a replay keeps it. Room history asks for `also_in_room=true` (`App.shownReplies`); `Model.timeline(room)` shows such replies among the roots, but only within the loaded window of roots, so an older one put there by an opened thread cannot make history paging skip. The row carries a "Replied in a thread" chip that opens the thread, and the room's read position skips it (it is read with its thread). Files sent from the thread composer do not carry the flag.
- Browser test `tests/threads.mjs` (two accounts): order, Following empty then set by replying, Unfollow from a row, a follow made over the API showing live in the open thread, the also-in-room reply in the room and in `?also_in_room=true` history only. Unit tests in `tests/model.test.ts`.

## Storage

Replies are ordinary message rows with a thread column (mobile `messages.thread_id`, `thread_count` = `tcount`, `thread_last` = `tlm`, `thread_shown` = `tshow`, `thread_followers` = `replies` as a JSON array of uids like `starred`, in `db/schema.ts`; desktop `thread_id`, `thread_count`, `thread_last`, `thread_shown`, `thread_followers` (comma-separated uids, like `starred`) in `rv-core/src/store.rs`). Desktop reads a thread with `Store::thread_messages` (the root or anything whose `thread_id` is the root).

## Mobile

- Route `app/thread/[id].tsx`, `id` being the root's `_id`. It projects SQLite through live queries: the root, the replies ordered by timestamp then id (the id breaks millisecond ties deterministically), day separators and author grouping in oldest-first order.
- The `rid` comes from the root or, failing that, from any reply: opened by a link before the root is local, the screen can still subscribe and answer.
- **Loading**: `provider.loadThread` (`providers/rocketchat/history.ts`) fetches the root, then the pages of replies, and ingests them through the same idempotent upserts as everything else. `ui/loadedThreads.ts` remembers which threads were loaded under which **connection generation**: without that guard, every reconnection (each return to the foreground, each network flap) replayed `chat.getMessage` plus the whole pagination, 4 REST calls for a 300-reply thread on a route limited to 10 per minute. It is marked only on success, so a thread opened offline loads at the next connection, and a session-token check rejects a late success from a previous session. (The header comment of `app/thread/[id].tsx` still says the thread loads in one `count=0` pass without pagination; the loader pages as described above.)
- **Live**: the screen subscribes to everything the provider declares for the room (`roomSubscriptions`: messages, deletions, typing), refcounted, so a thread stacked on its room costs no extra `sub` and a thread opened by link still lives.
- **Composer**: the shared composer with `threadId`, placeholder "Reply...", draft key `rid:tmid`, mention candidates from the whole room. Attachments and voice messages go into the thread: the composer passes `threadId` to `FileOutbox.send` (the Rocket.Chat queue's `tmid`, the native intent's `reply_to`, or the encrypted thread's private view), and `ui/uploadBands.tsx` shows the thread's own queued files with Retry. A reply target armed from this thread's action sheet is keyed `rid:threadId` so it stays with this composer. After a send, the list scrolls to the end when the optimistic message actually appears in the data (no timer; the write-to-render chain has no upper bound).
- A root's chip in the room shows a speech-bubble icon, "N replies · time of last" (`ui/messageRow.tsx`); inside the thread the root shows no chip. "Reply in thread" on a reply opens its root (`threadId ?? id`). In the pinned and starred lists, a reply not shown in the room opens its thread rather than jumping in the room.
- Failed sends show retry and discard on their row, as in the room; reactions toggle on tap.
- **Also send to the room** (Rocket.Chat, `Capabilities.alsoInRoom`): a checkbox above the thread composer, for one reply. `Outbox.send(..., alsoInRoom)` shows the optimistic reply in the room at once (`threadShown`), keeps it in the row (`outbox.shown`, migration `0028`) for a replay, and sends `tshow: true` with `tmid` (probed on 8.5.1: echoed).
- **Thread list**: a speech-bubble button (`chat-message-new`, the desktop's) in `RoomHeader` (only when the provider has `listThreads`, Rocket.Chat, and not in a protected room) opens `app/threads.tsx`: two tabs, All and Following, each loaded on first opening, a page of 50 at a time on scroll (`ProviderActions.listThreads`, `providers/rocketchat/actions.ts`). Rendered from the provider like the pinned and starred lists, not ingested; a row opens its thread, a page that brings nothing new ends the list.
- **Following**: `ui/threadFollow.tsx`. `useThreadFollow` reads "I follow" from the root's `threadFollowers` and my uid (`followedBy`, `lib/marks.ts`); a gesture shows its outcome at once, calls `ProviderActions.followThread`, then writes the column (`Store.updateThreadFollowers`) until the rebroadcast root confirms it; a refusal restores the state and says so. Its bell sits in the thread screen's native header (once the root is local) and on each row of the list; a follow changed there reloads the other tab.

## Desktop (GTK)

- `ThreadPage` (`rv-gtk/src/thread.rs`) is pushed onto the room's navigation view, a message list over `Store::thread_messages` with its own composer (hidden in a read-only room, unless my roles grant `post-readonly` on Rocket.Chat, see [composer](composer.md); SwiftUI's `ThreadView` follows the same rule). Opening the thread already open does nothing.
- `Session::load_thread` fetches the root and the pages exactly as mobile does; replies arrive live through the store.
- The composer is bound with the root (`Composer::bind(rid, Some(root))`): draft key `rid:tmid`, commands and replies sent with `tmid` through `send_or_run`, Up edits my last message in the thread, a slash command's private answer for this room shows in the thread's composer. Its attach, drop, paste and microphone go through `ChatPage::wire_thread_files`: files and voice messages answer the thread (`Session::attach_in`, `NativeSession::attach_file_in`, or the thread's private `Access` in an encrypted room); the room's upload strip shows them.
- The root's chip in the room opens the thread (`RowEvent::OpenThread`); a search hit that is a reply opens its thread (`details::search`).
- **Thread list**: a room-header button, shown when `Session::threads_available` (not Mattermost or kChat) and hidden on native rooms, opens `src/threads.rs`, an `adw::Dialog` presented with `widgets::present` (closes on its backdrop). Tabs All and Following, pages of 50 by "Load more" or at the bottom of the scroll while `offset < total`, empty and error states with Retry. A row shows author, date, a plain-text preview of the root, "N replies · last <time>" and a bell; a click closes the dialog and opens the thread. `Session::threads` (`actions::threads`) stores the roots as they come, like `Session::marked`, and returns the stored rows.
- **Following**: `Session::follow_thread` calls `actions::follow_thread`, then `Writer::set_thread_follower` changes the row at once without touching `updated_at`, so the root the server rebroadcasts (with a newer `_updatedAt`) always replaces the guess. `ThreadPage` carries a header bell read from the root's followers in `reload()` (`ChatPage::wire_thread_follow`), hidden for native and Mattermost threads; a follow changed in one tab of the list reloads the other. Smoke step `RV_SMOKE_DETAILS=threads`.

- **Also send to the room** (Rocket.Chat, `Session::also_in_room_available`): a check button above the thread composer for one reply, unchecked after each send; `Session::send_reply` queues it with `shown`, the outbox row keeps it (`outbox.shown`, a migration) so a resend still carries `tshow: true` with `tmid`, and the optimistic row shows in the room at once.

## Desktop (SwiftUI)

- "Also send to the room": a `ThreadView` toggle over `RoomModel.alsoInRoom`, the same path.

`ThreadView` shows a `RoomModel` built with `threadId` beside the room (`AppModel.openThread`, `closeThread`), with its own `Composer`. Text and commands carry the thread id. Its file and voice buttons send into the thread: `RoomModel.attach` passes `threadId` to `Chat.attach` / `NativeFiles.attach` (`thread`), an encrypted thread's private handle writes into its thread, and `UploadsView` shows the thread's own queued files (`Upload.thread`).

Thread list and following go through rv-ffi's `Chat` (`threads_available`, `threads` returning `ThreadsPage` of `ThreadEntry {root, last_reply, following}`, `follow_thread`, `thread_following`, `rv-ffi/src/people.rs`) and `RoomModel` (`supportsThreads`, `followingThread`, `threads(following:offset:)`, `followThread`). A toolbar button shown on Rocket.Chat only opens `Panel.threads` → `ThreadsView` (`Details.swift`) in the modal overlay: segmented All / Following, `MessageRow` plus a summary line and a bell, Load more; `ThreadView` has the same bell. The views are checked by the macOS CI build only.

## Parity

Thread view, live replies and thread composer in all four. Thread list, following and "also send to the room": see [parity](../parity.md), section 6; the native apps on Rocket.Chat servers, the web on the RocketVibe server. Mobile, GTK and SwiftUI still owe them on RocketVibe accounts, whose server now has the routes. Not available anywhere: an unread-threads list. Files and voice messages in a thread: all three send them into the thread, encrypted RocketVibe threads included (files only there).

## Sources

- apps/mobile/app/thread/[id].tsx
- apps/mobile/providers/rocketchat/history.ts
- apps/mobile/providers/rocketchat/index.ts
- apps/mobile/ui/loadedThreads.ts
- apps/mobile/app/threads.tsx
- apps/mobile/ui/threadFollow.tsx
- apps/mobile/lib/marks.ts
- apps/mobile/ui/roomHeader.tsx
- apps/mobile/providers/rocketchat/actions.ts
- apps/mobile/ui/composer.tsx
- apps/mobile/ui/messageRow.tsx
- apps/mobile/lib/outbox.ts
- apps/mobile/lib/normalize.ts
- apps/mobile/db/schema.ts
- apps/mobile/app/room/[rid].tsx
- apps/mobile/app/marked-messages.tsx
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/store.rs
- apps/desktop/crates/rv-core/src/sync.rs
- apps/desktop/crates/rv-core/src/outbox.rs
- apps/desktop/crates/rv-gtk/src/thread.rs
- apps/desktop/crates/rv-gtk/src/threads.rs
- apps/desktop/crates/rv-core/src/actions.rs
- apps/desktop/crates/rv-core/src/normalize.rs
- apps/desktop/crates/rv-ffi/src/people.rs
- apps/desktop/macos/Sources/RocketVibe/Details.swift
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/composer.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/macos/Sources/RocketVibe/ThreadView.swift
- apps/desktop/macos/Sources/RocketVibeKit/AppModel.swift
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
- docs/protocol/THREADS.md
- apps/server/src/threads.rs
- apps/server/src/store.rs
- apps/server/src/marks.rs
- apps/server/src/http.rs
- apps/server/migrations/0058_thread_follows.sql
- crates/rv-protocol/src/lib.rs
- apps/web/src/panels.ts
- apps/web/src/ui/thread.tsx
- apps/web/src/ui/application.tsx
- apps/web/src/store.ts
- apps/web/src/app.ts
- apps/web/tests/threads.mjs
