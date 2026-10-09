# Mobile local data

The mobile app keeps everything in SQLite (expo-sqlite, schema and migrations by Drizzle), one database file per (server, account). The network only writes there, through idempotent SQL upserts serialized by a per-connection write queue, and the UI only reads. This doc covers the schema, the connection, the queue, migrations, the upsert rules, the stores and retention.

## One database per (server, account)

`db/fileName.ts#databaseFileName(baseUrl, userId)` gives `rocket-vibe-<host slug>-<uid slug>.db`. Scheme and trailing slash are ignored, so the same server written two ways maps to one file. Two accounts on one server get two files: rooms, previews and unread counts belong to the account, and sharing them would show one account the other's DMs. Nothing in the schema is multi-server; isolation is the file name. The E2EE private key in the Keystore is keyed by the same (server, account) pair for the same reason (see [e2ee.md](e2ee.md)).

## The connection (`db/client.ts`)

`openDatabase(baseUrl, uid)` is idempotent and returns `{ raw, base, writeQueue }`: the raw `SQLiteDatabase`, the Drizzle wrapper (`LocalDatabase`) and the write queue. Connections are cached in a process-wide map and live for the whole process.

- `enableChangeListener: true` is mandatory, otherwise live queries never hear about writes and the UI freezes while the WebSocket feeds the database.
- `PRAGMA journal_mode = WAL`, so a UI read does not block an engine write.
- **No foreign keys, on purpose**: a message can arrive over the WebSocket before the room that contains it.
- **Never call `closeDatabase` from a React cleanup.** The connection is shared and old-engine writes may still be in flight; closing under them is worse than leaving it open. It exists for tests and a possible account wipe.

## The write queue (`db/writeQueue.ts`)

`withTransactionAsync` transactions are per connection and not re-entrant: any write issued outside the queue while a `BEGIN` is open is absorbed into that transaction and silently rolled back if the batch fails. Two interleaved batches died on "cannot rollback - no transaction is active" (seen on the AVD, room history racing the reconnect catch-up). So `createWriteQueue()` returns a promise chain that runs jobs one at a time; a failed job rejects for its caller but never blocks the queue.

The queue belongs to the **connection**, which is why `openDatabase` creates it. Every store built on a connection must receive the same instance. An earlier version let `SyncProvider` create it; its effect re-runs on a simple rename (new `session` object, same account), produced a second queue, and two engines interleaved on one SQLite. Inside a transaction, store code uses the direct (unqueued) writers it is handed: going through the queue from inside `fn` would deadlock, and the `Store.transaction` signature prevents it.

## Schema (`db/schema.ts`)

Dates are stored as integer milliseconds. Most tables carry `updated_at` (the server `_updatedAt`) as the freshness arbiter. Server JSON fields are stored serialized in text columns.

| Table | Holds |
|---|---|
| `rooms` | One row per room: `type` (`c` channel, `p` private group, `d` direct, `l` livechat), `name` (slug) and `display_name`, `encrypted` (E2EE room), `read_only`, `dm_other_uid` (the other DM participant, for presence; DM rids in 8.5 are random ObjectIds, not derivable), last-message preview (`last_message`, `last_message_type`, `last_message_ts`, indexed for ordering, `idx_rooms_activity`), `avatar_etag` (`none` marks a removed photo). |
| `subscriptions` | Per-user state of a room: `sub_id` (needed because catch-up `remove[]` entries carry only the subscription `_id`), `unread`, `mentions`, `group_mentions`, `alert`, `open`, `favorite`, `last_seen` (`ls`, last read, drives the unread bar), `e2e_key` / `e2e_key_id`, `roles` (my roles in the room). |
| `messages` | Messages by `_id` (generated client-side when sending, the dedup key): `text`, `ts`, author id and a frozen `author_name` snapshot, `system_type` (`t`), thread fields (`thread_id` = `tmid`, `thread_count` = `tcount`, `thread_last` = `tlm`, `thread_shown` = `tshow`), `edited_at`, JSON blobs `md`, `attachments`, `reactions`, `urls` (server link metadata, often arriving after the message), `call_id` (videoconf `callId`), `encrypted_raw` (encrypted content kept for later decryption), `pinned`, `starred` (starred uids). Indexed on `(rid, ts)` (`idx_messages_room_ts`) and `thread_id` (`idx_messages_thread`). |
| `outbox` | Pending text sends: `text`, `thread_id`, `status` `pending` or `failed` (`idx_outbox_status`), `attempts`, `last_error`, `created_at`; there is no "sent" state, the row is deleted when the server copy arrives. |
| `uploads` | Pending file sends: local `uri`, `name`, `type`, `caption`, `status` (`pending`, `sending` = taken by this process, `failed` = refused, only a manual retry re-arms it; `idx_uploads_status`), and `file_id`, the dedup key returned by `rooms.media`. See [../features/uploads.md](../features/uploads.md). |
| `drafts` | Composer drafts (`key`, `text`, `updated_at`) keyed by `rid` or `rid:tmid`. In SQLite rather than MMKV to avoid one more native dependency and rebuild. |
| `emoji_usage` | The emoji I react with, counted on the device for the quick reactions: `code` (the canonical shortcode of the emoji, without colons, so aliases share one row; primary key), `count`, `last_used` (ms). Device data, not server data: no catch-up can rebuild it, so neither the purges nor `NativeStore.prepare()` touch it. At most `KEPT_CODES` (64) rows. Migration 0020. See [../features/emoji.md](../features/emoji.md#quick-reactions-and-reacting-with-any-emoji). |
| `custom_emojis` | Server custom emoji (`emoji-custom.list`): name, extension, aliases JSON. Reference data, replaced wholesale, loaded into memory for synchronous rendering. |
| `users` | `uid -> current username`, `avatar_etag` and `name`, the real name (migration 0025, null when unknown; shown only under Rocket.Chat's `UI_Use_Real_Name`, [room-list](../features/room-list.md)). Usernames are mutable, so this table, fed by every ingested message, gives the name to display even on old messages. |
| `cursors` | Catch-up cursors keyed by `(scope, stream)` with `updated_since`: `scope` is a `rid` or `*` for global cursors; `stream` is `rooms`, `subscriptions` or `messages-deleted`. |
| `native_*` | The RocketVibe provider's own state (migration 0017): sync state and positions, read and thread states, pending intents and commands (room, profile, upload, favourite, read; the meeting intents table is gone with the voice channels), room access, quote references and sources, the emoji catalog. Emptied, with the shared tables, by `NativeStore.prepare()` when the stored generation is not the current one (`providers/rocketvibe/store.ts`). |

Optimistic messages are `messages` rows with `updated_at = 0`: only a local copy exists. That value is how retention and "abandon send" (`DELETE_OPTIMISTIC_MESSAGE`) recognise them.

## Migrations

- Edit `db/schema.ts`, then run `npm run db:generate` (`drizzle-kit generate`, configured by `drizzle.config.ts` with `dialect: 'sqlite'`, `driver: 'expo'`). It writes a numbered `db/migrations/NNNN_<name>.sql`, a snapshot in `db/migrations/meta/`, and regenerates `db/migrations/migrations.js`. Commit all three; `db/migrations/` is ignored by ESLint.
- `migrations.js` imports the `.sql` files as strings. That works because Metro gets `sql` added to `sourceExts` (`metro.config.js`) and Babel runs `babel-plugin-inline-import` for `.sql` (`babel.config.js`). `db/migrations.d.ts` types the generated module.
- `db/migrate.ts#migrateDatabase` runs drizzle's expo migrator on one database. It is memoized per file name by promise, so two callers in the same tick share one run; a failure is not memoized, so the next call retries. The body is async so that even a synchronous throw from opening a corrupt file becomes a rejection the caller can catch.
- Migration is done by whoever opens the database (`SyncProvider` for the session's), never globally at app start.
- **Migration 0021 (`db/migrations/0021_author_bot.sql`)** adds `messages.author_bot` (default false), written only by the RocketVibe store after the shared upsert, for the bot badge ([../features/bots.md](../features/bots.md)).
- **Migration 0022 (`db/migrations/0022_message_form.sql`)** adds `messages.form`, the JSON of a workflow's form (`Message.form`), written only by the RocketVibe store, read by the form card and the answer sheet ([../features/workflows.md](../features/workflows.md)).
- **Migration 0025 (`db/migrations/0025_user_names.sql`)** adds `users.name`, the person's real name (a message's `u.name`, `me`, `users.info`, a two-person DM subscription's `fname`). Rows written before it have none until a source names them; the reconciliation's full subscription list backfills the DM peers.
- **Migration 0020 (`db/migrations/0020_emoji_usage.sql`)** adds `emoji_usage` with `CREATE TABLE IF NOT EXISTS`: development builds of this feature had created it as 0019 before the rebase put it after `0019_voice_channels`, and there it must be a no-op.
- **Migration 0016 (`db/migrations/0016_english_names.sql`) moved the schema to English names in place.** Until 0015 the tables and columns had French names; 0016 renames the tables (`rooms`, `subscriptions`, `drafts`, `custom_emojis`, `users`, `cursors`) and their columns with `ALTER TABLE ... RENAME`, recreates the indexes under English names, and rebuilds `outbox` and `uploads` by copy (their `status` default and values change: `pending`, `sending`, `failed`). It also rewrites the stored values: cursor `stream` names (`rooms`, `subscriptions`, `messages-deleted`) and the removed-photo marker in `avatar_etag` (`none`). Data survives the upgrade; the old SQL names now appear only in migrations 0000 to 0015. The move is one-way: a build from before 0016 cannot open a database migrated by it (on a test device, going back means reinstalling).
- `db/schema.test.ts` applies every `.sql` file, split on `--> statement-breakpoint`, to an in-memory `node:sqlite` and checks the result, because generated is not the same as valid.

## Upserts (`db/upserts.ts`)

All SQL lives in this one file, as exported string constants with parameter builders (`messageParams`, `roomParams`...). Tests run exactly these strings on `node:sqlite` (`db/upserts.test.ts`), so they exercise the real queries. `db/store.ts` deliberately uses `runAsync` with these strings rather than Drizzle's query builder, so the app cannot diverge from the tested SQL.

Two invariants on network-fed tables:

1. `ON CONFLICT DO UPDATE`: replaying an event creates no duplicate. REST and WebSocket write the same rows, and catch-ups re-deliver known messages.
2. `WHERE excluded.updated_at >= <table>.updated_at`: an older event never overwrites a newer state (otherwise a post-reconnect catch-up could resurrect a pre-edit message or reset cleared unread counts).

Notable column rules:

- `messages.text` for an `e2e` message keeps the already-decrypted text when a resync arrives without the key (`COALESCE`).
- `rooms`: `name`, `display_name`, `dm_other_uid`, `last_message_ts` and `avatar_etag` are `COALESCE`d, so a partial document never blanks them. The timestamp drives list order and the server does not move it back when the last message is deleted. A null etag would drop the avatar URL back to its query-less form, which the image cache still holds with the old photo.
- `subscriptions.e2e_key` is `COALESCE`d (partial subscription events lack it).
- `UPSERT_USER` writes only if the username or the real name really changed and the source is not older, so ingesting messages does not re-fire every live query on `users`. `name` is `COALESCE`d (an absent name never erases a known one), and an OLDER message may still fill a missing name (rows from before 0025), setting nothing else. `UPSERT_IDENTITY` (authoritative sources: `me`, `users.info`, DM rooms; it writes `name` with `COALESCE` too) and `UPDATE_USER_AVATAR` / `UPDATE_ROOM_AVATAR` have the same "only on real change" guards. `UPDATE_DM_PEER_NAME` writes a two-person DM subscription's `fname` on the room's `dm_other_uid`, only on a real change and only once the room is known.
- `UPSERT_CURSOR` only moves a cursor forward.
- Drafts have no freshness guard: the user's last keystroke wins.
- `RECORD_EMOJI_USE` adds one use and never moves `last_used` back (a clock set back must not demote an emoji); `PRUNE_EMOJI_USAGE` (`[code, code, KEPT_CODES - 1]`) keeps the code just used plus the best others by the same ranking as `topEmojis`, so the lowest-ranked OTHER code makes room and a new emoji can grow past established ones; `LIST_EMOJI_USAGE` reads them all.

## Stores (`db/store.ts`)

Factories over one connection and its queue: `createStore` (the sync engine's `Store`, from `lib/sync.ts`), `createOutboxStore`, `createUploadStore`, `createDraftStore`, `createEmojiStore`, `createEmojiUsageStore` (`read`, and `record`, which stores `canonicalEmojiCode` of the code (aliases merged at write time), ignores anything that is not a shortcode and prunes in the same queued job; mounted per session through `ui/emojiUsage.ts`). Each write goes through the queue; reads (`readCursor`, `lastMessageUpdatedAt`) skip it. `transaction(fn)` wraps a batch in one queued `withTransactionAsync`: one commit means one change event for live queries instead of one per row.

Side effects baked into writes:

- `upsertMessage` also records the author in `users` and deletes any `outbox` row with the same id: a server-origin copy proves delivery.
- `upsertRoom` adds the other DM participant to `users`, so its avatar shows and `updateAvatar` events (which name users by username only) find a row.
- `upsertSubscription` runs `UPDATE_DM_PEER_NAME` when the subscription carries a DM name (`dmName`); `saveDmNames` runs it for a whole list in one queued job, fed by `reconcileRooms` (`lib/catchUp.ts`) from the full subscription list.
- `deleteMessage` recomputes the preview of encrypted rooms (`UPDATE_ENCRYPTED_PREVIEW`), which have no server-side preview.
- `deleteRoom` and `deleteBySubId` also erase the room's satellites: outbox, uploads, drafts and cursors. Otherwise an unreachable `outbox` row would be replayed at every reconnect forever.

## Purge and retention

- **Reconciliation**: once per session, `provider.reconcile` fetches the full subscription list and purges rooms deleted server-side whose `removed` event was missed. The purge (`PURGE_MISSING_*`) runs over seven tables (rooms, subscriptions, messages, outbox, uploads, drafts, cursors) in one transaction. Guard: never purge against an empty list, since `NOT IN (nothing)` would delete everything; both the store and its caller check.
- **Retention**: once per session, after catch-up, `applyRetention(MESSAGES_KEPT_PER_ROOM)` keeps the 500 newest messages per room (`APPLY_RETENTION`, a `ROW_NUMBER()` window ordered by `ts DESC, id DESC`). It exempts optimistic rows (`updated_at = 0`) and thread roots still referenced by a `thread_id`. It runs after catch-up because trimming first would trigger a re-download. Nothing is lost: the app never reads past its pagination and can re-fetch. Without it the table grows forever, mostly in JSON blobs, and the user's only recourse on Android would be "clear data", which also destroys drafts and the outbox.
- **Session end** does not delete the database; switching back to an account reopens its file with the cache intact.

## Sources

- apps/mobile/db/schema.ts
- apps/mobile/db/client.ts
- apps/mobile/db/writeQueue.ts
- apps/mobile/db/migrate.ts
- apps/mobile/db/fileName.ts
- apps/mobile/db/upserts.ts
- apps/mobile/db/store.ts
- apps/mobile/db/schema.test.ts
- apps/mobile/db/upserts.test.ts
- apps/mobile/db/migrations/0016_english_names.sql
- apps/mobile/db/migrations/0017_native_provider.sql
- apps/mobile/db/migrations/0019_voice_channels.sql
- apps/mobile/db/migrations/0020_emoji_usage.sql
- apps/mobile/db/migrations/0021_author_bot.sql
- apps/mobile/db/migrations/0022_message_form.sql
- apps/mobile/db/migrations/0025_user_names.sql
- apps/mobile/lib/catchUp.ts
- apps/mobile/providers/rocketvibe/store.ts
- apps/mobile/lib/emojiUsage.ts
- apps/mobile/db/migrations/migrations.js
- apps/mobile/db/migrations.d.ts
- apps/mobile/drizzle.config.ts
- apps/mobile/metro.config.js
- apps/mobile/babel.config.js
- apps/mobile/ui/sync.tsx
- apps/mobile/lib/sync.ts
