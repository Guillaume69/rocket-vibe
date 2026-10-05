# Native E2EE directory (first J4 delivery batch)

This batch publishes **public** proofs. It does not yet allow encrypted sending,
group creation or Welcome delivery. `capabilities.e2ee` stays false.
The existing interfaces and the Rocket.Chat provider are kept.

| Authenticated route | Result |
|---|---|
| `POST /api/v1/e2ee/devices` | Registration / renewal / conditional replacement of the certificate of the current session device |
| `POST /api/v1/e2ee/revocations` | Removal signed by the root, closure of the targeted HTTP family and original receipt of the controller |
| `POST /api/v1/e2ee/key-packages` | Verification and atomic publication of 1-8 MLS TLS KeyPackages |
| `GET /api/v1/e2ee/users/{user}?after={position}` | Public root, active devices and page of signed revocations |
| `GET /api/v1/e2ee/operations/{operation}` | Original receipt of the current account and device |

Blobs use unpadded base64url; `request`, `grant`, `certificate`,
`root` and `signed` contain the signed JSON formats of `rv-crypto-public`.
KeyPackages contain the OpenMLS 0.9.0 TLS serialization, suite 0x0001.
Revision and position strings are exact decimals, never JavaScript
numbers. Decoding the DTO does not verify its signatures or its trust.

For the authenticated owner, the directory also keeps the expired
certificates of the devices whose HTTP session is still active. These historical
proofs make it possible to display the expiry and to renew / remove
the precise incarnation. Correspondents receive only the currently
valid certificates; a historical proof does not permit a new MLS send.

## Registration

The client keeps the intent and its `operation_id` before HTTP. The
instance / `data_epoch` scope must match the database under lock. The server
verifies the request signed by the leaf, the grant and the certificate signed by
the root, and their exact binding to the UID and the current `session_device`.
The first registration requires the expected revisions to be absent; later ones
require the root fingerprint and the device revision observed.

The account root does not change through this API. A renewed HTTP session
keeps its device. A fresh login creates another device; its certificate
requires the approval of the same root. The server provides neither this approval
nor a private key. The first registration remains a TOFU bootstrap: a
bearer stolen before it can install another root. Pins and
out-of-band verification remain mandatory on the correspondent side.

Renewal keeps incarnation and key and does not decrease the dates of the
certificate. Replacing the incarnation requires a revocation of the old one signed
by the root. This revocation stays in the database; the old packages are
removed and their references never become available again by publication.
A changed root, a stale confirmation or a revoked incarnation is
explicitly refused. Root rotation remains to be integrated; this route
does not replace the independent removal below.

## Independent removal

`RevokeDevice` carries the scope, the original ID, the revision / incarnation of the
registered controller and a `Revocation` signed by the root. The signature
designates the device and the incarnation to remove; it must match the
current root of the HTTP account. A recent login with the currently
required factors is necessary to accept a new operation.
A substituted root / revision / incarnation is refused. The expiry of the
controller's certificate does not remove its root authority; its HTTP
device and its enrollment must still exist, with no known signed removal.

The account is serialized before the position of the removal is assigned. Signed
proof, removal of the packages and deletion of the HTTP family are in the
same commit as the receipt. An old incarnation does not delete the family
of a replaced incarnation. An already disconnected device can still receive
its permanent removal; reissuing the same removal does not duplicate it.
The controller cannot remove its own current incarnation through this
route, in order to keep access to the receipt after a lost response.

The `OperationReceipt` of type `revoke_device` describes the issuing controller,
with an empty `key_package_refs`. `GET /operations/{operation}` finds this result
without a new send and an exact replay remains readable after the
reauthentication window. An ID reused with another removal is refused.
This transport provides no consent or private key. The protected
coordinator signs after confirmation of the exact preview and saves the removal
with its original request before publication. It also memorizes the removals
received for the local identity already established. Later omission, reopening or
a late first explicit pin do not reauthorize the incarnation. No pin or
device agreement is created implicitly. Renewal of the controller
waits for the settlement of the pending removal. The three existing interfaces
offer confirmation and resume; their CI / installed qualification remains
distinct. The groups concerned await their MLS removal commit before
resuming. Revoking a leaf does not remove a compromised root.

## Packages and receipts

OpenMLS effectively validates TLS, signatures and lifetime; the server
additionally verifies the certificate and the leaf key, the active device, its revision
and its root. A reference is the RFC 9420 `KeyPackageRef`, and a distinct TLS
SHA-256 keeps the integrity of the publication. The experimental
[groups](E2EE_GROUPS.md) protocol then consumes the references with their transition,
without reservation by a simple read.

An identical operation finds its receipt before a new crypto
verification, even if the certificate has expired since. This receipt describes the past
operation and reactivates no key. Reusing the ID with another intent is refused.
Receipts and mutation are in the same PostgreSQL commit. Logout / deletion of the
HTTP family removes the certificate and the bytes of the packages, while keeping
the removed references. A restoration / new generation refuses the
old intents and receipts; the complete J5 restoration procedure must
still revoke the sessions and reconcile the client states.

Limits: four crypto workers owned per process, including after HTTP
abandon; 16 KiB TLS per package, 64 available packages per device, 256 new
operations per day and device; 64 devices and 128 revocations per page.
Package requests are bounded to 256 KiB; the others to 64 KiB. A refused
batch leaves neither partial packages nor a receipt. A `429` keeps `Retry-After`;
the SDKs let receipts be consulted during the delay. Reads are private,
`no-store`, and subject to the server's delivery barriers.

## Next steps of the batch

The delivery of the encrypted and signed root package has a
[separate contract](E2EE_ROOT_BACKUPS.md). It carries no recovery code.

Signed recipient / membership list, single consumption bound to the commit,
order / CAS and targeted Welcomes are implemented in the [groups](E2EE_GROUPS.md) batch.
Their verification, durable outbox and local admission are wired to the
existing GTK / SwiftUI / Android screens. Installed qualification, recoverable
history, private files / actions and dedicated review remain open. Private keys and the
recovery secret must never enter this server protocol.
