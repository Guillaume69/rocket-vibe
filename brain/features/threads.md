# Threads

A thread is a root message plus the replies that carry its id as `tmid`. Both apps open a thread from the root's reply chip or from the "Reply in thread" action, show the root followed by the replies in chronological order, keep it live, and give it a composer of its own whose text messages carry `tmid`. There is no list of a room's threads in either app.

## The server contract

- A root carries `tcount` (reply count) and `tlm` (last reply time); a reply carries `tmid`, and `tshow: true` when the sender also posted it to the room.
- `chat.getThreadMessages?tmid=` returns the replies but **never the root** (it has no `tmid`), so a thread opened cold from a link would have no root without a separate `chat.getMessage?msgId=<root>`.
- `count: 0` ("everything") depends on the server setting `API_Allow_Infinite_Count`; disabled, it silently falls back to 50 and truncates the thread. Both apps therefore page defensively by full pages of 100, at most 20 pages (2 000 replies), stopping at the first short page.
- The room history is fetched with `showThreadMessages: false`, and the room view shows only messages with no `tmid` or with `tshow`. The local filter must match the server's, or a page made only of hidden replies would make keyset paging loop on the same spot.
- Live replies arrive on the same message streams as the room's messages ([offline and sync](offline-and-sync.md)).

## Storage

Replies are ordinary message rows with a thread column (mobile `messages.fil_id`, `fil_reponses` = `tcount`, `fil_dernier` = `tlm`, `fil_affiche` = `tshow`, in `db/schema.ts`; desktop `thread_id`, `thread_count`, `thread_last`, `thread_shown` in `rv-core/src/store.rs`). Desktop reads a thread with `Store::thread_messages` (the root or anything whose `thread_id` is the root).

## Mobile

- Route `app/fil/[id].tsx`, `id` being the root's `_id`. It projects SQLite through live queries: the root, the replies ordered by timestamp then id (the id breaks millisecond ties deterministically), day separators and author grouping in oldest-first order.
- The `rid` comes from the root or, failing that, from any reply: opened by a link before the root is local, the screen can still subscribe and answer.
- **Loading**: `fournisseur.chargerFil` (`fournisseurs/rocketchat/historique.ts`) fetches the root, then the pages of replies, and ingests them through the same idempotent upserts as everything else. `ui/filsCharges.ts` remembers which threads were loaded under which **connection generation**: without that guard, every reconnection (each return to the foreground, each network flap) replayed `chat.getMessage` plus the whole pagination, 4 REST calls for a 300-reply thread on a route limited to 10 per minute. It is marked only on success, so a thread opened offline loads at the next connection, and a session-token check rejects a late success from a previous session. (The header comment of `app/fil/[id].tsx` still says the thread loads in one `count=0` pass without pagination; the loader pages as described above.)
- **Live**: the screen subscribes to everything the provider declares for the room (`souscriptionsSalon`: messages, deletions, typing), refcounted, so a thread stacked on its room costs no extra `sub` and a thread opened by link still lives.
- **Composer**: the shared composer with `filId`, placeholder "Reply...", draft key `rid:tmid`, mention candidates from the whole room. `fichiers={null}`: no 📎 and no 🎤, because the upload queue cannot target a thread. A reply target armed from this thread's action sheet is keyed `rid:filId` so it stays with this composer. After a send, the list scrolls to the end when the optimistic message actually appears in the data (no timer; the write-to-render chain has no upper bound).
- A root's chip in the room shows "💬 N replies · time of last" (`ui/ligneMessage.tsx`); inside the thread the root shows no chip. "Reply in thread" on a reply opens its root (`filId ?? id`). In the pinned and starred lists, a reply not shown in the room opens its thread rather than jumping in the room.
- Failed sends show retry and discard on their row, as in the room; reactions toggle on tap.

## Desktop (GTK)

- `ThreadPage` (`rv-gtk/src/thread.rs`) is pushed onto the room's navigation view, a message list over `Store::thread_messages` with its own composer (hidden in a read-only room). Opening the thread already open does nothing.
- `Session::load_thread` fetches the root and the pages exactly as mobile does; replies arrive live through the store.
- The composer is bound with the root (`Composer::bind(rid, Some(root))`): draft key `rid:tmid`, commands and replies sent with `tmid` through `send_or_run`, Up edits my last message in the thread, a slash command's private answer for this room shows in the thread's composer. The page's composer still shows the attach and microphone buttons, but only the room composer's file and voice handlers are connected, so they do nothing here.
- The root's chip in the room opens the thread (`RowEvent::OpenThread`); a search hit that is a reply opens its thread (`details::search`).

## Desktop (SwiftUI)

`ThreadView` shows a `RoomModel` built with `threadId` beside the room (`AppModel.openThread`, `closeThread`), with its own `Composer`. Text and commands carry the thread id. Its file and voice buttons work but `RoomModel.attach` takes no thread id, so those files land in the room itself.

## Parity

Thread view, live replies and thread composer in all three. Not available anywhere: a list of the room's threads, following a thread, "also send to the room" (`tshow`) on send, attachments in a thread. On attachments the three differ: mobile hides the attach and microphone buttons in the thread composer; the GTK thread composer shows both but nothing is wired to them, so a picked file is dropped and a recording deleted (`open_thread` in `rv-gtk/src/chat.rs`); SwiftUI posts them to the room, since `RoomModel.attach` takes no thread id.

## Sources

- apps/mobile/app/fil/[id].tsx
- apps/mobile/fournisseurs/rocketchat/historique.ts
- apps/mobile/fournisseurs/rocketchat/index.ts
- apps/mobile/ui/filsCharges.ts
- apps/mobile/ui/composer.tsx
- apps/mobile/ui/ligneMessage.tsx
- apps/mobile/lib/envoi.ts
- apps/mobile/lib/normaliser.ts
- apps/mobile/db/schema.ts
- apps/mobile/app/salon/[rid].tsx
- apps/mobile/app/messages-marques.tsx
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/store.rs
- apps/desktop/crates/rv-core/src/sync.rs
- apps/desktop/crates/rv-core/src/outbox.rs
- apps/desktop/crates/rv-gtk/src/thread.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/composer.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/macos/Sources/RocketVibe/ThreadView.swift
- apps/desktop/macos/Sources/RocketVibeKit/AppModel.swift
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
- apps/desktop/docs/PARITY.md
