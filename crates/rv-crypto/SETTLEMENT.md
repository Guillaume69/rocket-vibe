# Final settlement of personal sends

State as of 4 October 2026: server / SDKs / worker delivered.
Since 6 October 2026 the `e2ee` capability is on by default ([RFC 0002, Activation](../../docs/rfcs/0002-e2ee-native.md#activation-6-october-2026)).
[Server contract](../../docs/protocol/E2EE_MESSAGES.md).

`Worker::cancel_message(operation)` resumes the exact opaque intent from
the vault and first checkpoints its abandon intent, then calls the personal
route. `resume_message` resumes this decision after restart: no
new send POST, even if the cut precedes the arrival of the abandon at the server.
An abandon result returns `crypto_message_cancelled` there after checkpoint;
the document stays accessible via `cancelled_message`. The worker looks up no
new roster, does not re-encrypt the document and does not require the original
certificate to still be valid. The account / data scope and the stop guards
of the worker remain mandatory; no network holds the vault lease.

A `MessageSettlement::Accepted` result is compared with the original proof and
checkpointed like a normal confirmation. A `Cancelled` result requires the
same Header and fingerprint, then writes a terminal marker in the private
ledger. The HTTP labels are canonical and bounded. The receipts are decisions
of the authenticated server: they do not prove its good faith or the absence of
a hidden publication.

A network error, a wrong receipt or an unconfirmed checkpoint does not make
the abandon available to the provider. The same call can be replayed after
reopening. An external checkpoint failure after the SQLite commit may have
already recorded the decision; the vault recovers it and its replay is idempotent.
The expired certificate blocks neither this reconciliation nor the personal body
kept. The private monotonic clock still forbids a time rollback.

The abandon marker forbids retry, preparation with the old ID, late ACK
and contradictory echo. It releases the lock of pending messages that prevented
an own rotation. It removes no already confirmed message. The MLS generation
consumed by the preparation stays consumed; the peer can receive the next
generation by skipping the abandoned one.
The OpenMLS generation-skip bounds remain in force: long
chains of abandons require a rotation, with a policy to be wired
into the provider. This batch does not increase these bounds and proves only the skip tested.

`Coordinator::cancelled_message` returns the personal document kept in a
private buffer wiped on destruction. The provider will have to recover it in
its own protected storage before `forget_cancelled_message`. The terminal
marker survives this erasure. A new send requires a new operation,
a current observation / key and the usual checks. No journal,
ordinary projection, notification or server text is written by the abandon.

A personal status `409 crypto_message_cancelled`, for example after an abandon
from another session of the account, triggers recovery of the exact receipt
against the protected proof. The error code alone is not enough to release the outbox.
Old ledgers without `cancelled` / `cancelling` fields stay readable. The ledger
keeps at most 64 bodies and 8192 identities; settled bodies and released
identities leave first (see [messages](MESSAGES.md)), an abandoned body is never
automatically erased. Transient refusals are never converted into
an automatic abandon. The [settlement of prepared transitions](GROUP_SETTLEMENT.md)
has its own original and terminal markers. Withdrawal / new
admission of the group, private projection in the apps, archives / files,
device qualification and independent review remain open.
