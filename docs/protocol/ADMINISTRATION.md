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
```

Absent fields are kept. A supplied policy version is
verified under lock; a conflict modifies nothing. An effective change
revokes the associated device families, tickets and proofs, cancels the
snapshots / cursors and invalidates the authentication challenges. The account
lock waits for the end of an already authorized HTTP / WebSocket delivery. Password,
factors, verified address, identity, memberships and history are kept.
Reactivating the account requires a new login and its usual factors;
no old bearer is reactivated.

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

## Validation

The PostgreSQL tests cover revocation and reactivation preserving
data, the delivery lock, concurrent receipts, conflicts, the pagination
limit, the absence of implicit private access, removal / re-membership and audit
without secrets. One scenario also launches the real CLI binary on the isolated database
of the test to verify the arguments, receipts, exit codes and JSON.
These scenarios complement the P04 validations of the journeys in the apps; the
qualification on installed applications and J5 operations remain open.
