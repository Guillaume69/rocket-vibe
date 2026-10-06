# Encrypted backup of the account root

Experimental extension of [RFC 0002](../rfcs/0002-e2ee-native.md).
Since 6 October 2026 the `e2ee` capability is on by default ([RFC 0002, Activation](../rfcs/0002-e2ee-native.md#activation-6-october-2026)). The server uses only
`rv-crypto-public`; it receives no recovery code, no private key and no MLS
state. The existing AEAD format is described in
[RECOVERY.md](../../crates/rv-crypto/RECOVERY.md).

## API and public proof

| Request | Result |
|---|---|
| `GET /api/v1/e2ee/root-backup` | Current scope and possible active package, for the authenticated account only |
| `POST /api/v1/e2ee/root-backup` | Signed publication and receipt of the accepted version |
| `GET /api/v1/e2ee/root-backup/operations/{operation}` | Original receipt of this HTTP device, even after the active package is replaced |
| `POST /api/v1/e2ee/root-backup/operations/{operation}/cancel` | Terminal outcome of the original intent: accepted or abandoned |

Reads pass the authentication / delivery barriers and are
`no-store`. A new HTTP device can download the owner's package
without already being enrolled in E2EE. This download creates no key or trust.
It gives no access to the receipts of another device.

The JSON publication contains the opaque package and an Ed25519 signature of the
root over `rocketvibe-root-backup-publication-v1`, NUL, then the compact JSON
of the body in v1 order: version, scope, operation, device, incarnation,
certificate revision, expected active version, SHA-256 of the canonical package.
Revisions are exact positive decimal strings, up to `i64::MAX`.
The package is limited to 24 KiB and the publication to 32 KiB before base64url.
Unknown fields and secret fields are refused.

A new publication requires the registered root, the same HTTP device,
its registered incarnation / revision, a valid root proof and a
recent login satisfying the account's factors. An old certificate
can authorize this root action; it permits no new MLS send.
An administrator or a bearer holder without a root key cannot forge
the proof. The quota is 64 new operations per day and device.

The root lock serializes CAS, quota and deduplication. The expected active
version must match exactly, including the initial absence; a different
concurrent publication receives `backup_revision_conflict`. The active package
and the original receipt are written in the same transaction. The same ID and
the same bytes return the same receipt; a substitution receives
`operation_conflict`. The original receipt is accessible without repeating the recent
login ceremony and during the publication throttling delay.

## Local vault and recovery

The shared coordinator binds an opaque preview to the scope, to the controller's
certificate / receipt and to the observed active version. Confirmation creates a
random recovery key and package, then saves the signed intent and the
key in the **encrypted records of the vault**, before handing control back.
The display code is never stored as a UI string. It is rendered
temporarily, only on explicit request. No status contains it.

The HTTP intent is available only after explicit confirmation that the code
is kept. After reopening, code and intent are identical. An exact receipt
settles the intent and removes its temporary key from the vault. Certificate
renewal waits for this settlement. A checkpoint failure does not return the code
before the persistence is confirmed; the retry finds the same package.

The client first rereads the original receipt. Only a positive absence permits
republishing the original intent; a network error does not allow generating
another package.

Explicit abandon is also saved before HTTP. The retry can no longer
publish the intent: it rereads its terminal outcome with the same bytes.
The server takes the same root lock as the publication. If it has already
accepted the copy, it keeps it and returns its original receipt. Otherwise, it
records a permanent tombstone; any later POST of this intent
receives `crypto_backup_cancelled`. A separate quota bounds 64 new abandons
per day and device, without hiding existing results. The abandon can
settle a historical proof without re-enrolling it or granting trust.

The abandon receipt binds scope, operation, device, incarnation / revision,
root fingerprint, package ID / digest and exact expected version. The engine
refuses a substituted result. It removes the temporary key only after
the outcome is confirmed; an acceptance does not erase the code before the
user has confirmed keeping it. A conflict can thus be abandoned
then replaced by a new, explicitly prepared intent.

Entering the code verifies AEAD, root key and expected fingerprint before any
initialization of the vault. Confirmation imports only the root into a
fresh vault, then creates a new leaf / incarnation and its add request.
An exact replay of the restoration keeps this leaf and the records created
since; a pre-existing vault without a receipt of this restoration is refused.
No old ratchet, pin, revocation, file or history is imported.
A new authorized Welcome remains necessary for each group.

A server restoration exposes its new scope while keeping the historical
active package for root recovery. It refuses the intents
and operation receipts of the old epoch.

## Qualification and next steps

The public vectors are verified by Rust and independently by Node /
OpenSSL; their opaque bytes serve for signature verification only.
The private tests use real AEAD packages. The PostgreSQL scenarios
cover concurrency / CAS, receipt after replacement, substitution / scope /
controller, recent login, quota and a lost HTTP response followed by the GET without
a second POST. Their real execution goes through the PostgreSQL CI.

The Rust / Kotlin bridge and the existing Android settings offer review,
temporary code, confirmation of the kept code, resume / abandon and entry
of the code to restore the identity of a new device. Blur, backgrounding and
account change close the handle and erase the texts of the controls.
The opaque confirmations stay in Rust and are removed on close.
The desktop core and the FFI share the same journey, tested with the real HTTP
transport and the encrypted SQLite vault.

The existing GTK / SwiftUI settings also offer review of version /
fingerprint, preparation, explicit display of the code and publication after
confirmation of the kept code, resume / abandon and restoration. The masked
entry is never automatically copied to the clipboard. Closing the view,
changing account or quitting the application erases the texts and the consents.
Renewal waits for the settlement of a backup in progress.
The new desktop wiring awaits GTK / SwiftUI qualification in CI;
the Android wiring passes the Keystore / two ABIs in 37293407753 and the
four PostgreSQL settlements pass in 37293407750.
The installed applications and the independent review remain.
The historical archive requires its own format and its own keys.
Changing the code or replacing the active package invalidates no old copy
nor its old code. No forward secrecy guarantee is announced for
this recoverable backup.
