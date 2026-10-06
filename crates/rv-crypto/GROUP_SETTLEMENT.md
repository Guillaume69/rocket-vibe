# Settlement of group transitions

The coordinator keeps each prepared `GroupSubmission` in the vault before
HTTP, together with the OpenMLS state. The abandon decision is checkpointed before its network
call. The outbox is only released after comparing the terminal receipt with
the original: complete scope, operation, author device and signed fingerprint.
Signature, commit / tree / Welcome digests and local identity are
re-verified. A historical signature allows no new send.

`Coordinator::request_group_cancellation` provides the checkpointed original or the
decision already known, including without the HTTP feature. `Worker::cancel_group(room, operation)` returns `GroupSettlement::Accepted` or
`Cancelled`. An already durable acceptance always wins. `resume_group` resumes
the requested abandon after a cut; it does not republish this transition. The
terminal markers allow the local replay of `cancel_group` and forbid
preparing another intent with the same ID. A network error, a substituted
receipt or a non-checkpointed response releases no commit.

A genesis abandon deletes its unaccepted OpenMLS group and its local state,
then requires a new operation and a new confirmation for the next
group. An abandoned rotation / addition only erases the prepared commit;
the accepted epoch, the ratchets and the accepted package references stay
intact. The packages of an addition never accepted do not become consumed.

A valid successor received from a peer may replace the prepared commit. The uncertain
public original then stays in the vault, available after restart. A
new own transition is blocked until its settlement. A 404 status
does not authorize its republication from the new MLS state. Its abandon releases
the intent without touching the accepted group. If the server claims to have accepted
this old fork, the coordinator refuses to replace the current state. An
own confirmation already accepted cannot be supplanted by a peer fork.

A rotation accepted after the journal started keeps the prepared commit until
its native position. The terminal HTTP receipt is remembered, but it does not delete
the epoch with unread messages. Reception, possible terminal marker, MLS state
and cursor share the protected transaction; any late refusal cancels them.

The registry is bound to the instance, the data epoch, the user,
the device / incarnation and the account root of the vault. Its clock forbids
restarting a genesis at an earlier date after deletion of its state.
Old states without a registry are recorded before settlement or succession.
The bounds are 16 uncertain intents, one per room, 8192 markers and 8 MiB
per registry; the global vault limits may refuse earlier. No
marker is deleted to make an old ID reusable.

The server keeps the marker without commit / tree / Welcome, under the same lock
as the acceptance; [HTTP contract](../../docs/protocol/E2EE_GROUPS.md). Its authenticated
HTTP decision is not a cryptographic proof of non-acceptance.
Quotas and transient refusals do not trigger an automatic abandon.

[Readmission with a new Welcome](READMISSION.md) in the same vault is
added separately. Projection in the existing interfaces,
archives / files, Android bridge, qualification of keychains / devices and
independent review remain open. `capabilities.e2ee` stays disabled.
