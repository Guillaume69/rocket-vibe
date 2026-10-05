# Protected journal of groups and messages

Experimental J4 batch, outside the current interfaces. The E2EE capability stays
disabled. The [server journal](../../docs/protocol/E2EE_MESSAGES.md) provides
transitions and messages in a common order of decimal native positions.

## Order and durability

After an explicitly accepted genesis / admission, `Worker::journal_page(room)`
reads its cursor in the vault, requests a page, then observes the current
roster and head again. The coordinator verifies the scope, the admission,
the fixed window, the strictly increasing positions and the exact labels
of the packets before consumption. Positions may have gaps linked
to the other native events; the revisions / parents of groups stay
strictly chained by the transitions and the real MLS.

The first event must match the genesis / Welcome already accepted.
It is not consumed a second time. Following commits, messages, ratchets,
private contents and the full cursor are recorded **in a transaction
protected per page**. A late invalid signature also cancels the earlier reads
and rotations of this page. No plaintext result leaves before
the protection and re-read of the external checkpoint.

`JournalBatch` contains local head, `after`, `through`, `complete` and private
contents of the page. With `next`, the vault keeps the same `through` for
resumption. Without `next`, `after` becomes `through`, including if the last
delivered position is lower than this bound. The worker constructor always
binds the data to the instance / generation / account / device of the vault.
A restore or a generation change does not reuse this cursor.

The bytes of the last batch stay in the private cache. On restart,
`Worker::journal_last_batch(room)` returns this batch after a new observation of
the admission and verification of the checkpoint. It does not decrypt again and
consumes no ratchet. The provider must project this result before
requesting the next page. Durable projection / confirmation on the apps side
and private history beyond the current cache are the next batches.
No plaintext document must enter the public SQLite cache of the apps.

## Authorization and rotations

Each epoch uses its roster from the signed plan, verified against the real
MLS tree and the roots / devices already approved. The current roster does not
silently replace that of a historical event. The personal admission
must however be identical in the current plan and in
each epoch: scope, member / access and activation versions, device,
incarnation, root, leaf and original KeyPackage. Certificate renewal
does not change this admission identity.

A withdrawal / new access or a device replacement requires a new
admission; the old journal does not become a history of the new device.
The initial consent and the approval of the pins remain required. Reading
a commit approaches no new pin and authorizes no new send.
Sending keeps the current head, roster, certificate and policy checks.

When a journal is started, `confirm` reconciles the exact ACK of a local
rotation without merging the commit immediately. The old epoch stays active
until the page processes the messages that precede this rotation, then
merges the original prepared commit. Ordered reception can therefore read a
message during this wait; new sends stay suspended.
The separate `receive_message` and `accept_commit` APIs then refuse
the consumption that would bypass this order. An account already advanced outside the journal
does not skip the old events to fabricate a valid prefix.

## Proofs and limits

Six scenarios with real reopened MLS / SQLite cover three missed epochs,
resumption between pages with integers above `2^53`, modified window refused,
late signature cancelling the whole batch, substituted metadata / positions / order,
ACK of local rotation with a message still unreadable, withdrawal
of another member and refused clean new access. A checkpoint failure after
commit publishes no plaintext; reopening finds the original private batch again.
They pass together in 3.86 s on the first verification. The guards
refusing separate consumers are also verified on these groups.

An additional HTTP scenario loses the read response before reception,
reopens the worker, finds the protected plaintext batch again and refuses valid room
metadata under another URL. The cursor stays unchanged after the refusal.

The real HTTP / PostgreSQL bench now uses these pages and their resumption
in both vaults, with six messages / three epochs and confirmations
lost after the real commit. The rotations wait for their passage in the
journal. It passes in 30.15 s. SQL keeps six opaque messages and nine frames,
with no plaintext document nor extra message POST. The external checkpoint
of this bench is simulated; no test on an installed device is claimed.
Formatting / strict Clippy pass with `system-keystore,native-http`; the initial full
private suite of the batch counts 124 successes in 157.95 s, with the crash
child executed by its parent and no filter. The route guard HTTP scenario
is added and verified separately afterwards.
After the route guards, the eleven HTTP scenarios pass together in 2.84 s,
the six journal scenarios in 4.03 s and the real bench is re-verified in 30.93 s.

## Historical certificates

The journal authenticates the signatures of old certificates, transitions
and messages without conferring current validity on them. The reader keeps
a current local certificate, the same keys / root / incarnation and the
same admission. An old own leaf stays readable after renewal
of this certificate; it is not converted into a current leaf to send.

Roots and devices of peers must still match the pins
explicitly approved today. Root change, unknown device, known
revocation, future certificate or invalid signature suspend
new decryptions. An expiry alone does not invalidate a signature nor
an authenticated MLS group. Contents already accepted remain subject to
the current personal admission on cache replay.

Sending, retry, new KeyPackages and explicit admissions
keep verifying the certificates at the current date. The public
`verify(now, ...)` APIs keep this rule, on the server side too. The new
`authenticate(...)` verifies only signatures / forms; it proves
neither a creation date, nor past validity, nor trust, nor a right to publish.
The journal uses the real reception date to refuse a future certificate,
without choosing the date declared by the signer as the validation clock.

The private records mark this reception policy with the real observation
date, in order to reopen a historical content / state without presenting it
as accepted under a current authorization. The old records without this
field keep their original verification at their acceptance date.

Four additional scenarios with real MLS / SQLite and fixture clock
prove three expired epochs after renewal of the reader, persistence /
replay, current send still refused, revocation / signatures / future refused,
and old own commit still prepared consumed after an old message.
The ten journal scenarios pass in 6.40 s on the first check.
This bench does not qualify the renewal ceremony in the apps.
Formatting / strict Clippy pass on both workspaces. The 31 E2EE server
scenarios pass in 9.89 s, the real HTTP / PostgreSQL bench in 35.27 s and
the full private suite counts 129 successes in 159.96 s, with no filter; the crash
child is still executed by its parent. Expiries are exercised by
the fixture clock in the vaults; the real HTTP bench does not simulate
an hour of elapsed time.

This choice does not prove that a content was produced before expiry. A
joint compromise of the signing keys and of the secrets of an old
epoch may allow fabricating contents attributed to that epoch.
The known-revocation and admission checks do not constitute a
proof of creation date. This limit also falls under the crypto review.

[Readmission in the same vault](READMISSION.md) resets the cursor to zero
for the new Welcome and marks the previous cache outside the current
projection. Its scheduling in the apps, the history of a revoked device,
the discovery of an old Welcome when the other grants have changed,
the final refusals of the outbox, archives / files and app bridges remain
open. The cache keeps at most 64 documents; it is not an archive.

The server may delay or omit frames. The positions allocated by the
server are not a cryptographic proof of completeness or of
revocation date. This implementation refuses the inconsistencies received and
protects a prefix of authorized journal pages; it does not promise to detect
every malicious omission. The independent crypto review remains necessary.
