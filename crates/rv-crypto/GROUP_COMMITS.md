# Protected MLS transitions

`groups::Commit` carries the signed transition, its real TLS commit, the receipt and the
room / membership versions observed independently. `preview_commit` validates
the successor in a temporary provider; `accept_commit` repeats this
validation and keeps the MLS state, receipt and invalidation of the concurrent outbox
in the same protected transaction. Nothing is handed over before the checkpoint.

## Successor preparation

`groups::Change` supplies the independently observed current roster, the complete
server head, the operation, the IDs of devices to withdraw explicitly and
their new public KeyPackages. `preview_change` requires this head to be identical
to the accepted local receipt and verifies the real old tree before confirmation. A
stale offline state must catch up on the events before preparation.

Without addition or withdrawal, the flow performs a real leaf rotation. Additions,
withdrawals and Remove+Add replacements are included in a single commit, even with
different numbers. The author stays admitted; a local withdrawal belongs to the
distinct flow still to be integrated. All the users of the roster must be
represented. A changed access / activation nonce forbids keeping an
old admission: the devices concerned must be withdrawn and readmitted
with fresh packages. References already observed stay forbidden.

The retained devices keep their identity, index and initial package reference,
with current certificate and approved pins. A withdrawn device may
already be revoked or expired. The renewed local certificate is installed in the
real MLS leaf by the commit parameters; its root, incarnation and
signing key must stay the same. The other devices then verify
the renewed certificate through the reception flow.

The opaque confirmation binds request, accepted state, pins, local certificate and
a deadline of five minutes at most. The indices of the new recipients
in the preview are provisional; the signed plan uses the real indices
of the PublicGroup validated after preparation. The context, tree, epoch and each
leaf are checked before persistence. Inputs are bounded before copy
and hash; the order of withdrawals or packages does not change the request identity.
MLS proposals already pending are refused, with no implicit addition.

`prepare_change` keeps the prepared MLS state, proof, tree, commit and original
Welcomes in the same protected transaction before any handover to the network.
The accepted epoch stays old until the exact receipt. Reopening, lost response
and interrupted checkpoint resume the same bytes; a different request
does not replace the outbox. The original retry remains possible after
the preview expires only if the certificate and trust are still
valid. The exact historical receipt remains separately reconcilable.

## Validation and reception

The proof must designate exactly the vault scope and its group, the accepted
parent, the previous revision and epoch, as well as the observed policy
and member versions. The receipt binds the proof and its operation. OpenMLS then authenticates
and decrypts the message: application content, an isolated proposal,
an external sender, a self-removal or a PSK proposal are refused in
this flow. The [readmission through a new Welcome](READMISSION.md) replaces
the group in the same vault, with no implicit inheritance. Suspension after
withdrawal and the wiring of these flows into the apps remain to be integrated.

The real MLS author must match the root / device / incarnation
and signing key of the certificate declaring the transition, with its real
index. A valid proof signature is not enough to attribute the commit of
another member. A renewed certificate may keep its key; its current proof
stays subject to pins and revocations. After merging, context, tree, epoch,
indices, certificates and keys of **each** leaf match the proof.
Remote devices require their persistent local approvals.

A retained admission keeps its nonces, identity, index and initial package
reference. A reactivated / returned member or a moved device requires a real
MLS addition with a new package and a declared Welcome. The engine compares the RFC 9420
reference with the package actually covered by the Add proposal; the declared
Welcomes concern exactly the new admissions. Changing the local nonces
requires a distinct readmission: the old ratchets do not become
those of the new membership.

The references observed in accepted states are kept after the member
is withdrawn. A new admission cannot reuse such a reference,
even after the leaf has disappeared. This memory is bounded to 8,192 references
per group incarnation, with no eviction that would make an old package reusable.
The document stays bounded to 8 MiB; the global vault to 16 MiB. Old
genesis / admissions without this index rebuild it from their accepted plan.
This cache does not claim to know earlier references never observed
by this installation; the server also keeps its spent references.

## Authenticated data of the commit

The genesis prepared by the vault now uses the AAD of this profile for
its add commit. Reception requires these same authenticated bytes. The AAD
are the UTF-8 prefix `rocketvibe-mls-commit-routing-v1`, a null byte, then the
compact JSON serialized in this order:

`version`, `scope`, `operation`, `expected_revision`, `expected_epoch`, `epoch`,
`previous`, `authority_version`, `members`, `devices`.

The fields reuse the types and orders of the signed plan, with `version = 1`.
Devices are sorted by ID and contain, in this order: `user`, `device`,
`incarnation`, `root`, `certificate`, `key_package`. The fingerprints are the
32-byte arrays of the plan, the incarnation its 16 bytes; the absence of a reference
is `null`. Members keep the canonical order of their UIDs. Integers
are serialized exactly by Rust, without passing through a JavaScript number.

The leaf indices, context / tree / commit and Welcome digests are
excluded: their final values depend on the commit being prepared and would create
a circular dependency. The engine verifies these declarations separately against
the real MLS results. The operation, nonces, recipients and references
stay authenticated by the commit; a proof re-signed for another
operation cannot reassign its original ciphertext.

This client profile is on with the `e2ee` capability since 6 October 2026. The server delivers opaque
bytes; its public validation does not prove the AAD or the MLS content. The
public proof fixtures do not claim this private validation.

## Concurrent commit and resumption

The vault verifies its pending local commit against its prepared state. A different
received successor may replace it after full validation and
confirmation. Previews, altered TLS and late application refusals
also cancel the OpenMLS mutations: they do not delete the previous outbox.
After success, a late ACK of the replaced commit does not reactivate this old fork.

The exact echo of its own preparation keeps its original state without trying
to decrypt its own PrivateMessage. The exact receipt can also be handled
by `confirm`, now valid after an already active genesis. The last historical
ACK can be repeated after interruption / expiry / revocation, without
turning this state diagnostic into an authorization to send. A new
transition again requires valid versions, pins and certificates.

Joined groups keep the tree extension configuration, needed
for the later preparation of a real GroupInfo and its public verification.

## Proofs and remaining work

Eleven scenarios use real vaults / MLS commits: rotations and identical secrets
after reopening, addition / withdrawal, approvals, reactivated nonces,
real replacement with a fresh package, proof re-signed but false context /
tree / index / author / AAD / Welcome, declared reference different from the Add,
reuse after withdrawal, application ciphertext in place of a commit,
conflict between two preparations, rollback after merge, own ACK and recovery
after a lost checkpoint. Bounds, changed receipts and stale consents are
also refused. The full suite keeps the earlier scenarios.

Eleven additional preparation scenarios go through the coordinator API,
with real vaults and commits: rotation / exact retry, addition and revoked withdrawal,
two withdrawals with one addition, reactivated nonces, approvals and spent references,
old head, renewed certificate in the real leaf, lost checkpoint,
bounds and full reference history, then rotation of a singleton at
epoch zero before admission. The full suite counts 90 passing tests,
plus the crash child executed by its parent.

The [controlled HTTP conversions](GROUP_HTTP.md) are now delivered.
Network scheduler and reconciliation of refusals remain to be integrated. This reception
targets a successor matching the observed versions; the full catch-up
of pages across membership changes, old initial Welcome, local
withdrawal / return and new incarnations remains open. The outbox and inbox of
messages, files / archives / import, Android bridge and existing interfaces,
qualifications of devices / keychains and independent review remain the
conditions of J4. No E2EE capability is enabled.
