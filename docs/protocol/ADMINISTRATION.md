# Native administration (P23)

The `rv-server` CLI uses the operator's `DATABASE_URL`. This operating right
is distinct from the administrator role in an application: no HTTP route
lets this role implicitly read a private conversation. The room commands
read neither messages, nor files, nor encryption keys.

## Accounts and invitations

`create-user <username> [--admin]` keeps the password in
`RV_USER_PASSWORD`, outside the arguments. `invite`, `list-invitations`,
`revoke-invitation`, `recover-user`, `list-recovery-codes` and
`revoke-recovery-code` remain available. Invitation and
recovery secrets are rendered only by their issuing command; their lists
and the audit journal do not contain them.

`list-users [--after <uid>] [--limit 50]` returns `{items,next}` with UID, username,
name, active status, administrator role, creation rights and policy
version. Email, password hash, bearer and factors are excluded.

```sh
rv-server set-user <uid> --disabled true --operation-id suspend-account-001
rv-server set-user <uid> --disabled false --operation-id restore-account-001
rv-server set-user <uid> --admin true --revision <revision> --operation-id grant-admin-001
rv-server set-user <uid> --create-public-room false --operation-id creation-policy-001
rv-server set-instance --user-bots true
```

`set-instance --user-bots true|false` opens bot creation to every account
(administrators always may), see [BOTS.md](BOTS.md). A bot is never made an
administrator (`bot_privilege`), nor re-enabled while it is a member of an
encrypted room (`bot_encrypted_room`).

Absent fields are kept. A supplied policy version is
verified under lock; a conflict modifies nothing. An effective change
revokes the associated device families, tickets and proofs, cancels the
snapshots / cursors and invalidates the authentication challenges. The account
lock waits for the end of an already authorized HTTP / WebSocket delivery. Password,
factors, verified address, identity, memberships and history are kept.
Reactivating the account requires a new login and its usual factors;
no old bearer is reactivated. The instance keeps an active administrator:
demoting or disabling the last one gives `409 last_administrator`, from the
CLI as from the app.

## Rooms and members

`list-rooms` returns the metadata, the member count, the opaque settings version and
the journal position as a string. `list-members <rid>`
returns UID, username, name, role and deactivation. These lists accept `--after` and
`--limit` (1 to 100). UIDs are used to act even after a rename.

```sh
rv-server create-room <owner-uid> 'Team' --private --operation-id create-team-001
rv-server set-room <rid> --revision <revision> --topic 'Planning' --read-only true --operation-id team-settings-001
rv-server set-member <rid> <uid> --revision <revision> --role moderator --operation-id team-moderator-001
rv-server set-member <rid> <uid> --revision <revision> --remove --operation-id team-remove-001
```

Settings / member changes require the current version. The server
locks the room, applies its constraints and publishes a `RoomUpsert` in the
common journal. A removal also publishes the personal `RoomRemoved` and cancels
the snapshots concerned. A re-membership has a new access token.
The last owner cannot be removed or demoted; transfer
ownership first. The owner of a new room must be active. The settings /
member commands refuse DMs, whose pair remains immutable.

The operator power makes it possible to manage a room on behalf of an owner,
including their creation policy. This intervention is traced separately
from the activities written by members; it does not fabricate a message attributed
to a user. The ordinary journeys of creation, discovery, membership,
invitation and management continue to apply the P04 rights in the apps.

## Replay, audit and diagnostics

The new mutation commands return a receipt
`{operation_id,subject_id,applied_revision}`. Supplying `--operation-id` before
a command makes it possible to repeat its arguments exactly after a lost
response. Without this argument, the CLI generates an ID returned in the receipt.

A kept receipt is replayed before the revision checks and never reapplies
the old state. Thus, replaying an old deactivation after a
reactivation does not suspend the account a second time. The same ID with other
arguments, or after a generation change, is refused. Receipt, change,
events and audit are committed in the same PostgreSQL transaction.

`audit [--after <id>] [--limit 50]` returns paginated events: ID as a string,
date, effective PostgreSQL role, generation, action, subject, command ID and
public before / after metadata. Failures do not produce a success
event; a replay adds none. The creation of an account and the issuing /
revocation of invitations or recovery codes are also recorded
in their transaction. The journal does not attest the human identity behind
a shared PostgreSQL account. Its retention / backup belongs to J5.

`health` returns PostgreSQL availability, its versions, instance / generation,
journal position and counts of accounts, rooms and messages. It returns neither
DSN, nor SMTP configuration, nor authentication secret. Service
parameters remain supplied by the server's arguments / variables and private
files; import and restoration will be wired in J5.

## In-app administration

The `administration` capability advertises the `/api/v1/admin/*` routes. They
require an account with `users.admin` (`manage_accounts` in `/me/permissions`);
any other account gets `403 permission_denied`. Reads keep the caller's
delivery proof: a right revoked during the read changes its activation version
and withholds the response. Every answer is `no-store`. Administration still
reads no private conversation: a message's text reaches an admin only through
an open report, which its reporter disclosed, and moderation deletes only a
reported message.

- `GET /admin/overview` returns `AdminOverview`: server, PostgreSQL and
  migration versions, instance, data epoch, process start (`started_at`, the
  uptime's origin) and counts. Users exclude deleted accounts (`admins` counts
  active ones; presence comes from live leases). Messages count what people
  wrote, without system activity or tombstones, by room kind; `encrypted`
  counts opaque private messages. Uploads are the completed ones. Reports count
  reported messages and accounts with an open report.
- `GET /admin/users?q=&after=&limit=` pages accounts by username (`limit`
  1-100, 50 by default, `after` the previous `next`). The cursor is opaque: it
  carries the last row's sort key and ID, so a rename or deletion between two
  pages neither skips nor repeats an account. `q` is a
  literal, case-insensitive substring of the username or display name. Deleted
  accounts never appear; a disabled account has no `avatar_file_id`, its avatar
  being no longer served. `last_seen_at` comes from the account's devices, so a
  deactivation, which revokes them, clears it. `revision` is the activation
  version.
- `PATCH /admin/users/{id}` takes `UpdateAdminUser {operation_id, revision,
  admin?, disabled?}` and answers the current `AdminUser`. It applies the CLI's
  `set-user` change (same revocations) with the expected revision. `AdminUser.bot`
  marks a bot account ([BOTS.md](BOTS.md)): it is refused the admin right
  (`409 bot_privilege`).
- `GET`/`PATCH /admin/settings` read and change the instance settings,
  `InstanceSettings {user_bots}` and `UpdateInstanceSettings {operation_id,
  user_bots?}`: whether every account may create bots.
- `PUT /admin/icon?operation_id=` (raw PNG or JPEG, 2 MiB at most) sets the
  server's icon and `DELETE /admin/icon?operation_id=` removes it, both
  answering `InstanceIcon {revision}` (`null` without an icon), with the
  `instance_icon` capability. The image is center-cropped to a square, scaled
  down to at most 256 pixels and re-encoded as PNG. Refusals: a missing
  `Content-Type` answers `400 invalid_request`, one other than `image/png` or
  `image/jpeg` `415 invalid_icon`, an image that does not decode (or is over
  4096 pixels a side) `400 invalid_icon`, an empty or over-2 MiB body
  `413 icon_too_large`. A replay of the operation applies nothing. The icon is
  public, like a favicon: `GET /api/v1/instance/icon` (PNG, `no-cache`, ETag the
  revision, `304` without a body on a matching `If-None-Match`; `404` without
  an icon), and the discovery document carries
  `icon_revision`, which clients add as `?v=` so their image caches follow. The
  operator journal records `instance.icon` with the administrator.
- `POST /admin/users/{id}/delete` takes `DeleteAdminUser {operation_id,
  revision}` and answers `204`.
- `GET /admin/rooms?q=&after=&limit=` pages every room by name, direct
  conversations included: kind, name, topic, member and message counts, last
  message (plain or encrypted), creation, read-only, encryption, and for a
  direct conversation its pair (`direct_members`, deleted accounts included).
  Rooms older than migration 0051 date from their first message. Its cursor,
  like the accounts', carries the last name and ID.
- `GET /admin/reports/messages?after=&limit=` and `/admin/reports/users` group
  the open reports by target, the most recently reported first (`after` is a
  report ID). Each item carries its count, its latest report and up to 20
  reports, newest first, with reporter and reason. A reported message also
  carries its room, its author with `author_revision` (to deactivate the
  author directly; absent once the author is deleted), and the text the newest
  reporter saw: each report keeps the message text at report time, so a later
  edit or deletion cannot hide what was reported. `deleted` tells whether the
  message is a tombstone now.
- `POST /admin/reports/messages/{message}/dismiss` closes its open reports.
  `.../delete` tombstones the message exactly as its author's deletion would
  (journal events, stars, pins and reactions erased) and closes its reports; an
  already deleted message only gets its reports closed.
  `POST /admin/reports/users/{user}/dismiss` closes an account's reports.
  Without an open report, these routes answer `404 not_found`.

The `reports` capability lets members report. `POST /messages/{message}/report`
requires current membership of the message's room (`404` otherwise, like a
missing message); system activity is refused (`403`), a deleted message gives
`410 message_deleted` and one's own message `409 self_report`. Encrypted
private messages are not in `messages`, so they cannot be reported.
`POST /users/{user}/report` refuses oneself (`409 self_report`) and a deleted
account (`404`). Both take `ReportInput {operation_id, reason}`, the reason
trimmed to 1-1,000 characters. A reporter keeps one open report per target:
reporting again replaces it with the new reason and the current text. Reports
share the 30 actions per minute of message actions, and a reporter keeps at
most 200 open reports, messages and accounts together: beyond, `429
report_limit` (`Retry-After` one hour, the limit lifting as administrators close
reports); replacing an open report stays possible. Closed reports stay in
PostgreSQL with their resolution and closing account; a message report keeps
the text its reporter disclosed.

### Receipts, guards and audit

Each command keeps a receipt bound to the acting account and its
`operation_id` for seven days (fingerprints only). The same command replays
without reapplying anything, a PATCH answering the current state; the same
identity with other content gives `409 operation_conflict`. A stale revision
gives `409 revision_conflict`. An administrator cannot change their own admin
right or activation, nor delete themselves (`409 self_administration`). Account
changes, in the app or the CLI, queue behind each other under an advisory
lock, so two administrators demoting each other cannot both succeed; removing
or deleting the last active administrator gives `409 last_administrator`.

Every change and report is recorded in `operator_audit` with its
`operation_id` and the acting account in `actor_id` (`NULL` for the CLI):
`user.policy`, `user.deleted`, `message.reported`, `user.reported`,
`message.moderated`, `message.reports_closed`, `user.reports_closed`. The
details carry identifiers and counts, never a message text or report reason.

### Account deletion

Deleting tombstones the account; its row stays so that its messages keep
their author. The deletion first applies the deactivation of `set-user`
(admin right and creation rights removed): devices go, and with them sessions,
WebSocket tickets, push registrations, presence and E2EE devices (their
fences retired), then cursors, snapshots and challenges. The account is
marked `deleted`, its username becomes `deleted-<id>`, its display name, bio,
status text and avatar are cleared (the avatar object removed), its status is
offline, its password unusable, its TOTP / e-mail factors, backup codes and
verified address deleted, its factor and contact versions rotated and its
unused recovery codes revoked. A pending e-mail recovery keeps only its opaque
no-op receipt, as for a removed account. Its E2EE root backup, history key and
history backup are deleted: sealed for devices that no longer exist, nobody
can open them. Open reports about it are closed. Its
memberships are removed, each with the personal `RoomRemoved` and a
`RoomUpsert` for the remaining members; a room whose last owner it was gets
its earliest remaining member as owner (active members first, by join time).
No system message is fabricated. Its messages, reactions and filed reports
stay; the wire `User` of such an author carries `deleted: true`, which clients
render as a deleted user. Deleted accounts are absent from the directory,
member lists and therefore mention completion. Neither the app nor
`set-user` can reactivate a tombstone (`404`); `list-users` shows it with
`deleted`. Usernames starting with `deleted-` (any case) are refused at
creation, invitation registration and rename.

The former username is retired (`retired_usernames`, lower case): no later
account may take it, in any case, through creation, invitation, rename or a
future import, so old mentions, links and screenshots never come to name
someone else. A trigger on `users` enforces it for every writer; creation
answers `409`, a rename `409 username_taken`, an invitation
`400 invitation_rejected`.

What a deletion leaves, and why: its public E2EE identity stays in the
directory, so members can still verify its past signatures; the
MLS group of an encrypted room still lists the account's leaves until a
remaining member's client commits their removal (the roster no longer lists the
account and `needs_rekey` asks for it), although the server delivers nothing
more to its retired devices. A direct conversation keeps its name, made of the
usernames at its creation, and its pair. Audit details written before the
deletion keep the old username. Its messages, reactions, stars it gave and
reports it filed stay: they belong to the conversations and to the moderation
record, not to the account.

Migration 0051 adds `users.deleted` and `users.created_at` (backfilled from
the `user.created` audit rows, otherwise unknown), `rooms.created_at`,
`members.joined_at` (existing memberships share the migration instant, a
single stable default; new ones get their own time), `operator_audit.actor_id`,
the retired usernames, the report tables and the receipts.

## Validation

The PostgreSQL tests cover revocation and reactivation preserving
data, the delivery lock, concurrent receipts, conflicts, the pagination
limit, the absence of implicit private access, removal / re-membership and audit
without secrets. One scenario also launches the real CLI binary on the isolated database
of the test to verify the arguments, receipts, exit codes and JSON.
`tests/admin.rs` covers the in-app routes: refusal of a member, overview
counts, paging and search, revisions, replays and self / concurrent guards,
deletion as a tombstone and its retired username, the last administrator kept
from the CLI, cursors stable across a rename or deletion, rooms with direct
conversations, reports (refusals, kept text, cap), dismissal and moderation
deletion, and the actor of each audit row.
These scenarios complement the P04 validations of the journeys in the apps; the
qualification on installed applications and J5 operations remain open.
