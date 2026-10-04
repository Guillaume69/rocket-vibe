# Mobile local data

The mobile app keeps everything in SQLite (expo-sqlite, schema and migrations by Drizzle), one database file per (server, account). The network only writes there, through idempotent SQL upserts serialized by a per-connection write queue, and the UI only reads. This doc covers the schema, the connection, the queue, migrations, the upsert rules, the depots and retention.

## One database per (server, account)

`db/fileName.ts#nomFichier(baseUrl, utilisateurId)` gives `rocket-vibe-<host slug>-<uid slug>.db`. Scheme and trailing slash are ignored, so the same server written two ways maps to one file. Two accounts on one server get two files: rooms, previews and unread counts belong to the account, and sharing them would show one account the other's DMs. Nothing in the schema is multi-server; isolation is the file name. The E2EE private key in the Keystore is keyed by the same (server, account) pair for the same reason (see [e2ee.md](e2ee.md)).

## The connection (`db/client.ts`)

`ouvrirBase(baseUrl, uid)` is idempotent and returns `{ brute, base, fileEcritures }`: the raw `SQLiteDatabase`, the Drizzle wrapper (`BaseLocale`) and the write queue. Connections are cached in a process-wide map and live for the whole process.

- `enableChangeListener: true` is mandatory, otherwise live queries never hear about writes and the UI freezes while the WebSocket feeds the database.
- `PRAGMA journal_mode = WAL`, so a UI read does not block an engine write.
- **No foreign keys, on purpose**: a message can arrive over the WebSocket before the room that contains it.
- **Never call `fermerBase` from a React cleanup.** The connection is shared and old-engine writes may still be in flight; closing under them is worse than leaving it open. It exists for tests and a possible account wipe.

## The write queue (`db/writeQueue.ts`)

`withTransactionAsync` transactions are per connection and not re-entrant: any write issued outside the queue while a `BEGIN` is open is absorbed into that transaction and silently rolled back if the batch fails. Two interleaved batches died on "cannot rollback - no transaction is active" (seen on the AVD, room history racing the reconnect catch-up). So `creerFileEcritures()` returns a promise chain that runs jobs one at a time; a failed job rejects for its caller but never blocks the queue.

The queue belongs to the **connection**, which is why `ouvrirBase` creates it. Every depot built on a connection must receive the same instance. An earlier version let `SynchroProvider` create it; its effect re-runs on a simple rename (new `session` object, same account), produced a second queue, and two engines interleaved on one SQLite. Inside a transaction, depot code uses the direct (unqueued) writers it is handed: going through the queue from inside `fn` would deadlock, and the `Depot.transaction` signature prevents it.

## Schema (`db/schema.ts`)

Dates are stored as integer milliseconds. Most tables carry `mis_a_jour_le` (the server `_updatedAt`) as the freshness arbiter. Server JSON fields are stored serialized in text columns.

| Table | Holds |
|---|---|
| `salons` (rooms) | One row per room: `type` (`c` channel, `p` private group, `d` direct, `l` livechat), `nom` (slug) and `nom_affiche` (display name), `chiffre` (E2EE room), `lecture_seule` (read-only), `dm_autre_uid` (the other DM participant, for presence; DM rids in 8.5 are random ObjectIds, not derivable), last-message preview (`dernier_message`, `dernier_message_type`, `horodatage_dernier_message`, indexed for ordering), `avatar_etag`. |
| `abonnements` (subscriptions) | Per-user state of a room: `sub_id` (needed because catch-up `remove[]` entries carry only the subscription `_id`), `non_lus`, `mentions`, `mentions_groupe`, `alerte`, `ouvert`, `favori`, `lu_jusqu_a` (`ls`, last read, drives the unread bar), `e2e_key` / `e2e_key_id`, `roles` (my roles in the room). |
| `messages` | Messages by `_id` (generated client-side when sending, the dedup key): `texte`, `horodatage`, author id and a frozen `auteur_nom` snapshot, `type_systeme` (`t`), thread fields (`fil_id` = `tmid`, `fil_reponses` = `tcount`, `fil_dernier` = `tlm`, `fil_affiche` = `tshow`), `modifie_le`, JSON blobs `md`, `pieces_jointes`, `reactions`, `urls` (server link metadata, often arriving after the message), `appel_id` (videoconf `callId`), `chiffre_brut` (encrypted content kept for later decryption), `epingle` (pinned), `etoiles` (starred uids). Indexed on `(rid, horodatage)` and `fil_id`. |
| `sortie` (outbox) | Pending text sends: `statut` `en-attente` or `echec`; there is no "sent" state, the row is deleted when the server copy arrives. |
| `televersements` (uploads) | Pending file sends: local `uri`, name, type, caption, `statut` (`en-attente`, `envoi` = taken by this process, `echec` = refused, only a manual retry re-arms it), and `file_id`, the dedup key returned by `rooms.media`. See [../features/uploads.md](../features/uploads.md). |
| `brouillons` (drafts) | Composer drafts keyed by `rid` or `rid:tmid`. In SQLite rather than MMKV to avoid one more native dependency and rebuild. |
| `emojis_custom` | Server custom emoji (`emoji-custom.list`): name, extension, aliases JSON. Reference data, replaced wholesale, loaded into memory for synchronous rendering. |
| `utilisateurs` (users) | `uid -> current username` and `avatar_etag`. Usernames are mutable, so this table, fed by every ingested message, gives the name to display even on old messages. |
| `etat_synchro` (sync state) | Catch-up cursors keyed by `(portee, flux)`: `portee` is a `rid` or `*` for global cursors. |

Optimistic messages are `messages` rows with `mis_a_jour_le = 0`: only a local copy exists. That value is how retention and "abandon send" (`SUPPRIMER_MESSAGE_OPTIMISTE`) recognise them.

## Migrations

- Edit `db/schema.ts`, then run `npm run db:generate` (`drizzle-kit generate`, configured by `drizzle.config.ts` with `dialect: 'sqlite'`, `driver: 'expo'`). It writes a numbered `db/migrations/NNNN_<name>.sql`, a snapshot in `db/migrations/meta/`, and regenerates `db/migrations/migrations.js`. Commit all three; `db/migrations/` is ignored by ESLint.
- `migrations.js` imports the `.sql` files as strings. That works because Metro gets `sql` added to `sourceExts` (`metro.config.js`) and Babel runs `babel-plugin-inline-import` for `.sql` (`babel.config.js`). `db/migrations.d.ts` types the generated module.
- `db/migrate.ts#migrerBase` runs drizzle's expo migrator on one database. It is memoized per file name by promise, so two callers in the same tick share one run; a failure is not memoized, so the next call retries. The body is async so that even a synchronous throw from opening a corrupt file becomes a rejection the caller can catch.
- Migration is done by whoever opens the database (`SynchroProvider` for the session's), never globally at app start.
- `db/schema.test.ts` applies every `.sql` file, split on `--> statement-breakpoint`, to an in-memory `node:sqlite` and checks the result, because generated is not the same as valid.

## Upserts (`db/upserts.ts`)

All SQL lives in this one file, as exported string constants with parameter builders (`paramsMessage`, `paramsSalon`...). Tests run exactly these strings on `node:sqlite` (`db/upserts.test.ts`), so they exercise the real queries. `db/store.ts` deliberately uses `runAsync` with these strings rather than Drizzle's query builder, so the app cannot diverge from the tested SQL.

Two invariants on network-fed tables:

1. `ON CONFLICT DO UPDATE`: replaying an event creates no duplicate. REST and WebSocket write the same rows, and catch-ups re-deliver known messages.
2. `WHERE excluded.mis_a_jour_le >= <table>.mis_a_jour_le`: an older event never overwrites a newer state (otherwise a post-reconnect catch-up could resurrect a pre-edit message or reset cleared unread counts).

Notable column rules:

- `messages.texte` for an `e2e` message keeps the already-decrypted text when a resync arrives without the key (`COALESCE`).
- `salons`: `nom`, `nom_affiche`, `dm_autre_uid`, `horodatage_dernier_message` and `avatar_etag` are `COALESCE`d, so a partial document never blanks them. The timestamp drives list order and the server does not move it back when the last message is deleted. A null etag would drop the avatar URL back to its query-less form, which the image cache still holds with the old photo.
- `abonnements.e2e_key` is `COALESCE`d (partial subscription events lack it).
- `UPSERT_UTILISATEUR` writes only if the username really changed and the source is not older, so ingesting messages does not re-fire every live query on `utilisateurs`. `UPSERT_IDENTITE` (authoritative sources: `me`, `users.info`, DM rooms) and `MAJ_AVATAR_*` have the same "only on real change" guards.
- `UPSERT_CURSEUR` only moves a cursor forward.
- Drafts have no freshness guard: the user's last keystroke wins.

## Depots (`db/store.ts`)

Factories over one connection and its queue: `creerDepot` (the sync engine's `Depot`, from `lib/sync.ts`), `creerDepotEnvoi`, `creerDepotTeleversements`, `creerDepotBrouillons`, `creerDepotEmojis`. Each write goes through the queue; reads (`lireCurseur`, `dernierMessageMisAJour`) skip it. `transaction(fn)` wraps a batch in one queued `withTransactionAsync`: one commit means one change event for live queries instead of one per row.

Side effects baked into writes:

- `upsertMessage` also records the author in `utilisateurs` and deletes any `sortie` row with the same id: a server-origin copy proves delivery.
- `upsertSalon` adds the other DM participant to `utilisateurs`, so its avatar shows and `updateAvatar` events (which name users by username only) find a row.
- `supprimerMessage` recomputes the preview of encrypted rooms (`MAJ_APERCU_CHIFFRE`), which have no server-side preview.
- `supprimerSalon` and `supprimerParSubId` also erase the room's satellites: outbox, uploads, drafts and cursors. Otherwise an unreachable `sortie` row would be replayed at every reconnect forever.

## Purge and retention

- **Reconciliation**: once per session, `fournisseur.reconcilier` fetches the full subscription list and purges rooms deleted server-side whose `removed` event was missed. The purge (`PURGER_*_ABSENTS`) runs over seven tables (rooms, subscriptions, messages, outbox, uploads, drafts, cursors) in one transaction. Guard: never purge against an empty list, since `NOT IN (nothing)` would delete everything; both the depot and its caller check.
- **Retention**: once per session, after catch-up, `appliquerRetention(MESSAGES_GARDES_PAR_SALON)` keeps the 500 newest messages per room (`APPLIQUER_RETENTION`, a `ROW_NUMBER()` window ordered by `horodatage DESC, id DESC`). It exempts optimistic rows (`mis_a_jour_le = 0`) and thread roots still referenced by a `fil_id`. It runs after catch-up because trimming first would trigger a re-download. Nothing is lost: the app never reads past its pagination and can re-fetch. Without it the table grows forever, mostly in JSON blobs, and the user's only recourse on Android would be "clear data", which also destroys drafts and the outbox.
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
- apps/mobile/db/migrations/migrations.js
- apps/mobile/db/migrations.d.ts
- apps/mobile/drizzle.config.ts
- apps/mobile/metro.config.js
- apps/mobile/babel.config.js
- apps/mobile/ui/sync.tsx
- apps/mobile/lib/sync.ts
