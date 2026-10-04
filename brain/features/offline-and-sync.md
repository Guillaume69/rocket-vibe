# Offline and sync

Both apps are local-first: the screens read a SQLite database per (server, account), and the network only ever writes into it. The WebSocket and REST both feed the same idempotent upserts, arbitrated by the server's `_updatedAt`; a cheap global catch-up covers every room in two requests, a per-room catch-up covers the open room, and an outbox makes sends survive crashes and outages.

Transport mechanics (sockets, backoff, liveness) are in [../architecture/mobile-transport.md](../architecture/mobile-transport.md) and [../architecture/desktop-core.md](../architecture/desktop-core.md); the server facts behind every choice here are in [../architecture/rocket-chat.md](../architecture/rocket-chat.md).

## Principles shared by both apps

- **The UI observes the store.** Nothing on screen waits for the network: the cache shows at once, offline included, and fresh data appears as rows change.
- **One write path, idempotent.** A stream event and a REST page that carry the same document produce the same upsert. Each upsert only applies if the incoming `_updatedAt` is at least the stored one, so a slow REST read never regresses a fresher stream event. An optimistic row carries `updated_at = 0`, so any server version overwrites it and it never overwrites a real one.
- **Cursors are server time.** Every catch-up cursor is the largest `_updatedAt` (or `_deletedAt`) actually ingested, never the local clock, and the SQL refuses to move a cursor backwards.
- **Two reads per connection.** One REST read starts immediately (what the user sees); a second one starts once the server has armed the DDP subscriptions (what guarantees no gap between the transports). Both apps wait for that signal, never for a delay.
- **Respect the rate limit.** `chat.syncMessages` handles one room per call and REST allows about 10 calls a minute, so neither app loops over all rooms.

## The layers of catch-up

| Layer | What it covers | Requests | When |
|---|---|---|---|
| Global | every room and subscription (names, previews, unread counts), plus departures via `remove[]` | `rooms.get?updatedSince=` and `subscriptions.get?updatedSince=` in parallel (no `updatedSince` the first time: full load) | each connection |
| History | the latest 50 messages of a room; also where that room's cursor is born | `channels.history` / `groups.history` / `im.history`, `inclusive=true` | opening a room, paging back |
| Per room | edits and deletions since the room's cursor, which history cannot see (a deleted message is simply absent from a page) | `chat.syncMessages` cursor mode: `type=UPDATED` then `type=DELETED`, 50 per page, 2 pages per type per pass | open room, conditions below |
| Reconciliation | rooms deleted or left while nothing listened | full `subscriptions.get`, purge what is absent | once per session |

A room with no cursor yet has nothing to catch up: its first history page creates the cursor, and from then on cursor pagination resumes where it stopped. A pass that hits the 2-page cap leaves the cursor at the server's `next` and resumes next time. When the last page returns `cursor.next = null` (the normal case, even on a full page), the cursor advances to the largest timestamp ingested; without that it froze and every open re-downloaded a growing slice. The first time the deleted-messages timeline is read, its cursor is set to the messages cursor instead of replaying all deletions since the beginning.

Reconciliation ignores an empty list (an active account always has subscriptions; empty means an abnormal answer) and deletes the room with everything attached: messages, subscription, pending sends and uploads, cursors, and on mobile its drafts too.

## Mobile

**Engine.** `MoteurSynchro` (sync engine, `apps/mobile/lib/sync.ts`) writes neutral rows through a `Depot` interface; the Rocket.Chat specifics (stream payload shapes, `removed` actions that carry only a subscription `_id`) live in `TraducteurRC` (`apps/mobile/providers/rocketchat/translator.ts`). REST batches are ingested in one transaction, so a page of 50 messages is one commit and one change notification for the live queries. E2EE messages are decrypted during ingestion when the room key is available, otherwise kept as `chiffre_brut` for a pass at unlock (see [../architecture/e2ee.md](../architecture/e2ee.md)). Schema, upserts and the write queue are in [../architecture/mobile-data.md](../architecture/mobile-data.md).

**Write queue.** `expo-sqlite` transactions are per connection and not re-entrant, so every writer on one connection shares a single `FileEcritures` (write queue, `apps/mobile/db/writeQueue.ts`) created by `ouvrirBase`. Two interleaved batches used to die with "cannot rollback - no transaction is active".

**Connection sequence** (`apps/mobile/ui/sync.tsx`, `rattraperTout`): the global catch-up, then a fire-and-forget `rattraperSalon` (room catch-up) for the room on top of the open-rooms stack (`apps/mobile/ui/openRooms.ts`; a stack because navigation can push two room screens). After the first read: flush the outbox and the upload queue, load presence, and once per session sync custom emoji, register the push token, reconcile rooms and apply retention. Finally `generation` is bumped, which re-runs the open effect of any screen whose initial load failed offline.

**Opening a room** (`apps/mobile/app/salon/[rid].tsx`) does two independent things:

1. Per-room catch-up, **skipped** when `salonCouvert(rid, generation)` says the room stayed subscribed since its last visit.
2. History, **skipped** when `salonChargeSous(rid, generation)` says it was already loaded under this connection generation (`apps/mobile/ui/loadedRooms.ts`). The test is causal, not a timer: any reconnection bumps `generation` and invalidates both caches, because the gap can then be any size.

**Hot rooms** (`apps/mobile/ui/hotRooms.ts`). Mobile subscribes to a room's streams (`stream-room-messages/<rid>`, `deleteMessage`, `user-activity`) only while its screen is mounted. Leaving used to release them, so reopening needed a `chat.syncMessages` that takes 3 s on a big room to report nothing. Instead, the screen hands its release functions to `garderAuChaud` on unmount: the three most recently left rooms stay subscribed (LRU), which costs no extra `sub` since DDP subscriptions are ref-counted. A room evicted from the LRU becomes a room to catch up again. A session token (`apps/mobile/ui/sessionToken.ts`) stops a screen unmounting after logout from repopulating these caches for the next session.

**Serialised room passes** (`rattraperSalon` in `apps/mobile/lib/catchUp.ts`). The connection sequence and the room screen's open effect both request a pass for the same room at each reconnection. One pass at a time per room: a request arriving before the running pass has read its cursor merges into it; one arriving after gets its own pass chained behind (nearly empty, about 92 bytes). That keeps the guaranteeing second read without doubling calls. A merged pass aborts only when every requester has given up.

**Legacy fallback.** If the server rejects cursor mode on the first page (400, or no `cursor` in the answer, i.e. before 7.5), `rattraperParDate` uses `lastUpdate=`, clamped to 24 h, and re-anchors the cursor on the newest local message when the unbounded request times out.

**Outbox** (`MoteurEnvoi`, `apps/mobile/lib/outbox.ts`, table `sortie`). The message `_id` (24 hex characters) is generated client-side; the optimistic row and the outbox row are written before any network call. Passes run in order, one at a time, and a pass requested mid-flush runs right after. Unreachable (`statut 0`): the row stays `en-attente` (pending) for the next trigger. Any other error: `chat.getMessage` decides. Found means delivered (ingest it, drop the row), absent means `echec` (failed, retry offered in the UI), and a network error or 429 means unknown (row stays pending, pass stops). In an encrypted room the text is encrypted only when leaving, and a locked room makes the row wait instead of failing. File sends use a separate queue with the same spirit (`televersements`, `apps/mobile/lib/uploadQueue.ts`); see [uploads.md](uploads.md).

**Retention.** Once per session, after catch-up, `appliquerRetention` keeps the 500 newest messages per room (`MESSAGES_GARDES_PAR_SALON` in `apps/mobile/db/store.ts`), sparing optimistic rows and thread roots still referenced. The app re-downloads anything older when paging back.

**Reconciliation race.** `reconcilierSalons` snapshots the known rids before the request and only purges rooms in that snapshot, so a DM created by the stream during the round trip is not deleted.

**Background.** The socket closes on background and push takes over; on return, the full raccordement runs again. Presence is never persisted and is cleared when the socket drops.

## Desktop

**Store** (`apps/desktop/crates/rv-core/src/store.rs`). One SQLite file per (server, account), WAL mode, one connection behind a mutex. Every write goes through `Store::write`, one transaction that broadcasts a single `Change` (rooms touched, rids touched) after commit; the GTK and SwiftUI views refresh from it. Tables: `rooms`, `subscriptions`, `messages`, `outbox`, `cursors`, plus `drafts` and `uploads` from the append-only migration list. Upserts use the same `updated_at >=` guard and the same `COALESCE` care for fields partial documents omit.

**Engine** (`apps/desktop/crates/rv-core/src/sync.rs`). `SyncEngine::apply_event` routes stream events; `catch_up_global`, `load_history`, `catch_up_room` and `reconcile_rooms` mirror the mobile layers, with the same page sizes and cursor rules.

**Streams.** Unlike mobile, desktop subscribes to `stream-room-messages/__my_messages__` at session start, so new messages and edits of every room land in SQLite without opening it, and the notifier sees them. Deletions and typing are subscribed for the open room only, and moved when the room changes (`Session::open_room` in `apps/desktop/crates/rv-core/src/session.rs`).

**Connection sequence** (`Session::catch_up`): at start, a catch-up runs immediately without waiting for the socket; each `Authenticated` event runs another after `subscriptions_armed()`. A catch-up does the global delta, then (if it succeeded) flushes the outbox and the upload queue, loads presence, runs the once-per-session work (custom emoji, `me` for the notification preference, reconciliation), and for the current room reloads its latest history page and runs `catch_up_room`.

**Opening a room** always loads the latest history page and marks it read; `catch_up_room` runs only if the room is not yet in the session's `synced` set. Because `__my_messages__` keeps edits current for every room, the set replaces mobile's hot-room LRU.

**Reconnection** (`Session::listen`): on `Lost`, wait `1 s << min(attempt, 5)` capped at 30 s plus up to 1 s jitter, then reopen; `Authenticated` resets the attempt count. The connection status button calls `reconnect_now` (`apps/desktop/crates/rv-gtk/src/chat.rs`, `reconnectNow` in the SwiftUI `AppModel`). There is no background suspension: the socket stays open while the app runs.

**Outbox** (`apps/desktop/crates/rv-core/src/outbox.rs`) follows the mobile design: client `_id`, optimistic row at `updated_at = 0`, ordered re-entrant passes, `chat.getMessage` with three verdicts (`Delivered::Yes`, `No`, `Unknown` on network error or 429), encryption at departure. Failed rows return to pending on `retry`. Uploads interrupted mid-send are put back to pending when the queue starts (`rearm_sending_uploads`).

**Session death.** A rejected token on the current session emits `SessionEvent::Expired`; the GTK window and the SwiftUI app (through `rv-ffi`) go back to login.

## Parity and known differences

| Aspect | Mobile | Desktop |
|---|---|---|
| Live coverage | open room plus 3 hot rooms | every room via `__my_messages__`; deletions open room only |
| Room catch-up skip | `generation` plus hot-room LRU | per-session `synced` set |
| History reload on reopen | skipped under the same `generation` | always |
| Retention | 500 per room, once per session | none |
| Reconciliation snapshot before the request | yes | no (`purge_rooms_except` reads the known rids at write time) |
| Background | socket closed, driver suspended, push | socket kept |
| Logout interrupted offline | queued and replayed at next start | best effort, not replayed |

Two consequences worth knowing on desktop: a room created between the reconciliation request and its write could be purged until the next global catch-up brings it back, and a message deleted in a room that is already in `synced` while another room is open stays visible until that room is caught up again (a reconnection while it is open, or the next session). [Parity](../parity.md) §14 tracks these as desktop debt.

## Sources

- apps/mobile/lib/sync.ts
- apps/mobile/lib/catchUp.ts
- apps/mobile/lib/connectionSetup.ts
- apps/mobile/lib/outbox.ts
- apps/mobile/lib/uploadQueue.ts
- apps/mobile/providers/rocketchat/index.ts
- apps/mobile/providers/rocketchat/history.ts
- apps/mobile/providers/rocketchat/translator.ts
- apps/mobile/db/store.ts
- apps/mobile/db/upserts.ts
- apps/mobile/db/schema.ts
- apps/mobile/db/writeQueue.ts
- apps/mobile/ui/sync.tsx
- apps/mobile/ui/hotRooms.ts
- apps/mobile/ui/loadedRooms.ts
- apps/mobile/ui/openRooms.ts
- apps/mobile/ui/sessionToken.ts
- apps/mobile/app/salon/[rid].tsx
- apps/desktop/crates/rv-core/src/store.rs
- apps/desktop/crates/rv-core/src/sync.rs
- apps/desktop/crates/rv-core/src/outbox.rs
- apps/desktop/crates/rv-core/src/uploads.rs
- apps/desktop/crates/rv-core/src/live.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/macos/Sources/RocketVibeKit/AppModel.swift
- CLAUDE.md
