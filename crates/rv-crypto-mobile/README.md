# Private Android bridge

This independent workspace exposes the `rv-crypto` vault to Kotlin with
UniFFI 0.32.2. The server does not depend on this crate. The private engine keeps
its ban on `unsafe` code; the generated ABI exports stay here.

The local Expo module `apps/mobile/modules/crypto-native` uses these bindings.
Its JavaScript API exposes the public scope, a terminal handle, the storage state
and the signed public messages of the association ceremony. The foreign trait `ProtectedKeystore` does not leave Kotlin:
no Expo export reads / writes a key, a checkpoint or a protected
record. The values of this trait are bounded to 4096 bytes.

`withdrawal_action` transmits only the public values of the review,
the signed request and the receipt. The preview is bound to the terminal handle; consent,
private root and original intent stay in Rust. The existing Android settings
offer confirmation and resumption. Withdrawals stay learned after
omission / reopening, without creating a pin or a device approval.

`recovery_action` wires up root backup and restoration. The private
keys / records do not leave Rust; only the explicit temporary display and
entry of the **user recovery code** are an exception to the public
values of the UI API. This code never goes to HTTP, logs or persistent
JS storage. The handle closes / wipes its opaque previews on `stop`. The texts
of the screen are wiped on blur / background / account change.
Two bridge tests exercise a real AEAD package, consent bound to the handle,
stop / reopening, restored identity then distinct leaf registered,
and terminal abandon that does not become a publication again. Their keychain is
a stand-in; the new batch also awaits the Keystore / ABI qualification.

A non-exportable Android Keystore AES-256-GCM key wraps the small
platform records. The blobs and the vault are separated in
`noBackupFilesDir`, under 0700 directories / 0600 files. The AAD binds the blob to
its exact name. Only a confirmed absence returns `None`; existing keys
missing / unavailable, corrupted tags and ambiguous IO stay blocking.
The writes do the OS work synchronously, synchronize file and directory,
then verify the exact publication before releasing the Rust lease.

Rust 1.97 does not provide the `std::fs::File` locking methods on
Android. The engine therefore takes its same non-blocking exclusive lock through the safe
API `rustix::fs::flock` on this platform only. It remains interprocess;
a closed caller does not detach a platform write in progress from it.
[Standard library implementation](https://github.com/rust-lang/rust/blob/1.97.0/library/std/src/sys/fs/unix.rs).

The mobile provider revalidates the pinned discovery, the capabilities and the
`current` HTTP family before and after each call. A late response on
opening closes its original handle; suspension / disconnection closes all
existing views. The public fields do not join the ordinary SQL.

The local ceremony is `rv-crypto::account::Coordinator`, also used
by the desktop provider. Creating / adopting an identity is explicit; adopting
a root requires its comparison on an already associated device. A verified
preview produces an opaque consent handle bound to the native view; only
a separate confirmation issues the approval. The exact registration request
is persisted before HTTP. The runner reads its receipt before any submission and
only an understood `404 not_found` allows the original POST. Closing erases
neither this intent nor the keys. The complete directories are revalidated in Rust;
a signed local revocation is kept even if the server later omits it.
The existing mobile settings carry this flow, behind the experimental
capabilities of the server. The `ready` state of the vault remains distinct from that
of the registered identity and of the admitted MLS groups.

The existing user profiles also use the trust controls
`rv-crypto::account::peers`, with the same private `Pins` as the groups / desktop.
Consultation accepts no new root. First contact, verification
and replacement are explicit; replacement requires the exact old fingerprint
and the new one compared. The device preview keeps its consent
in Rust, bound to the signed directory and to the native handle. The signed withdrawals of an
already pinned root are remembered before refusing a stale preview and stay
blocking after omission / reopening. Only a bounded public state passes through Expo.
These controls publish no package and admit no group member.

`Ready` means **storage ready**. No identity or group is created, no
device is registered and no production E2EE mask is enabled.
Device renewal and the private actions remain to be wired up
to the shared controllers and the existing screens.

The room information, and the correspondent's profile opened from a DM,
now carry the group controls: explicit publication of packages,
creation / update (additions, withdrawals, rotation), admission / readmission and
reception of a commit, with a preview of the recipients then a distinct confirmation.
`groupAction` only accepts bounded public DTOs. The opaque consent stays
in Rust RAM; the original packet, the bundles and the MLS provider stay in
the vault. The fresh roster and the pins are re-verified at confirmation.
The signed withdrawals of correspondents are learned before a preparation or resumption.
The view is bound to the membership, the projection and the HTTP device; withdrawal / return,
suspension and account change close this view. The membership versions
of the reads projection and the grants of the MLS roster are distinct.

Resumption reads the receipt before asking the engine for its original packet. An
accepted receipt does not cause a second POST. A new submission still requires
the current right to send; an already accepted decision stays recoverable
read-only. The abandon is checkpointed before HTTP then settled according to the terminal
decision of the server. The package publications also resume through
their receipt, before retrying a possibly expired bundle. No text,
private draft or ratchet joins the ordinary SQL through this wiring.

## Build and qualification

`conversationAction` wires the existing Android list and composer to the
journal, draft and message coordinators. The pages, MLS transitions and
messages are verified then checkpointed together before projection. A viewer
is bound to the personal grant and to the private admission witness before any command;
a readmission cannot reuse an old view. Positions stay
decimal strings, including beyond JavaScript integer precision.

The transient projection comprises the prefix kept in the private cache (64
messages at most) and the pending personal intents. It joins
no ordinary message / outbox / draft table. The times exposed
are the local observations, not a certified date of the author. HTTP read /
resumption re-verify scope, directories, roster and rights. Local typing
uses only the last verified public binding: Rust still checks its
identity, its grant, its protected admission and the clock, without HTTP nor a new
recipient. These writes are serialized and their handle becomes terminal
with the session; they allow no submission to the server.

Sends are prepared before HTTP, resume through a receipt GET and POST
the original only after an understood `404 not_found` and a fresh right to send. An
uncertain result keeps the same ciphertext. The abandon is checkpointed before
HTTP; its document stays recoverable in an empty draft. The projection is
disposed on blur, on suspension and on closing of the runner, without smoothing of the
plaintext. The opaque journal is polled on opening, on resumption, after
actions and every ten seconds when the view is active / online.

The two-actor Rust flows cover reopening of the original, cancellation,
rotation received through the journal, distinct drafts, altered page without progress,
exact positions and signed withdrawal persistent after omission. The Android
instrumentation exercises the real Keystore / ABI / vault, with private drafts and
messages, reopening and substituted receipt; its receipts are synthetic. This does not
yet qualify the full flow of the installed application against HTTP.
Threads use the existing screen, a projection of root / replies in
the same private journal and a draft distinct from the room's. The counters are
those of the retained replies; an evicted root or one coming from another grant
does not allow preparing a new send. The two-actor Rust flows and
the Android instrumentation also exercise a real MLS reply after reopening,
its root, the counters and the refusal of a nested thread. The Android receipts remain
synthetic; the installed GUI and HTTP qualifications remain distinct.
Quotes use the existing Android menus and composers. Selection
bound to the scope, the membership and the admission; the bridge verifies the retained source
and its exact position before preparing an MLS document containing only
the references. Root sources and thread replies come from the same private
journal. Volatile resolution per room, two levels, bounded cycles; withdrawal,
blur and suspension wipe the previews. A quote alone keeps its original
packet after reopening, including if the source later becomes unavailable.
The two-actor Rust and Android Keystore / ABI tests exercise this resumption
and the MLS reception; their receipts remain synthetic. The JS tests also cover
the refusal of a stale selection, withdrawn source and HTTP resumption without
a second POST. The ordinary SQL queue refuses the private selections.
Composition also accepts ordinary sources: the runner re-reads them
in its authorized cache and provides only the exact membership and references.
Rust verifies scope / match / bounds and refuses to classify a registered protected
group as an ordinary source. The private selections keep their
admission and position check in the vault. The ordinary witnesses
come from the adapter's authenticated cache, without an MLS author signature.
The two-actor and Android tests exercise mixed send, missing witness, refusal
of downgrade and reception of the same original after reopening. The choice of
destination is in the existing action sheet, with no automatic send.
Private cards in ordinary rooms, other actions / search, archive and files remain
open, as do the physical qualification and the review. No mask enabled.

Prerequisites: Rust 1.97, targets `aarch64-linux-android` and `x86_64-linux-android`,
Node 24, JDK 17 and NDK 27.1.12297006. The module's `preBuild` launches
`build-android.mjs` for the requested ABIs, generates the bindings from the real
library, then integrates them into the Kotlin sources / `jniLibs`. The `.so` files are
aligned to 16 KiB; the generated files stay in `android/build/`.
[Android page compatibility](https://developer.android.com/guide/practices/page-sizes),
[Keystore](https://developer.android.com/privacy-and-security/keystore).

```sh
cargo test --locked --manifest-path crates/rv-crypto-mobile/Cargo.toml --lib
cd apps/mobile/android
./gradlew :crypto-native:connectedDebugAndroidTest
```

The Android tests use an isolated test APK and a random scope,
never a user account. They cover the real Keystore / ABI / vault,
original reopening, corruption, copy, withdrawal and lease retained after
closing during a write, and the real ceremony of creation / preview /
approval / registration / reopening with refusal of a substituted receipt.
The dedicated CI builds both ABIs and runs
these tests on an emulator. The JS tests also cover the existing mobile runner,
the identity / device change, the disabled capabilities and the late
results, exact pagination beyond 2^53 and lost HTTP response without a second POST.
The Rust bridge test associates two real devices and remembers their revocation.
Two other scenarios verify first contact / comparison / replacement,
device consent and withdrawal of a correspondent. The fourth Android test
associates two identities through the real engine and verifies the reopening of the pins /
approvals in the Keystore. The JS tests verify the guards on public
requests and the refusal of a consent for another user.
The emulator does not qualify the hardware, power cuts or
the complete E2EE flow in an installed application.

The seventh Rust test exercises two real MLS actors: packages, creation,
Welcome, rotation, commit, reopening of the original packet, refusal of a substituted
receipt / changed grant and abandon settlement. The fifth Android test
exercises creation / rotation / original packet after reopening and abandon on
the real Keystore / ABI. The receipts of these two private benches are synthetic;
they do not replace a qualification against the real HTTP server.
Four JS regressions qualify HTTP routing, lost response without a second
POST, original publication, read-only and closing after a device change /
withdrawal from the room. Mobile conversations, iOS and installed GUI remain open.
