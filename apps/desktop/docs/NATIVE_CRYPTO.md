# Native crypto in the existing desktop provider

The core `rv-core::native::crypto` now depends on `rv-crypto`, with native
HTTP. GTK and SwiftUI keep their current interfaces; the Rocket.Chat
provider and its existing E2EE engine do not change. The server still
announces `e2ee=false` and the desktop feature mask does not announce
E2EE. This experimental wiring is not an enabled user
flow.

## Account and lifecycle

`NativeSession::crypto(guard, manager, root)` explicitly attaches an already
chosen vault and a public root to the current native session. No vault,
certificate, pin or account is created by this call. It verifies instance,
generation, user and the single current device before attaching; a
mismatch refuses access before any private read.

The access clones the session's `NativeClient`: same origin and same renewed
credentials, no second autonomous connection. A fresh discovery
in the worker updates the session capabilities. A withdrawn
capability or a different server generation suspends this access.

A single live access is attached to a session generation. Its clones
share the worker and its dispatch queue. The registry and the guard hold
a weak reference to the runner; a retained view does not block its closing.
Closing the view, suspension, reconnection, end of the synchronization cycle
and shutdown stop the old access. It never becomes active again; the new
access reopens the same vault without resetting its intents or ratchets.

The guard is verified in the worker after the HTTP waits and on entry to
the owned private task, then before publication of the result. A checkpoint
write already started may finish with its lock; its late result
is retained and no following request is launched by the closed access.

## Private surface

The access exposes packages, group previews / confirmations, readmission,
sends / receipts / abandons and pages of the protected journal. No getter delivers the
raw worker, a signer, a storage key or a ratchet. The previews stay
opaque objects to be confirmed explicitly. The plaintext messages and pages are
only returned after their protected checkpoint and revalidation of the lifecycle.
Their temporary projection reuses the existing lists and composers;
they are not written to the ordinary SQLite.

The common room contract now indicates the existence of an MLS group.
This boolean, absent or false on old servers, grants no key or
admission. A crypto acceptance publishes only this metadata in the
ordinary journal, with the same global slot as the private delivery.
The existing room caches and views keep it and lock the composer,
including after an update of the room already open. An old ordinary offline send
fails with `crypto_required` before any POST, with its body
recoverable; the ordinary queue also refuses new intents in this
room. The decrypted private conversations have a separate projection.

The cross-room quotes use the existing GTK / SwiftUI menus. The
navigation carries only a selection bound to the reference, instance /
generation, membership and possible admission. The recipient re-reads the source.
QuoteReader is limited to the volatile projection of cards in ordinary
rooms; QuoteComposer is a distinct actor for their sending of private
references. Its synchronous SQL permit is ephemeral, with re-reading of the sources
and a closing guard independent of the SQL lock. No excerpt nor admission
is serialized in the ordinary queue. The parent's drafts stay
ordinary; accepted intent and erasure of the corresponding text are
atomic, without consuming the words typed during validation. Blur, navigation
or a replaced selection close the actors and invalidate the late results.

## Verifications and next steps

The `native_crypto` tests use the real `NativeSession`, its HTTP client,
its SQLite cache and MLS keys / packages actually prepared in the vault.
The external checkpoint is simulated, as in the private HTTP bench; these tests do not
qualify an installed keychain.

They cover refusal of capability / scope / ambiguous current device before the vault,
closing during HTTP before private work, real cancellation by the requester
during the checkpoint write with the lock kept, non-reactivation after reconnection,
resumption of a prepared package with exactly the same body after reopening,
withdrawn capability and replaced server generation. The access does not keep the
closed runner alive.

The GTK and SwiftUI settings now have an identity preparation
and device association section, visible only with the experimental
E2EE and device session capabilities. The keychains of both interfaces use the same
dedicated service and the same `rocket-vibe-rs/native-crypto` directory. A protected
selection, indexed by server URL / instance / epoch / user / HTTP
device, keeps the incarnation before the initialization of the vault; a closing
does not regenerate root, device key, nor pending HTTP registration.

Creating the identity is an explicit action. The controller device reviews a
signed request and displays the fingerprints of the root and of the request before a second
approval action. A new device explicitly accepts the observed root,
transmits a public request code to the controller then installs its public
approval code. No root or vault secret crosses UniFFI. The consent
stays opaque, bound to the viewer; the bridge keeps its preview with a local revision.

The installation of the grant and the exact registration body are checkpointed in
the same transaction. Resumption first reads the personal receipt and verifies all its
fields before completing the intent. An error or a lost response keeps the
original body. The registered status also requires the current certificate in
the directory and the matching local key. Certificate renewal,
replacement with revocation and the resolution of a request expired before any
acceptance remain to be wired up: this ceremony does not enable the encrypted rooms.

The existing GTK and SwiftUI profiles now offer the verification of a
participant, with the same experimental capability condition. The public
directory is authenticated and its paginated revocations are verified before display.
A consultation creates neither vault nor pin. Remembering a first contact keeps
the "unverified" status; comparing the fingerprint with the person requires a distinct
action. A root change blocks the devices and requires the old and new
fingerprints before replacement. The approval of a device
certificate keeps its opaque preview and revalidates the directory before confirmation;
it grants no MLS group admission. The pins stay in the protected
vault and an already known signed revocation does not disappear with its omission
from a later response. The revocation of the local device also stays blocking
after reopening of the vault.

A local revocation observed by another viewer also closes the live
conversation access for this same scope and incarnation, before any
following publication. The stop does not target an access of another incarnation.

`enrollment::Access::conversation()` attaches the already registered installation and
its root to the existing conversation access. Absence, an incomplete
record or an inconsistency refuses the attachment without generating an identity.
The explicit closing of this viewer also closes the conversations attached
with its guard.

The `local_group_status` read distinguishes an absent group, a pending
private transition and its accepted local receipt. It resumes the observations of the
vault without creating a group nor automatically settling the intent; a local
receipt is worth neither permission to send nor new admission. The HTTP flow
with lost ACK now verifies these three states, the reopening and the absence
of an extra POST. The seventeen MLS delivery tests pass on Windows.

The fourteen `native_crypto` scenarios pass on Windows; they now include
first contact / comparison / device, root change with stale
consent, persistent paginated revocations and local revocation after reopening.
The strict check of the core and of the FFI bridge uses caches and temporaries on D:.
The `ee3f717` profiles batch passes the nine checks of the native CI
`37199651127`, as well as the macOS compilation / packaging / launch
`37199651129`. The private library also passes strict Clippy on Windows.
Local Docker / WSL failed at startup when the system disk was full.

## Group controls in the room information

GTK and SwiftUI reuse the existing room information, under the same
experimental condition. `enrollment::Access::room()` attaches only the registered
installation; opening or refreshing the panel publishes neither
package nor transition and approves no peer. The group read exposes the
receipt and the participants of the signed plan actually verified in MLS.

The common Rust controller consults the rights, members and devices. To
create, the room must be without history and its owner must act, except
for a DM. The plan must represent each member with an approved device;
an unapproved device cannot be omitted to bypass this rule.
The selection leads to an opaque preview, with fingerprints of root and
certificate. A second action confirms its exact revision and fingerprint.
A rotation without addition or withdrawal follows the same flow; the received
admissions and updates go through the verified preview of the existing worker.

A lost response leaves the original protected intent. The panel offers
explicit resumption or abandon; resumption first consults the personal receipt,
without regenerating the commit. A closing, a room withdrawal, a new
projection or another membership version permanently invalidate the old
panel. UniFFI and the views do not rebuild a consent from JSON.
Preparing the invitation packages is an action distinct from admission.

The three new integration tests cover opening without mutation,
unapproved selection, incomplete preview refused, erroneous or stale confirmation,
real creation / rotation, lost receipt and reopening without a second POST, creation
rights and withdrawal / rejoining. The seventeen private HTTP scenarios cover
admission, catch-up and settlement. The GTK rendering of the preview is exercised in
the CI with a real dialog; the SwiftUI compilation remains required in its CI.
A locally registered group does not unlock the ordinary composer.

Remaining are renewal, the visible recovery
and revocation, the history authorized after withdrawal, the other private actions
and search, the archives / files and the qualification of the
[E2EE RFC](../../../docs/rfcs/0002-e2ee-native.md). The capability stays disabled
until the complete flow is delivered and validated.
