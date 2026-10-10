# RocketVibe server

`apps/server` is a chat server of its own (crate `rv-server`): Rust, Axum 0.8 with WebSockets, tokio, PostgreSQL through SQLx. It shares no code and no API with Rocket.Chat. Its contract is `crates/rv-protocol` ([shared-crates.md](shared-crates.md)); the three client apps reach it through a separate "rocketvibe" provider next to their Rocket.Chat and Mattermost ones, and it serves the web client itself ([web-client.md](web-client.md)). The design and its scope are in `docs/rfcs/0001-rocketvibe-rust-server.md`; installing one is `docs/DEPLOY-SERVER.md` (in French).

## Process

One binary, one CLI (`src/main.rs`). `serve` (`--bind`, `RV_BIND`, default `127.0.0.1:3400`) runs the server; the other subcommands are the operator's tools: `create-user` (the password comes from `RV_USER_PASSWORD`, never the arguments), `invite`, `recover-user`, the matching `list-*` and `revoke-*`, `set-user`, `create-room`, `set-room`, `set-member`, `audit`, `health`, `set-instance`, `emoji list|put|remove`. Operator commands take an `--operation-id` so a retried command returns its first receipt (`src/operator.rs`).

| Setting | Meaning |
|---|---|
| `DATABASE_URL` | PostgreSQL, required. A pool of 12 connections. |
| `RV_AUTH_KEY_FILE` | 64 hex digits in a mode-600 file: the AES-256-GCM-SIV key sealing second-factor secrets and receipts (`src/factor_crypto.rs`). Without it, no 2FA and no email factors; losing it locks TOTP accounts out (fail closed). |
| `RV_SMTP_CONFIG_FILE` | SMTP host, port, sender, TLS mode, credentials (`src/mail.rs`). Enables email verification, recovery and email codes. |
| `RV_FCM_CONFIG_FILE` | A Firebase service-account JSON: push (`src/push.rs`). |
| `RV_LIVEKIT_CONFIG_FILE` | LiveKit URL, API URL, key and secret, unreadable by group and others: voice (`src/livekit.rs`). |
| `RV_E2EE` | Announce native end-to-end encryption, `true` by default. |
| `RV_TRUSTED_PROXIES` | Addresses or CIDR ranges whose `X-Forwarded-For` names the client (`src/client_address.rs`); empty trusts nobody. The Compose file trusts loopback and the private ranges. |
| `RV_OBJECTS_DIR` | Where files live (`data/objects`, `/var/lib/rocketvibe/objects` in the image). Without it, no uploads, avatars, emoji or previews. |
| `RV_WORKFLOW_PRIVATE_HTTP` | Let workflow HTTP steps reach private addresses: tests and development only. |

**Every subcommand, not only `serve`, migrates the database and runs the cleanup** (`App::from_pool_with_auth_key`, `src/lib.rs`): 54 migrations in `migrations/`, applied by `sqlx::migrate!`. The first boot also draws the instance's `instance_id` and `data_epoch`.

`serve` then starts the background loops (`src/main.rs`): email delivery (every second, `src/email_delivery.rs`), push (`src/push.rs`), workflows (`src/workflows/engine.rs`), link previews (`src/link_previews.rs`), voice reconciliation with LiveKit every 2 s under a PostgreSQL advisory lock so one process polls (`src/voice.rs`), and the cleanup every 60 s, which deletes expired rows by batches of 1000 and collects unreferenced files. Work queues are tables with leases, so a restart resumes them.

## HTTP

All routes live in one `router()` (`src/http.rs`, about 160), after the web client's (`src/web.rs`). Layers, outermost first: `client_address::resolve` (the real client behind a trusted proxy), a 64 KiB default body limit, `private_metadata_no_store` (`Cache-Control: no-store` on the E2EE, voice, admin, bot, workflow and email-factor paths), then, on matched routes only, the bot gate (`bots::gate`: a bot key reaches only the routes of its scopes). Routes taking more set their own limit (uploads 100 MiB, E2EE payloads up to 6 MiB, avatars and icons 2 MiB, emoji 1 MiB).

- **Errors** are `{code, request_id}` (`rv_protocol::ApiError`, `src/error.rs`): 400 `invalid_request`, 401 `session_rejected`, 403 `permission_denied`, 404 `not_found`, 409 `operation_conflict`, 429 with `Retry-After`, 500 `internal_error`. A database error is logged, never sent.
- **Discovery**: `GET /.well-known/rocketvibe` gives the product, `instance_id`, `data_epoch`, versions, `api_path` (`/api/v1`), the icon revision and about 45 capability flags. A capability is on only when its configuration is: uploads, avatars, emoji and previews need the objects directory, push needs FCM, voice needs LiveKit, factors need the auth key, email features need SMTP and the auth key.
- **Health**: `/health/live` answers without touching the database, `/health/ready` after a query.
- **The web client** is compiled into the binary: `build.rs` embeds `apps/web/dist` (committed) and fails without it. `web.rs` serves `/`, `/room/{room}`, `/sw.js`, `/manifest.webmanifest` and `/assets/*` with a strict CSP.

## Accounts and sessions

- **Passwords**: Argon2, at most 4 verifications at once (429 `auth_busy`), and a dummy hash for unknown names so timing reveals nothing (`src/auth.rs`).
- **Tokens**: 32 random bytes; only their SHA-256 is stored. Sessions last 30 days, one device row per login, 64 live sessions per user. Renewal (`/auth/renew`) is client-driven and replay-safe: the client proposes its next token under an `operation_id`; the same request within 5 minutes succeeds again, a different successor for a spent token revokes the whole device (`src/sessions.rs`).
- **Second factors** (`src/factors.rs`): TOTP (SHA-1, 6 digits, 30 s), ten backup codes, email codes. `/auth/start` answers a session or a challenge (5 minutes, 5 attempts). Sensitive changes (bots, workflows, encryption backups, email, sessions) need a recent authentication: a login under 15 minutes old or a reauthentication grant, else 403 `reauthentication_required`.
- **Getting in without a password**: invitations from the operator (`src/invitations.rs`), recovery codes from the operator (`src/recovery.rs`) or by email to the verified address (`src/email_recovery.rs`).
- **Rate limits** (`src/limits.rs`, 60 s windows kept in PostgreSQL): logins 120 per minute for the instance, 10 per name, 30 per client address, 10 per invitation or recovery token; 30 message actions per user per minute; uploads 10 pending, 30 per minute, a 50 GiB instance quota. Bots have their own budgets (`src/bots.rs`).

## Sync and real time

The server keeps one ordered **journal** of changes (`journal`, `src/store.rs`): room upserts, message upserts and room removals, each at the next `instance.position`. Clients never read rooms or messages "as of now"; they follow the journal.

- **Catch-up**: `GET /api/v1/sync/changes?cursor=` returns up to 100 events or 1 MiB after an opaque cursor, drops the events this user may not see while still advancing the cursor, and says `has_more` (`src/sync.rs`). Cursors live 7 days, 512 per user; an unknown or expired one answers 409 `sync_reset_required`, and the client starts over from a **snapshot**: paged, immutable for 5 minutes, up to 1000 rooms (`POST /sync/snapshots`, `src/snapshots.rs`).
- **WebSocket**: the client asks `POST /sync/ticket` for a 30-second single-use ticket, then opens `GET /sync/socket?ticket=&cursor=` (`src/http.rs`). The socket is server to client only: a client text frame closes it. Each socket polls the journal every 250 ms and sends the new batch, a heartbeat every 15 s, and with `live=true` a live frame every 2 s. 128 sockets per process, 4 per session.
- **Live state** is not journaled: presence (60 s leases), typing (10 s), voice participants and rings, profile stamps, in one live frame (`src/live.rs`).
- **No stale answer after a revocation**: a read records the grants it relied on (account activation, room authority, membership versions, data epoch) and re-checks them, locked, before sending the body or the frame; if one moved, 409 `delivery_revalidate` (`src/delivery.rs`). Account and room authorization versions are UUIDs rotated by database triggers.
- **Read states** per room and per thread (`src/room_reads.rs`).

## Data

- **PostgreSQL** holds everything but file bytes: about a hundred tables across the 54 migrations. Message ids are the client's `operation_id`: replaying a send with the same content returns the existing message, with different content 409. Operation ids share one namespace per user across messages, uploads, room commands and encryption (`src/store.rs`).
- **Files** are flat objects named by 64 hex digits in `RV_OBJECTS_DIR`, written to a temporary name, fsynced and renamed (`src/objects.rs`). Uploads go prepared, ready, completed (or cancelled, expired after 24 h); the server checks the SHA-256 and the type's magic bytes, and completion posts the message in the same transaction (`src/files.rs`). Downloads support ranges. The garbage collector removes files older than an hour that nothing references.
- **`data_epoch`** identifies the dataset in discovery, cursors and leases; a client seeing it change starts over. Nothing in the server changes it today: a restore from backup is supposed to (`docs/rfcs/0001-rocketvibe-rust-server.md`).

## What it serves

Rooms, DMs and the directory (`src/store.rs`, `src/room_details.rs`), permissions recomputed on the server (`src/permissions.rs`), edits, deletions, pins and stars (`src/message_actions.rs`, `src/marks.rs`), reactions, quotes, threads and mentions, full-text search (PostgreSQL `simple` configuration, `src/search.rs`), profiles and avatars, custom emoji and the instance icon, [slash commands](../features/slash-commands.md) (`src/commands.rs`), [bots](../features/bots.md), [workflows](../features/workflows.md), [voice](../features/voice.md) over LiveKit, push through FCM with content fetched on receipt (`src/push.rs`), email through a durable encrypted queue (`src/mail.rs`), link previews with SSRF protections (public addresses only, ports 80 and 443, DNS checked and pinned on every redirect, `src/link_previews/network.rs`), [administration and reports](../features/administration.md) (an administrator reads a private message only through an open report, `src/admin.rs`), and the server side of native E2EE: the device directory, key packages, signed MLS transitions and opaque ordered messages, verified with `rv-crypto-public` only, never with any private state (`src/e2ee.rs`, `src/e2ee/`; the features in the `e2ee-*` pages).

## Tests and release

- About 50 plain tests and 150 `#[sqlx::test]` inside `src/`, and 166 more `#[sqlx::test]` in `tests/` driving real HTTP and WebSockets, through `rv-client` and the mobile TypeScript transport. `#[sqlx::test]` needs `DATABASE_URL` and creates a database per test: `cargo test` without PostgreSQL fails on all of them.
- `apps/server/scripts/check.sh` is the gate: fmt, clippy `-D warnings` and the tests of the root workspace, the crypto vectors re-verified with Node, `rv-crypto`'s tests, the protocol schema diff, the generated protocol, emoji and Rocket.Chat inventory checks, and the mobile RocketVibe provider tests. Locally it runs in the Compose `check` profile; in CI in `native-server.yml` (`verify`, with `postgres:18-alpine`) and `server-release.yml`. `web-client.yml` also runs the server's clippy and unit tests.
- A `server-vX.Y.Z` tag runs `server-release.yml`: the gate, a Docker build (Debian bookworm, so glibc 2.36 or newer), the binary as `rocketvibe-server-X.Y.Z-linux-x86_64.tar.gz` with `SHA256SUMS`, and the release with its changelog section. No image is published.

## Footguns

- **A new route** needs a bot scope entry or keys cannot reach it (`crates/rv-protocol/src/bots.rs`), its own body limit above 64 KiB, and, if it carries private metadata, a place in the no-store list.
- **The server does not compile without `apps/web/dist`**: rebuild the web client first when the front end changes.
- **Any CLI subcommand migrates**: a newer binary's `list-users` against production upgrades production.
- **Behind a proxy, set `RV_TRUSTED_PROXIES`**, or every client shares the proxy's login budget of 30 attempts a minute.
- **Real time is polling**: 250 ms per socket, no pub/sub, and every journaled write serialises on the one `instance.position` row. Fine for a pilot, the first thing to change for a large instance.
- **Bot keys and workflow sessions** expire after a century (`src/bots.rs`, `src/workflows/engine.rs`): revoke them, they do not lapse.

## Sources

- `apps/server/Cargo.toml`
- `apps/server/README.md`
- `apps/server/build.rs`
- `apps/server/Dockerfile`
- `apps/server/scripts/check.sh`
- `apps/server/src/main.rs`
- `apps/server/src/lib.rs`
- `apps/server/src/http.rs`
- `apps/server/src/web.rs`
- `apps/server/src/error.rs`
- `apps/server/src/client_address.rs`
- `apps/server/src/limits.rs`
- `apps/server/src/auth.rs`
- `apps/server/src/sessions.rs`
- `apps/server/src/factors.rs`
- `apps/server/src/factor_crypto.rs`
- `apps/server/src/invitations.rs`
- `apps/server/src/recovery.rs`
- `apps/server/src/email_recovery.rs`
- `apps/server/src/store.rs`
- `apps/server/src/sync.rs`
- `apps/server/src/snapshots.rs`
- `apps/server/src/live.rs`
- `apps/server/src/delivery.rs`
- `apps/server/src/room_reads.rs`
- `apps/server/src/objects.rs`
- `apps/server/src/files.rs`
- `apps/server/src/search.rs`
- `apps/server/src/push.rs`
- `apps/server/src/mail.rs`
- `apps/server/src/email_delivery.rs`
- `apps/server/src/link_previews/network.rs`
- `apps/server/src/voice.rs`
- `apps/server/src/livekit.rs`
- `apps/server/src/bots.rs`
- `apps/server/src/workflows/engine.rs`
- `apps/server/src/admin.rs`
- `apps/server/src/operator.rs`
- `apps/server/src/e2ee.rs`
- `apps/server/migrations/`
- `apps/server/tests/`
- `docker/compose.rocketvibe.yml`
- `docs/DEPLOY-SERVER.md`
- `docs/rfcs/0001-rocketvibe-rust-server.md`
- `.github/workflows/native-server.yml`
- `.github/workflows/server-release.yml`
