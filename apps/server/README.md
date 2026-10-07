# Native RocketVibe server: RFC 0001 workstream

Experimental Rust server, developed on `feature/rocketvibe-server`. The foundation
is independent of Rocket.Chat: Axum / Tokio, PostgreSQL, `rv-protocol` contracts and
the reusable Rust transport `rv-client`. The native workspace at the root excludes
the existing desktop workspace.

Available: accounts created by CLI, password sign-in, revocable sessions,
private / public rooms with idempotent creation and controlled memberships,
a paginated directory of public rooms and personal membership, unique DMs,
idempotent messages, paginated history, a coherent snapshot and journal resumption
over HTTP / WebSocket. The native actions include edit, delete, reactions, pins and
private stars, with idempotent receipts, rights and intents persisted by the
clients. The marked lists use the existing screens of the three clients.
The API also provides session rotation and the listing / revocation of the
account's devices. The clients renew their session through SecureStore or the
system keyring, resuming a durable successor after a lost response.
The existing settings of the three clients expose names, dates and the revocation
of another device after a recent sign-in. Qualification on devices and email
recovery remain tracked in P01/P02. The existing sign-in screens offer
registration by invitation and recovery by operator code, preserving the identity
and revoking the old sessions.

The [existing mobile screens](../../docs/NATIVE_MOBILE_PILOT.md) and the
[existing GTK / SwiftUI interfaces](../../docs/NATIVE_DESKTOP_PILOT.md) host both
providers, with secure storage, SQLite, drafts and outbox. The Rust and TypeScript
transports are tested against the real server. The TOTP / recovery-code 2FA
foundation and its SDKs are described in [native authentication](../../docs/protocol/AUTHENTICATION.md);
its client forms and settings are wired. The
[verified email address flow](../../docs/protocol/EMAIL.md) has private routes,
SDKs and a durable encrypted SMTP queue. The mobile, GTK and SwiftUI forms are
wired. Conditional removal of the contact is available on the server and SDK side,
even without SMTP; all three clients are wired. The email second factor has server
and SDK routes for enrolment, removal, delivery and resumption of sign-in /
reauthentication challenges. The mobile app offers these challenges in its existing
screens. The desktop flows, factor enrolment and email recovery are wired to all
three clients. Presence, threads, search, profiles, settings and protected avatars
use their existing screens.
The [Android notifications](../../docs/protocol/PUSH.md) use a durable queue,
FCM HTTP v1 and private retrieval of the content in the existing mobile plugin.
The operator service account is configured with `RV_FCM_CONFIG_FILE`; without this
file, push stays disabled. Firebase / phone qualification is still open.
[Operator administration](../../docs/protocol/ADMINISTRATION.md) provides
accounts / rights / deactivation, rooms / members / settings, command receipts,
transactional audit and diagnostics (`health`). The [file lifecycle](../../docs/protocol/FILES.md)
offers preparation, streamed transfer, idempotent confirmation and protected
download / Range. Outboxes and readers are wired to the existing clients.
[Voice](../../docs/protocol/VOICE.md) runs over an operator LiveKit SFU
(`docker/compose.voice.yml`): voice channels, calls in every room and ringing
direct calls; it replaced the Jitsi meetings. Desktop notifications,
encryption and full parity remain in the backlog. The [public crypto directory](../../docs/protocol/E2EE_DIRECTORY.md)
now verifies certified devices and KeyPackage publication; it does not yet
make encrypted conversations available. The limits are explicit in
the [pilot contract](../../docs/protocol/README.md).

## Local start

On a dedicated server, behind a domain in HTTPS and with voice: see
[docs/DEPLOY-SERVER.md](../../docs/DEPLOY-SERVER.md).

From the repository root, with Docker Desktop / Docker Engine running:

1. Copy `docker/.env.native.example` to `docker/.env.native`.
2. Set `RV_DATABASE_PASSWORD` to a random password. Use URL-compatible
   characters, for example random bytes encoded in hexadecimal.
3. Start:

```sh
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml up --build -d
```

The server listens on `http://127.0.0.1:3400`. Native end-to-end encryption is on:
the server advertises the `e2ee` capability and the apps show their encryption
settings. To run an instance without it, add `RV_E2EE=false` to
`docker/.env.native`. It was activated before its independent review, by decision
([RFC 0002, Activation](../../docs/rfcs/0002-e2ee-native.md#activation-6-october-2026),
[internal review](../../docs/protocol/E2EE_REVIEW.md)). PostgreSQL has no port published on
the host. This Compose file and its volumes are separate from the Rocket.Chat bench.

Create an account with a password of at least 12 bytes supplied by the
environment variable `RV_USER_PASSWORD`; the value does not go through the arguments:

```sh
# Set RV_USER_PASSWORD in the shell before this command.
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm -e RV_USER_PASSWORD server create-user alice --admin
```

The administrator flag is stored for the rest of the workstream; it does not allow
reading private rooms or bypassing their rights. The CLI requires operator access
to the database. No public registration is open.

To let the person choose their own credentials in the app, issue an invitation:

```sh
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm server invite --hours 168
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm server list-invitations
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm server revoke-invitation IDENTIFIER
```

`invite` prints once a JSON containing the secret code `token` and the metadata;
pass the code to the recipient through the channel chosen by the operator.
The listing (the last 1,000 invitations) and the revocation use the public
identifier, without giving the code back. Duration: 1 to 168 hours, 7 days by
default; at most 1,000 active invitations per generation. The created account has
no admin right. The code creates a single account and provides no session; the
normal sign-in follows. A lost registration response can be resumed, before expiry,
with the same identifier and the password of the created account. Revocation,
deactivation, deletion of the account or a generation change close this resumption.
No email is sent automatically.

For an account owner verified by the operator, issue a password recovery code;
its value never goes through the arguments:

```sh
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm server recover-user alice --hours 24
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm server list-recovery-codes
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm server revoke-recovery-code IDENTIFIER
```

The JSON of `recover-user` prints the secret code once. Duration: 1 to 24 h,
at most 3 active codes per account and 1,000 per generation. In the existing form,
choose « Mot de passe oublié », enter the code and a new password. This flow keeps
UID, roles and conversations, revokes all device families, then goes through the
normal login. Recovery does not create a session by itself, does not remove a 2FA
factor and does not restore any E2EE key. A lost confirmation can be resumed with
the new password for five minutes, without revoking the sessions created since.
The change invalidates the other recovery codes; the codes are tied to the
account's authority and to the data generation. No implicit email sending and no
public enumeration to request a code.

Discovery and status:

```sh
curl http://127.0.0.1:3400/.well-known/rocketvibe
curl -f http://127.0.0.1:3400/health/ready
```

## Reproducible checks

From the root, run:

```sh
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml build check
docker compose --env-file docker/.env.native -f docker/compose.rocketvibe.yml run --rm check bash apps/server/scripts/check.sh
```

The check image contains Rust, rustfmt, clippy and Node 24. The SQLx tests
create separate temporary databases; no data from the development instance
is erased. They verify real HTTP, WebSocket, concurrency, rights refusals,
application restart and exchanges through the Rust and TypeScript transports.

The script also verifies the fixtures and the absence of divergence between the
schema and the generated types. The native CI runs the same checks, with the
typecheck, the mobile tests and the export of the Android JavaScript bundle. This
export is neither an APK nor a visual validation on a device.

## Contract and generation

The anonymous email recovery request is exposed by the server and the native SDKs
when SMTP and `RV_AUTH_KEY_FILE` are configured. It uses only the verified
contact, keeps a generic public response and keeps the same code after a retry.
The confirmation resumes the existing recovery, without creating a session or
removing the installed factors. See the
[email contract](../../docs/protocol/EMAIL.md#password-recovery-server-and-sdk)
for the bounds, versions and client flows still to be wired.

```sh
# In the check image, from /src:
cargo run --locked -p rv-protocol --bin export-schema > docs/protocol/v1.schema.json
node scripts/generate-native-protocol.mjs
```

The contract source is `crates/rv-protocol/src/lib.rs`. Dates are UTC strings
and long positions stay strings, including beyond the precision of JavaScript
numbers. Do not edit the generated files by hand.

## State and next steps

The pilot limits are set in `src/limits.rs`: sign-in 10 attempts per
username, 30 per IP of the TCP peer and 120 in total per 60-second window, budgets
shared in PostgreSQL; 4 simultaneous Argon2 verifications per process. Even a
cancelled request keeps its slot until the computation ends. A refusal returns
`429` with `Retry-After`; the native transports prevent early retries.

The `Forwarded` / `X-Forwarded-For` headers are not used as the identity of the
peer: behind a proxy, its clients share the quota of its IP. The handling of
explicitly trusted proxies remains to be defined before public exposure.

At most 4 unconsumed tickets per session, 128 sockets per process and 4 per
session. Sockets stay checked every 250 ms, with a 15 s heartbeat and a
5 s send / close timeout. Historical snapshot: 100 rooms, 50 messages per room and
8 MiB of JSON; `409 snapshot_limit` refusal with no partial view beyond that. The
materialized snapshot allows 1,000 rooms, 1 MiB per page / 64 MiB in total; its
immutable view expires after 5 minutes, with 4 views per account / 16 for the
instance. The last cursor is returned only after a complete download. Journal
batches are limited to 100 events and 1 MiB, without skipping the event that does
not fit in the batch. See the [pagination contract](../../docs/protocol/README.md#materialised-snapshots).

Responses and frames re-verify the version of their authorizations just before
delivery, then hold PostgreSQL locks until that delivery. Removal,
re-membership, role, session or generation do not validate an old response.
An abandoned / blocked HTTP body releases its barrier after 5 s at most.
Mutations hold their session until the commit, with lock wait
limited to 6 s, statement to 8 s and idle transaction to 10 s.
See the [revocation guarantees](../../docs/protocol/README.md#revocation-during-a-delivery).

A cursor expires after 7 days without renewal; at most 512 cursors per
account. An expired / pruned cursor requires a new snapshot through
`409 sync_reset_required`, without erasing the local intents that are still authorized.
At startup and then every minute, the server deletes up to 1,000 stale entries
per family (sessions, tickets, cursors, quotas), skipping locked rows.
It purges neither journal nor messages. These bounds do not replace a load test.

The [workstream tracker](../../docs/NATIVE_SERVER_EXECUTION.md) details what is
delivered and what remains to be done to close J0 and J1. The
[RFC](../../docs/rfcs/0001-rocketvibe-rust-server.md) remains the parity destination.
This version is a local bench, not a server meant to replace a Rocket.Chat instance
containing real data.
