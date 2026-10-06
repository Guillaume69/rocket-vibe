# RocketVibe native server workstream

Launch date: 30 September 2026. Branch: `feature/rocketvibe-server`.
Destination: [RFC 0001](rfcs/0001-rocketvibe-rust-server.md).

## Summary status as of 5 October 2026

History recovery path B ([E2EE_HISTORY_BACKUP.md](protocol/E2EE_HISTORY_BACKUP.md)),
on the user's decisions of 5 October 2026: a separate `rvh1-` history code and continuous
upload. A 32-byte history key per generation, sealed under the code key in a package
published by a device signature with compare-and-swap, lost-response recovery and
cancellation like the identity backup; other devices join with the code. Every device
holding the key uploads its own verified journal archive per period as history records
under period secrets derived from the key, with signed growing checkpoints, after each
private conversation refresh (at most every 10 minutes) or on demand. A blank device
restores with the code alone into the recovered catalog, which now shows each period up
to its last verified checkpoint and each position once across sources. Server migration
0046 and routes, rv-client, desktop worker, mobile bridge and adapter, and the settings
blocks in GTK, SwiftUI and Android. Tests: engine (code, package, ceremony, continuous
upload, growth, import, refusals, dedup), two PostgreSQL tests, a desktop worker test, a
bridge test and adapter tests. A path A share now carries the sharing device's history key
in its envelope (kept by a device holding none), and a public vector of the code,
package, publication, checkpoint and records is verified by Rust and by a Node/OpenSSL
script sharing its written-out primitives with the path A verifier. Remaining:
installed qualification.

History recovery on a new device, path A (item 2 of the E2EE plan,
[E2EE_HISTORY.md](protocol/E2EE_HISTORY.md)), private engine, public vector and
server done. Archive v1 packets require the archiving device to share the
author's root, so shared history travels as **history records**: the archive
header and the author's original certificate, attested by the sharing device under
its own domains, sealed with XChaCha20-Poly1305 under a key and nonce derived from
the period secret and the document's rank. The coordinator drives both sides with
jobs kept in the vault (deterministic pages from the journal archive, uploaded
progress, a signed share drawn once; ordered import into a recovered catalog shown
per complete period). Membership versions in archive headers are now opaque
identifiers, as the server issues UUIDs. A public vector (Alice's desktop shares
two of Bob's messages with Alice's phone) is checked by `rv-crypto-public`, reopened
by `rv-crypto`, and redone by a Node/OpenSSL script with HPKE, DeriveKeyPair and
HChaCha20 written out; CI runs the three Node verifiers. The server keeps
requests, claimed shares and records in migration 0045 with the checks of the
specification (registered certificate byte for byte, attestation by the uploading
device, readable room, contiguous ranks, commit against count / bounds / chain,
download by the requesting device only, quotas, expiry by maintenance). The 200
`rv-crypto` tests and the 2 new PostgreSQL tests pass. The shared adapter
step `rv_crypto::account::history` trusts a request or share only from another
device listed in the verified account directory (same root, device, incarnation
and leaf key, never revoked) and drives both jobs from wire values; the desktop
runs it in `rv-core` (request, offers, preview, approve, upload / commit with
abandonment on 404 or a share claimed elsewhere, import page by page and
acknowledgement, including acknowledgements lost earlier). Two account tests and
a desktop test against a mock history server pass, with the 226 + desktop
workspace tests. The FFI / mobile bridge and the GTK / SwiftUI / Android approval
and import screens remain open, then path B (archive-key backup with a recovery
code).

Operation registry window: the 8,192 identities no longer stop a long
conversation. Once a body has left the cache (evicted, retired or forgotten on
request), its identity gets a release order; a full registry drops the oldest
released identities first. A dropped received message stays refused by its stream
position, a dropped own operation ID by the server's unique `(user_id,
operation_id)`. Pending, cancelling, cancelled and cached identities stay. With a
registry of 40 in tests, the new bench sends 60 messages, reads an evicted body
still registered back from the index and refuses the replay of a dropped one. The
192 `rv-crypto` tests pass in 144.58 s and the 11 mobile bridge tests in 63.97 s.
Item 1 of the E2EE plan (durable history) is complete; a metadata index for thread
counters / quote sources and load qualification remain open.

Hot-cache eviction: the protected message registry no longer stops receiving at 64
bodies. Before a new body enters a full cache, the oldest settled bodies leave it:
a retired admission's, or one already held by the verified journal index of its
room's current admission. Own pending, cancelling or cancelled intents stay. An
evicted identity keeps its fingerprints and an `evicted` / `retired` marker; a
replay of the exact receipt reads the body back from the index without a new
decryption, and a forged receipt is refused. `journal_sources` reads the same
index, so quote sources cover the whole verified history. With the cache reduced
to 16 in tests, the new bench sends 30 messages through journal pages without
`forget_message`; the 191 `rv-crypto` tests pass in 161.61 s, the 11 mobile bridge
tests in 69.04 s, the desktop workspace tests, and the HTTP worker against
PostgreSQL in 58.54 s. The 8,192 operation registry, portable keys / transport,
a metadata index for thread counters / sources and load remain open.

This batch follows the merge of master (English names, desktop 0.7.0, slash
commands) and the translation of these documents into English.

Archive reading is wired to the shared desktop / Android conversation
projections: a separate index of verified journal pages only, older pages,
thread roots / counters, and resumption of the last page after the cache is
forgotten. Admission outside the projection is removed, the old protected cache
is migrated, and a separate observation is refused even after the cursor
advances. The 15 journal tests pass in 113.26 s, including 70 messages after
forgetting both caches and reopening. Strict Clippy passes; the HTTP worker
passes in 1.94 s after the cache is forgotten, with lost response / resumption
and refusal of a wrong room path. Automatic eviction of the 64 cache, quote
sources outside the cache, the 8,192 operation registry, portable keys /
transport and load remain open.

Pause requested by the user at the end of this batch. No following batch will be
started before the goal is explicitly resumed. The pause does not close the RFC:
J4 remains open for portable history / files / other actions / search,
destruction of old keys and control delegation; installed qualification,
external services / independent review and J5 import / operations remain open.

Local observation catalog: each MLS reception now keeps its document and its
original proof in an encrypted block, anchored with the ratchet / cursor in the
same checkpoint. Reading by membership, pages of 1 to 200 and search for older
positions by jumps; reversed personal echoes are kept and sorted. The three
catalog tests pass in 130.85 s, including the 130-message bench after the cache
is forgotten, rollback and author removal. The 15 reception tests pass in
189.94 s and the 13 older journal tests in 39.47 s. The wiring of the readers is
extended by the batch above; no automatic cache eviction is performed yet.

Archive storage, durable foundation: immutable encrypted blocks in the same
database as MLS, a reference bound to the full scope / ciphertext, and a commit
shared with the protected records. The return waits for the keychain checkpoint.
The bench writes 70 blocks / 17.5 MiB, reopens and reads after the 64th without
growing the main snapshot. Five new tests pass in 8.93 s; the eight protected
storage tests in 1.34 s and the five older vault tests in 2.93 s. Strict Clippy
passes. The local catalog / pagination is extended by the batch above; admission
of portable packages, keys / transport and readers remain to be wired.

The desktop recovery wiring now has its nine native jobs green in 37297575738,
including the GTK test under Xvfb
`identity_settings_render_existing_preferences_and_clear_on_close`. Its macOS /
Android CI runs are also green. The archive format passes Android in
37300711594 and its nine native jobs in 37300711657. The durable storage passes
Android in 37303389634 and its nine native jobs in 37303389587. The observation
catalog fefd0cf has its CI runs 37308165390 / 37308165478 in progress.

Archive, first format: signed immutable package, OS key per document and an AEAD
distinct from MLS, binding to the original receipt / certificate / membership,
exact positions and revisions as strings. A renewed leaf of the same root can
archive an observed original without modifying its proof; another root is
refused. Five private tests pass in 0.07 s and Node/OpenSSL verifies the public
vector. The receipts are synthetic; admission, full storage / transport,
key envelopes / backups and readers are not wired yet. The 64-document cache
remains that of the current interfaces. The format and its limits are in
[the archive policy](protocol/E2EE_ARCHIVE.md).

The macOS app of the desktop recovery wiring passes compilation / startup in
37297575743; the Swift models pass in job 111722379266 of 37297575738. Android /
Keystore / two ABIs pass in 37297575854. The last GTK job of this CI is still
running. The previous batch 993db76 has its nine native jobs and its macOS /
Android CI runs green.

The native CI of this branch now keeps the bench that is already active and
queues the new batch, instead of cancelling the cache tests / backups on push.
The independent macOS workflow can start immediately. The group and the suites
remain the same; the other branches keep their policy.

Desktop recovery: the existing GTK / SwiftUI settings now offer review of the
version / fingerprint, preparation, explicit display of the code, confirmation of
the kept code, resumption / abandonment and restoration of a new device. The
renewal controls wait for the settlement of a backup. Closing the view or
quitting the application clears the input, output and opaque confirmations; late
results can no longer redisplay them. Switching the FFI view also removes the
Rust confirmation and its temporary key. Strict Clippy core / FFI passes
locally. Two Swift regressions and a GTK flow under Xvfb are added; their
compilation / execution await the next CI. Qualification of the installed
applications remains open.

Backup settlement and Android recovery: the server serializes publication /
abandonment under the same lock. An original already accepted stays accepted;
otherwise a tombstone prevents its future publication. The vault keeps the
abandonment phase before output, then resumes only that intent. The eight engine
recovery flows pass in 1.69 s. The Android bridge binds consents to the handle,
reserves the code for its explicit view / input, and recovers a real root and
then a distinct leaf; its two new tests pass in 4.38 s. The existing Android
settings offer review, temporary code / confirmation, resumption / abandonment
and restoration. Three adapter tests prove absence of the code over HTTP, a lost
response resumed by GET, and a closure that forbids confirmation; with the
vectors / HTTP, seven tests pass in 224 ms. Typecheck and targeted lint pass.
The desktop core / FFI are wired to the same flow; their 25 HTTP / SQLite tests
pass in 52.32 s, including a new HTTP device, a distinct key, confirmation
refused on another handle, closure during checkpoint and terminal resumption.
Strict Clippy engine / bridge / server / core / FFI passes and the real Swift
binding exposes `recoveryAction`. The four PostgreSQL settlement scenarios pass
in job 111708955661 of 37293407750: the server passes its 179 tests in 134.73 s,
with an external bench ignored and run separately. The Android CI 37293407753
passes the real Keystore / two ABIs, and the macOS app 37293407507 passes
compilation and startup. The last GTK / Swift model jobs of the batch are still
running; the new desktop controls are qualified in the batch above.
No production mask is enabled.

The full mobile bridge suite passes its 11 tests in 66.99 s. The real Windows
libraries produce the Kotlin and Swift bindings with `recoveryAction`.

Root backup: signed opaque public format, server storage of the active version
with CAS, distinct original receipts and Rust / mobile transports added. The
shared coordinator protects package / key / intent before output, requires the
kept code before HTTP, settles the exact receipt and then erases the temporary
key. An old preview or a server version omitted / regressed after confirmation
are refused. Restoration validates the code before creating the vault, imports
only the root, creates a new leaf and keeps that leaf / the later records on an
exact resumption. The 170 engine tests pass in 167.98 s, with an ignored HTTP
bench run separately in CI; the five recovery flows pass in 1.64 s after the
protection of previews and the refusal of a delegated device without a root.
Twelve transport / OpenSSL tests pass in 219 ms, mobile typecheck / lint and
strict Clippy engine / server pass. The public vector, the DTOs and six server
scenarios are added, including five PostgreSQL / HTTP ones that pass in job
111684333233: the server passes 175 tests in 242.97 s. The nine native jobs of
37285805413 and the real Keystore / two ABIs of 37285805414 are green.
Settlement and the clients are extended by the batch above; no production
capability is enabled. Details:
[backup contract](protocol/E2EE_ROOT_BACKUPS.md).

Signed removal wired to the protected coordinator and to the existing Android /
GTK / SwiftUI settings: preview bound to the certificate / incarnation /
revision, explicit confirmation, permanent proof and original intent saved before
HTTP, receipt bound to the controller and resumption without a second POST after
a lost response. Local removal immediately blocks the device; a later omission
from the directory, even before a first explicit pin, does not reauthorize it.
No pin or device agreement is created implicitly. Renewal of the controller
waits for the settlement of its removal request. The 148 engine tests pass in
165.75 seconds; the 21 HTTP / MLS / SQLite flows of the desktop core pass in
49.67 seconds, including closure during the checkpoint without sending and
resumption of the receipt after reopening. The nine mobile bridge tests pass in
61.22 seconds; 14 adapter flows pass in 191 ms. Mobile typecheck / lint and
strict Clippy bridge / core / FFI pass; real Swift and Kotlin bindings
generated. Server / GTK and real Android Keystore / two ABIs pass in
37268312083 and 37268312069. SwiftUI compilation found an expression that was
too large in the settings; split into components in `0cc02ff`, validated by the
macOS build / startup of 37281102690. The nine native jobs of 37281102685 are
also green. Installed qualification, visible recovery, archive policy after
removal and independent review remain open; production E2EE stays disabled.

Signed E2EE removal transport added to the contract / server and to the Rust /
TypeScript HTTP SDKs: proof of current root, registered controller, recent login
/ factors, original receipt, HTTP family and targeted packages removed
atomically. An old incarnation does not close its replacement; a removal can
still be published after the target's HTTP disconnection. The owner now sees
their expired certificates so that they can renew them; correspondents keep the
list of valid certificates. The contract keeps the exact revisions and refuses
private fields. The public vector is verified independently by Node / OpenSSL
and Rust; the Rust test passes in 0.02 second. Nine mobile transport tests,
typecheck / lint and strict Clippy server pass locally. Five PostgreSQL / HTTP
scenarios pass: removal / packages / receipt, forgery / admin / scope / stale
controller, a really replaced incarnation, a lost response observed by the SDK
without a second POST and a really expired certificate renewed via HTTP. The
nine native jobs of 37261684546 and the real Android Keystore / two ABIs of
37261684547 are green. The server job passes 169 tests in 227.51 seconds. The
wiring of the clients is extended by the batch above; no production E2EE mask is
enabled.

Explicit replacement of renewed peers wired to the existing Android / GTK /
SwiftUI controls: a certificate different from the MLS leaf becomes selectable
with "Remplacer et réinviter", which pairs removal and addition. A simple
removal adds nobody; a changed view certificate and an unapproved peer are
refused. The engine test renews two already expired certificates, refuses to
keep the expired peer / to add it without removal, then validates a real
readmission Welcome and MLS messages in both directions in 2.60 seconds. The 19
HTTP / MLS / SQLite flows of the desktop core pass in 46.15 seconds, including
eligibility, absence of fetch without removal, new certificate, lost response
and resumption without a second POST. Fifteen mobile adapter tests pass in
190 ms; typecheck, targeted lint and strict Clippy engine / core / FFI pass. The
separate HTTP / PostgreSQL bench is extended by renewal of both devices,
replacement, Welcome, reopening and two new messages; its real execution passes
in 39.19 seconds in the HTTP job of 37259435801. macOS build / startup in
37259435833 and real Keystore / two Android ABIs in 37259435774 pass; the nine
jobs of the native CI, including the GTK flows, are also green. Its 90-second
limit is kept. The new admission removes the old cache:
historical archive / recovery, installed qualification and independent review
remain open. No production E2EE mask is enabled.

Rotation after renewal wired to the current room controls: Android / GTK /
SwiftUI flag the certificate to refresh from the MLS leaf verified in the vault.
The new send is refused before the explicit transition. An accepted receipt
recovered after a lost response does not skip the old epoch: the journal applies
the commit at its exact position. The new desktop HTTP / MLS / SQLite flow
passes in 22.20 seconds and keeps history / draft, refuses the old preview,
resumes without a second POST and then sends with the new leaf / epoch. The
two-actor flow of the Rust mobile bridge passes in 20.27 seconds; its second
actor receives the renewed commit, with synthetic receipts. The shared engine
passes its real-leaf test in 1.43 seconds; 21 mobile adapter tests and the
typecheck pass. The three CI runs of d1e032a are green: nine native jobs in
37257228014, macOS build / startup in 37257227947 and real Keystore / two
Android ABIs in 37257227983. The replacement of already expired peer leaves is
extended by the batch above; installed flows remain open.
The full desktop suite passes its 18 HTTP / MLS / SQLite flows in
53.39 seconds; the eight mobile bridge tests pass in 56.09 seconds.
Strict Clippy engine / bridge / core / FFI and targeted mobile lint pass.
The real FFI library is rebuilt in 1 min 57 s and its regenerated Swift
bindings expose the native boolean expected by the existing interface.
GTK and SwiftUI compilation / execution for this batch are confirmed by these
CI runs; GTK is not built on Windows.

Explicit renewal of device certificates is wired into the shared vault and the
existing Android / GTK / SwiftUI settings. The due date, the expiration, the
request to approve and the resumption of the original registration are visible;
identity, incarnation, signature and vault selection are kept. The three
coordinator tests pass in 2.20 seconds, notably a second expired device
approved by the existing controller. The 17 desktop HTTP / MLS / SQLite flows
pass in 46.35 seconds; the new flow stops the old workers and recovers a lost
response without a second POST. The eight mobile bridge tests pass in
56.69 seconds; the new TypeScript adapter also covers lost response and invalid
due date. The shutdown of two views sharing the worker is revalidated in
1.92 seconds. Typecheck and strict Clippy pass. The real Swift bindings are
regenerated in 1 min 31 s; the real Kotlin bridge is built / generated in
14.85 seconds. The three CI runs of b447d48 are green: nine native jobs in
37254983507, macOS build / startup in 37254983469 and real Keystore / two
Android ABIs in 37254983516. The rotation after renewal is extended by the batch
above; installed flows and replacement of expired peer leaves remain open.
Production E2EE stays disabled.

Text conversations, threads and private quotes wired to the existing
GTK / SwiftUI / Android interfaces: reading of the journal kept in the vault,
exact positions, separate drafts, sending and resumption of the original
ciphertext. Local and CI qualifications are distinguished below; the Android
quotes and the mixed composition pass the local validations detailed below.
The dates are local observations, not certified author dates. The readers of
private cards in the ordinary desktop rooms / threads are validated by the nine
jobs of the native CI and the macOS build / startup of 10f3005. The cross-room
selection and the composition of private references in the ordinary desktop
rooms are wired and pass the nine native jobs of 41cb92c as well as the macOS
build / startup. Full archives, editing / actions,
search and private files
remain to be delivered, as do visible recovery /
revocation and installed qualification. No production E2EE mask
is enabled.

Android foundation added: Kotlin / Rust Expo module in the existing app, private
vault and small platform records wrapped by Android Keystore, ARM64 / x86-64
build and access bound to the current HTTP account / device. Opening without
implicit initialization, terminal closure after suspension / scope change and a
late result refused. The two instrumentation tests of the real Keystore / ABI /
vault pass on the API 36.1 emulator; they include holding the OS lock during a
write whose caller was closed. The 1,282 mobile tests and the typecheck pass.
This proof concerns storage and its session lifecycle; association, groups,
messages and physical Android qualification remain open.
[Bridge details](../crates/rv-crypto-mobile/README.md).

Android association then wired into the existing settings: the local ceremony is
now shared by the desktop and the native bridge (`rv-crypto::account`). Explicit
creation, root comparison on another device, public request, distinct preview /
consent, approval and original record protected before HTTP. Resumption consults
the receipt and does not repeat an already accepted POST. The signed revocation
of the device is remembered despite a later omission. Four Rust bridge tests
pass, including a two-device association; the three Android tests pass on the
real Keystore / ABI, including the ceremony and its reopening with refusal of a
substituted receipt. The 1,285 mobile tests, typecheck, lint and the sixteen
crypto flows of the desktop core pass. Both ABIs compile.
The installed GUI flow, mobile groups / conversations, iOS and physical
qualification remain open. Production E2EE stays disabled.

Android trust controls added in the current user cards: first unverified
contact, explicit comparison, old fingerprint retained on a root change,
controlled replacement and preview / approval of devices kept separate. Viewing
does not create a pin; only signed removals of an already known root are learned
implicitly. The consents stay opaque and bound to the native view / full
directory. The six Rust bridge tests, four real Android instrumentations and
1,286 mobile tests pass; typecheck / lint and strict Clippy of the engine pass.
Both ABIs compile. Mobile groups / conversations and installed GUI
qualification remain open.

Android groups wired into the room information and the DM card: explicit
packages, creation, additions / removals / rotation and admission /
readmission / received commit, with a recipient preview followed by a separate
confirmation. The bridge uses the existing MLS coordinators / conversions,
without a second HTTP client. Opaque consent kept in Rust; durable original
before HTTP and resumption by receipt without a second POST. An abandonment is
checkpointed before its request. The fresh roster, the signed removals of peers,
the right to send and the membership / projection are revalidated. An already
accepted receipt remains recoverable read-only. Seven Rust tests pass, including
two MLS actors; five real Android tests pass, including creation / rotation /
original reopening and abandonment. The receipts of these private tests are
synthetic. The 1,291 mobile tests, typecheck / lint, strict Clippy and both ABIs
pass; the Hermes export passes too. Mobile conversations, iOS and the complete
GUI flow remain open.

Android text conversations wired to the existing list and composer: private
projection of the retained journal, exact order in decimal strings, drafts per
thread / grant / admission and local save on every keystroke. The opaque journal
is caught up on opening, on resumption and every ten seconds when the view is
active; no text, draft or private package reaches the ordinary SQL. Resumption
by receipt before the original POST, abandonment checkpointed before HTTP and
restoration of an abandoned document into an empty draft. A change of admission,
removal or closure of the runner closes the view; the projection is not smoothed
after closure. The displayed times are the local observations; the window is the
retained private cache (64 messages), not a full archive. The 1,297 mobile tests
pass, as do typecheck / lint. Eight Rust bridge tests and five Android
instrumentations pass; the latter use the real Keystore / ABI and now cover
private drafts / messages, reopened original and substituted receipt. Their
receipts remain synthetic. Visible threads, quotes / actions / search, archives
and private files remain open, as do trials of the installed applications and
physical qualification. No E2EE mask enabled. iOS delivery is outside the scope
of RFC 0001.

Private threads then wired to the existing Android / GTK / SwiftUI screens:
root and replies from the same verified prefix, draft specific to the thread and
sending / resumption of the original ciphertext. The root is bounded to the same
scope, grant and admission; a reply does not become the root of a nested thread.
Root absent from the vault: available replies readable, new send refused, with
no fallback to ordinary SQL. The counters indicate the retained replies, not the
full archive. GTK closes the projection on leaving the view; Android reuses its
focus / suspension cycle and the existing membership bound.
The 1,299 mobile tests, typecheck / lint and Hermes export pass. The eight Rust
bridge tests also cover a real two-actor MLS reply; the 155 engine tests pass
(one crash child deliberately ignored, one unchanged long retention test not
replayed). The desktop HTTP / MLS / SQLite flow verifies root, separate drafts,
lost response / restart without a second POST, counters and removal. Strict
Clippy engine / bridge / core / FFI passes. Both Android ABIs compile and the
five real Keystore / ABI tests pass, with a reopened thread reply and private
counter; synthetic receipts.
Compilation of the GTK / SwiftUI interfaces confirmed by the CI runs of
`8356206`; installed GUI, archive, quotes / actions / search and files remain
open. No production E2EE mask enabled.

Private quotes are then wired to the existing GTK and SwiftUI menus / banners /
composers: root source or thread reply, quote alone, selection bound to the
instance / generation, membership and admission, then an MLS document containing
only the references. Resolution per room in the retained vault, re-reading of
admissions before exposure, two levels, cycles bounded per room / message and
1,024 Unicode characters per excerpt. An inaccessible parent reveals no child.
The entire private window is rebuilt to purge old cards after a source is
removed. The HTTP / MLS / SQLite bench verifies quote alone, stale selection
refused, lost response / reopening and GET receipt without a second POST. The 16
desktop crypto flows pass; the 155 engine tests pass (one crash child ignored,
the unchanged long retention test not replayed). The card test covers Unicode,
depth, cycles and removed source; strict Clippy core / FFI passes, as do the DLL
build and the local generation of the Swift bindings. GTK / SwiftUI compilation
to be confirmed by the CI of this new batch. Android quotes, sources mixing
plain / encrypted, private edit revisions, quoted files, full archives and the
installed GUI flow remain open. No production E2EE mask enabled.

Android quotes wired into the same menus, banners and composers: private root or
reply source, quote alone, selection bound to the scope / membership / admission
and MLS document carrying only the references. Resolution of the cards in the
vault per room, two levels and bounded cycles; removed sources reveal neither
excerpt nor descendants. The actions sheet avoids ordinary SQL and navigation
with a private body. The preview is rebuilt after returning to the composer,
cleared on blur / suspension, and late results do not restore a replaced or
cancelled selection. The SQL queue refuses any private selection. The 1,302
mobile tests pass, plus the three new banner lifecycle scenarios; typecheck,
lint and Hermes pass. The eight Rust bridge tests include an MLS quote alone
between two actors, thread source, stale selection refused and original package
reopened. Strict Clippy bridge / core passes. Both Android ABIs compile and the
five instrumentations of the real Keystore / ABI pass, including quote alone and
reopening; their receipts are synthetic. The 16 desktop HTTP / MLS / SQLite
flows pass after fixing the test server: periodic keepalive of its socket to
avoid an artificial closure at 45 seconds on a slow runner.
The Linux CI of the desktop batch `9884ce2` passes; the Windows CI revealed this
silent simulation. The macOS build / packaging / startup passes on this same
commit; the artifact upload failed on a GitHub timeout and is rerun.
The CI of the current batch remains to be confirmed. Mixed sources, other
actions / search, private archives / files, independent review and installed GUI
qualification remain open. No production E2EE mask enabled.

Mixed reading added to the GTK / SwiftUI / Android private cards: retained vault
sources and plaintext excerpts already kept, with generation /
membership / unencrypted status verified, descendants rebuilt without copying
private plaintext into SQLite and re-reading before exposure. Editing refreshes
the excerpt; removal, old membership and the source room switching to encrypted
mode hide it. The desktop SDK / UniFFI also selects an ordinary source for an
MLS send containing only its references; removing the admission of a private
selection does not bypass its validation. The HTTP / MLS / SQLite bench verifies
a quote alone with mixed sources, lost response / reopening without a second
POST, editing and removal with a new view. The 16 desktop flows and 15 quote
cache tests pass; 1,307 mobile tests, typecheck / lint and Hermes pass. Strict
Clippy core / FFI, DLL build and generation of the real Swift bindings pass as
well. The compilation of the interfaces and the CI qualification of the batch
remain to be confirmed. The cross-room selectors,
the Android composition and the private cards in ordinary rooms
remain open, as do files, archive, private editing and installed
GUI qualification. No production E2EE mask enabled.

Android mixed composition and destination choice wired to the existing actions
sheet and composer: local search among the authorized joined conversations,
plain references to an encrypted destination and private references to another
encrypted destination. A thread selection stays addressed to the right composer.
Opening sends nothing; scope, membership, admission and revision of the sources
are re-read before MLS preparation. The plain witnesses of the authenticated
cache contain only membership and references; no excerpt enters the native
command or the sent document. Rust refuses to treat an already registered group,
including removed / pending, as a plain source. Previews of both categories
rechecked after focus, cleared on blur and refused after replacement of the
selection or of the account. The 1,311 mobile tests pass in 50 seconds, as do
typecheck / lint and Hermes. The eight Rust bridge tests pass: two MLS actors,
mixed send, absent / stale witnesses, downgrade refused and original reopened.
Both Android ABIs compile; the five instrumentations of the real Keystore / ABI
pass (6.102 seconds of tests, 26 seconds for Gradle), with mixed references and
original package found after reopening. Their receipts remain synthetic.
Strict Clippy bridge / core / FFI passes. CI of the new batch and installed GUI
flow remain to be qualified. Desktop selectors, private cards in ordinary rooms,
archives / files / other actions / search remain open. No production E2EE mask
enabled.

Private cards and sending of their references in ordinary Android rooms wired to
the current lists / threads / banners / composers. The native reader stays
distinct from the protected composer: no draft or MLS preparation; guard on
destination, source, scope, membership, admission and position, then re-reading
before exposure. The projection is applied after smoothing without modifying the
SQL rows or the ordinary buffer. Blur / suspension / account change / removal
clear the cards and the private banner. The Android cross-room selection also
accepts authorized ordinary destinations. Before enqueue, native reading then
volatile synchronous authorization / SQL guard; only the reference joins the
ordinary queue and its original remains recoverable after a lost response.
The server reuses the MLS journal reader and the exact historical witness of the
device to validate these new references, without delivering a private excerpt.
The new HTTP / PostgreSQL scenario covers absence of plaintext, stale revision,
domain membership without MLS admission and receipt kept after expiration; it
is compiled by strict Clippy, then really passes over HTTP / PostgreSQL in the
`verify` job of CI `37244716038` of commit `b884e1d`.
The 1,321 mobile tests pass in 50.2 seconds; typecheck, lint and Hermes export
(8.3 MB) pass. The scenarios of the real runner with SQLite cover native reader,
late refusals, removal, lost response and resumption of the same accepted
message; their crypto / HTTP calls remain simulated. No native bridge / ABI is
modified. Installed GUI qualification, the ordinary cards and desktop selectors,
private archive / files / actions / search remain open. No production E2EE mask
enabled.

The mixed cards of the desktop core now also keep the files of their ordinary
sources, alongside private descendants and with the existing protected file
readers. Removal hides only the source concerned; an MLS source cannot obtain
ordinary file metadata. The two targeted card tests pass on Windows: files /
removed descendant, removed parent, Unicode, depth and cycles. Strict Clippy
core / FFI passes in 22.1 seconds; CI qualification of this fix is still open.
The green CI of `a576db3` reveals a desktop cache save failure: incremental
locks created by Docker as owner `root`, unreadable by the runner's `tar`. The
cleanup now hands the generated caches back to the runner, as the Swift job
already does. The CI `37244716038` of `b884e1d` does save the desktop cache with
its key `native-desktop-fedora-…-b884e1d1041102efea50b4378f23576af43eb8f7`,
without a permission error. No functional check is removed.

Ordinary desktop readers wired to the existing GTK / SwiftUI lists, including
threads: a distinct actor attaches to the registered vault and has no draft or
send API. It rebuilds the cards from the references in the cache without writing
private text into it; a first pass catches up a bounded page per private source,
then re-reads memberships and admissions. The bodies, ordinary files, groupings
and unread markers remain those of the existing presentation. Blur / hidden view
/ navigation / account change close the reader and redisplay the raw cache. A
view generation, the current membership and the equality of the SQL window
discard late responses. A change in another room also invalidates the Swift
cards; the active reader is refreshed every ten seconds.
The 16 HTTP / MLS / SQLite flows of the core pass in 42.25 seconds, including the
new ordinary reading case with unchanged cache, closure and removal of the room.
The test uses real MLS documents and a simulated HTTP server; it does not
qualify the GUI rendering. Strict Clippy core / UniFFI passes in 13.93 seconds,
the DLL is built and the real Swift bindings are regenerated. GTK / SwiftUI
compilation and connected regressions confirmed by the nine jobs of the native
CI 37247156429 and the macOS build / packaging / startup 37247156379 of
10f3005; installed private GUI flow still open. No production E2EE
mask enabled.

Desktop cross-room selection added in the existing GTK / SwiftUI menus: local
search among the joined conversations where writing is permitted, with no
implicit admission or send. Navigation carries only the reference,
instance / generation, membership and possible private admission. The
destination composer re-reads the exact source, in plaintext or via the vault,
before the preview. A QuoteComposer actor distinct from the ordinary reader
validates the private references for an ordinary destination; the SQL queue
keeps only references and the parent's personal text. Neither excerpt nor
admission becomes persisted authority. The ordinary call without this actor
still refuses the encrypted source. Text kept during the preflight; the intent
and the consumption of the one matching draft are atomic, while a more recent
text survives. Navigation, blur, cancellation and replaced selection close /
hide the previews; a late response does not rearm the banner.
The 56 storage regressions pass in 1.13 seconds, the 16 HTTP / MLS / SQLite
flows in 46.09 seconds, and strict Clippy core / UniFFI in 17.64 seconds. The
DLL and the real Swift bindings are built. The new GTK checks under Xvfb and the
Swift models against PostgreSQL exercise the destination choice and the
cross-room send; CI execution is still open, as are the installed private GUI
flows. No mask enabled.

The CI 37250486296 of 7bf7fae reached the 90-second limit of the private HTTP
bench against PostgreSQL. The same flow had passed in 79.36 seconds on
10f3005. Its executable is compiled as an example in the dev profile: the
optimization of the curve25519 arithmetic already used in the test profile is
now also applied to this profile, without removing an assertion or raising the
limit. Stage markers without private content are now visible on stderr, including
on timeout. The local check of the example passes in 5.21 seconds; its run time
and the outcome of the new GTK / Swift flows remain to be confirmed by CI.
The macOS build / packaging / startup 37250486298 of 7bf7fae passes.
The GTK CI identified a room field absent from the presentation DTO:
the preview finds its message by ID and revalidates the SQL selection that
carries the exact room. The new Swift test now waits for the resynchronization
triggered by its first room creation before the second command; the nine
connected Swift flows already present pass on this commit.
The previous CI has now finished: six green jobs and the three failures
above. The selector no longer reuses the refusal of plaintext sending for an
encrypted destination: unknown rights on a joined room do not exclude it, while
a known effective refusal hides it. The choice re-reads the server's effective
rights before navigation / preparation, then revalidates the account
and the source. The Swift management record exposes this right independently of
the encrypted mode; the existing bench covers the owner and a member of a
read-only room. Qualification of these fixes is still open.
Strict Clippy core / UniFFI passes on the fixes in 2.80 seconds; the
DLL and the regenerated Swift bindings pass in 53.70 seconds. Formatting,
changelog and inventory checked; GTK / Swift models and the PostgreSQL fixture
will be requalified in the CI of the next commit.

The `41cb92c` fixes pass the full HTTP bench in 26.42 seconds, with the
unchanged 90-second limit. The nine native jobs are green;
the GTK cross-room quotes flow passed, as did the security /
e-mail regressions. The macOS build,
packaging and startup 37252377479 passes; both ABIs and the real Android
Keystore on emulator pass in 37252377488. The native CI
37252377514 finished successfully.

| Milestone | Development delivered | Remaining work to close it |
|---|---|---|
| J0 | Contracts, shared fixtures, inventory and parity backlog | Operator / export conditions and crypto decisions tied to the following milestones |
| J1 | Rust server, account / rooms / DMs, journal, cache / resumption and providers in the current interfaces | Android ↔ Windows flow on devices with outages and killed processes |
| J2 | Main messaging flows, rights, actions, threads, reads, presence, search, profiles | Qualification of the installed applications and gaps made explicit in the batches below |
| J3 | Files, voice messages, cards, emojis, notification transports and replies / links | Physical Android push, codecs and qualification of the installed native flows |
| J4 | Calls wired, crypto identities / vault, MLS packages / transitions, opaque journal, protected pages, historical signatures, settlement of interrupted intents, readmission, session-bound crypto access, identity / association / certificate renewal, room rotation and replacement of renewed peers, signed removal in the existing settings, peers / groups and GTK / SwiftUI conversations, vault / association / trust / groups and text conversations on Android, private threads and quotes in the three interfaces, mixed reading, cross-room composition / destination and private card readers in the ordinary rooms of the three interfaces | CI qualification of the visible removal, visible recovery, other private actions / search, complete E2EE GUI flow, history after revocation, archives / files, crypto review and real Jitsi trials |
| J5 | Preparation of the contracts and of the operator administration | Resumable import, backup / restore, operations and cutover pilot |

The server batch `41cb92c` passes the nine jobs of CI
`37252377514`: general checks, Linux / Windows / macOS crypto suites,
HTTP / PostgreSQL bench and GTK / Windows / SwiftUI desktop providers.
The Android job `37238019723` also passes both ABIs, the real Keystore, the
association ceremony, the trust controls, groups, threads and quotes on emulator.
The macOS application of the private quotes batch `9884ce2` passes its compilation, packaging and
startup (`37235042086`, attempt 2 after a GitHub upload timeout).
The mixed reading batch `574f137` also passes the macOS application (`37240191547`).
The Android composition batch `a576db3` passes the Keystore / ABI (`37242529415`) and
all server jobs (`37242529465`). Groups, projection and composer in the
existing interfaces compile and pass these regressions. The complete E2EE GUI
flow with several installed applications remains a distinct exit criterion.
The generated inventory that had stopped the CI of the wiring `60e72f4` is fixed.
The server journal passes its nine
PostgreSQL / HTTP / MLS scenarios and the shared contracts; no E2EE capability is
enabled. The private worker now checkpoints the pages common to messages
and transitions, with a durable cursor and catch-up of several epochs on the
same admission. Authentication of expired signatures on this admission
added; durable abandonment of personal sends added next, with a private
intent checkpointed before HTTP and a recoverable document. Settlement of
transitions added next: original kept after a peer's succession, durable
terminal decision and release of only the non-accepted commit. Readmission of the
same vault with a new Welcome / package, atomic replacement and previous cache
marked outside the projection added. The core of the desktop provider now binds
the worker to its session and to its HTTP client, with a terminal guard on late
results. The identity / association ceremony and the keychains of the desktop
settings are wired. Private projection, drafts and composer for
GTK / SwiftUI are integrated; removal / projection change close the conversation
view and hide its transient content. The Android vault is wired to the session
cycle. The complete mobile flow and the authorized history
remain open.
The next batch wires the pins / devices to the existing GTK and SwiftUI profiles,
with first unverified contact, explicit root comparison, controlled replacement
of a changed root and opaque certificate preview before approval. Viewing
initializes no vault and admits no MLS member. The paginated signed
revocations remain blocking after omission and reopening;
the attachment of a conversation uses only the registered installation.
The eleven crypto flows of the core pass on Windows. The compilation of both
interfaces and their suites also pass in the CI runs of `ee3f717`. The local Rust
caches / temporaries use D: after Cargo failed on the full C: disk; local Docker
also stopped starting, with insufficient evidence on its exact cause.

Preparation of the groups batch: protected reading of the local state absent /
transition pending / receipt accepted, without group creation or implicit POST.
The real MLS / HTTP flow with a lost response covers these observations and their
resumption; the seventeen delivery tests pass on Windows. Learning of a local
revocation in another viewer also stops the conversation already open for the
same incarnation. The eleven core flows and Clippy core / FFI pass.
The group controls in the GTK / SwiftUI room information are now wired to the
same Rust controller: viewing without mutation, explicit invitation packages,
creation / admission / update with recipient preview, separate confirmation and
resumption / abandonment of interrupted intents. Devices already admitted are
not proposed as new recipients. The fourteen core flows pass on Windows,
including three new real MLS / HTTP / SQLite flows; CI remains required to
qualify the compilation of the interfaces and the GTK rendering. No unlocked
composer and no E2EE capability enabled by this batch.

The external criteria still open remain exit criteria of the RFC.

## First increment: server foundation and pilot transports

- [x] Native Rust workspace independent of the desktop, `rv-server`, `rv-protocol`, `rv-client`.
- [x] Compose, database and volumes isolated from the Rocket.Chat bench; local listening.
- [x] JSON Schema contract, TypeScript generation and shared fixtures.
- [x] Accounts created by CLI, Argon2id, hashed sessions and revocation.
- [x] Rooms, membership control by the owner and one DM per pair.
- [x] Idempotent text sending, refusal of diverging requests and paginated history.
- [x] Transactional sequencer, durable journal, consistent snapshot and opaque cursors.
- [x] WebSocket with single-use tickets and resumption from a cursor.
- [x] Rust and TypeScript pilot transports, not wired to the existing interfaces.
- [x] Tests against real PostgreSQL, HTTP / WebSocket, replay and server restart.
- [x] Dedicated CI and startup / limits documentation.

The checkboxes describe delivered code. The execution results and practical limits
must be kept in the delivery summary; a workflow definition does not mean that
its first remote execution has already succeeded.

### Checks run on 30 September 2026

- Formatting and Clippy on the whole native workspace, without warnings.
- 10 Rust tests passed, including 8 against real PostgreSQL; the client test also
  exercises the TypeScript transport against the same server over HTTP and WebSocket.
- 5 contract / TypeScript transport tests and strict TypeScript verification passed.
- JSON Schema and TypeScript types regenerated without divergence.
- Concurrency regression covered: sends and DM creations do not block
  the foreign key checks used by membership changes.
- 12 existing Rocket.Chat provider tests passed.
- Production image built and started locally: HTTP readiness 204 and
  correct native discovery on `127.0.0.1:3400`.

The first remote CI is green; each fix follows the same workflow on the
branch. The first increment included no connected native screen.

## Second increment: pilot mobile flow

- [x] Native probe before authentication, with no Rocket.Chat fallback if the announced
  RocketVibe protocol is incompatible.
- [x] Native login, resumption and logout; kind, identity / generation and
  token kept in the existing secure storage.
- [x] Dedicated React Native screen: private / public rooms, invitation by the
  owner, DM, text, history, retry / abandon and server change.
  This pilot screen was removed in the third increment, in favor of the existing screens.
- [x] SQLite projection: atomic batch and cursor, durable outbox, idempotent echo
  and exact order of positions exceeding JavaScript precision.
- [x] HTTP then WebSocket resumption, reconnection, suspension when going to the background
  and heartbeats; bounded frame queue.
- [x] Local purge on removal from a room; cache and sends of an old generation
  hidden before the new snapshot and never replayed on the next one.
- [x] Test of two mobile engines and their real SQLite migrations against
  PostgreSQL: outage, recreation, replay, private removal before the outbox is resent.
- [x] CI extended to mobile changes, tests and the Android export.

### Local checks of the second increment

- 946 mobile tests passed, including 18 native tests; typecheck and ESLint of the files
  concerned passed.
- 10 Rust tests passed, formatting / Clippy and contract generation without diff.
- Android Expo export succeeded: Hermes bundle and assets. This is not an APK.
- Server image rebuilt; readiness and local discovery verified.

Visual validation on Android was not run: no device is
connected and the Firebase files of the native build are not present in this
checkout. The client tests recreate the engine under Node and a SQLite test closes
then reopens a database on disk; they do not yet prove the behavior of a really
killed Android process.
The instructions and limits are in the [pilot guide](NATIVE_MOBILE_PILOT.md).

## Third increment: two providers in the current interfaces

- [x] Native probe and kind / identity kept in the desktop accounts.
- [x] `NativeSession` engine in `rv-core`, separate SQLite cache, drafts and outbox.
- [x] Atomic transactions for projection / cursor / echo, exact order, purge of
  removals and protection against late history responses.
- [x] Same GTK ChatPage / MessageList / Composer for Rocket.Chat and RocketVibe.
- [x] Same mobile home / room / list / composer, via the Provider contract.
- [x] Switching between accounts and transports, absent capabilities disabled.
- [x] Persistent mobile drafts, protected against writes from an old generation.
- [x] Explicit UniFFI API; the legacy login does not hand a native token to RC.
- [x] Wiring of this API to the SwiftUI models and screens.
- [x] Ephemeral PostgreSQL mobile / desktop bench and smoke test of the real GTK binary.
- [x] CI extended to the desktop workspace, the GTK bench and the core tests on Windows.

The [desktop guide](NATIVE_DESKTOP_PILOT.md) describes the flow and the bench. Validation
of Android / Windows on devices remains open.

### Local checks of the third increment

- Formatting / Clippy without warnings and 212 tests of the desktop workspace passed.
- 949 mobile tests passed, typecheck, lint and Android / Hermes export.
- Legacy Rocket.Chat login contract verified after native discovery.
- Native mobile provider verified: UI query by sequence, pagination independent
  of dates, outbox / retry, purge and generation drafts.
- Real PostgreSQL / mobile engine / desktop core bench passed: SQLite reopening,
  single replay, missed message, draft, DM, creation / invitation, private removal
  and session revocation.
- GTK binary connected via its form, send and mobile reply verified in
  the displayed widgets; captures at normal width and at 435 pixels.

The bench provides no system keychain: login works during
the test, but resumption of a token from the real secure storage remains to be exercised.

## Fourth increment: shared SwiftUI

- [x] Login and resumption by account kind, before credentials are handed over.
- [x] Same AppModel / RoomModel and same SwiftUI views for both providers.
- [x] Same UniFFI message rendering, grouping and Markdown, native order kept.
- [x] Persistent drafts, offline sending, outbox resumption and DMs.
- [x] Shutdown of old transports, session guards and abandoned models left inactive.
- [x] Absent native functions disabled, account / language and navigation kept.
- [x] Real Secret Service backend for the Linux bindings of the test bench.
- [x] Swift / PostgreSQL / secure storage bench added to the CI.

The Swift bench verifies the refused then successful login, sending, the offline
intent resumed only once, the draft on account change, rejection of an
old model, the DM and deletion of the account on logout. It uses the
real models and the real core, with no fake server. It does not replace a
manual trial of the native interface on a Mac connected to the server.

Local verification: 200 Rust tests of the core / bindings, Clippy and formatting without
errors; Swift compilation, 6 local tests and real native scenario passed. The two
Rocket.Chat integration tests are ignored in the absence of its test server.

## Fifth increment: limits and temporary data

- [x] Login quotas per username / TCP IP / instance in PostgreSQL, kept
  across restarts, with no trust in proxy headers.
- [x] Bounded Argon2 computation even after cancellation of an HTTP request.
- [x] `429` with delay, respected by the Rust and mobile transports without revocation.
- [x] Unconsumed tickets and simultaneous sockets bounded; reservations released
  on closure / cancellation, closure itself limited in duration.
- [x] Snapshot limited to 8 MiB; explicit refusal without publishing a partial cursor.
- [x] Journal batches limited to 1 MiB, without skipping the remaining events.
- [x] Cursor expiration, rotation of an expired token and cap of 512 per account.
- [x] Cleanup at startup and periodic, in batches, without waiting on locked rows.
- [x] Resumption of the mobile SQLite engine after real expiration in PostgreSQL,
  draft kept and same offline intent delivered once.

The tests exercise concurrency / restart of the quotas, IP spoofed by header,
expiration / pruning, cleanup during a concurrent lock, replayed tickets,
limit and release of sockets, active revocation and large messages whose JSON
is larger than the text. Snapshot pagination and load qualification
remain open; the exact bounds are in the [contract](protocol/README.md).

Local checks on 1 October 2026: 17 Rust tests of the native workspace,
23 tests of the TypeScript provider, 951 mobile tests and 200 tests of the desktop core /
bindings passed; formatting, Clippy, typecheck and lint of the modified mobile files.
The production image was built and started in a disposable PostgreSQL:
readiness 204, correct discovery and periodic deletion of expired rows
by the server process itself. These tests do not close the trials on devices.

## Sixth increment: J0 contracts and inventory

Reproducible inventory of 273 files / 344 Rocket.Chat occurrences, dynamic
parameters reviewed and CI check. The destination schemas cover rights,
counters, actions, profiles, files, 2FA and key envelopes; they are read
by Rust and TypeScript, without enabling the absent functions. The shared corpus
covers 15 Markdown cases and 5 attachment cases, with projection into Swift runs.
Capabilities are intersected with client support and the mobile diagnostics
keep the request identity / delay without confusing 2FA, proxy and revocation.

Local checks: 21 native Rust tests, 25 native TypeScript tests,
975 mobile tests; typecheck and lint of the files concerned passed. Core /
bindings and GTK binary compiled in Fedora, Clippy without warnings; Swift models
compiled with regenerated bindings, 6 local tests passed (the 3 connected flows
remain ignored without their service). Physical validations remain open.

## To close J0

- [x] Inventory of the Rocket.Chat calls in the native screens / modules, generation
  and CI check; dynamic parameters and transports reviewed.
- [x] Rust / TypeScript schemas and fixtures: fine-grained rights, read / counters,
  actions, profiles, files, 2FA challenges and opaque key envelopes.
- [x] Shared corpus of Markdown rendering, mentions, quotes and attachments,
  crossing the mobile app, the GTK renderer and the UniFFI runs for SwiftUI.
- [x] Additive capabilities and server / client intersection in mobile / desktop
  core / GTK / UniFFI / SwiftUI; neutral mobile identity and diagnostics.
- [x] Backlog P01-P23 linked to each line of the matrix; policy for counters,
  rights, routes of the following batches and bench assumptions documented.
- [x] Desktop diagnostics: native request identifier and server delay preserved
  by the transport, the provider, its state and the UniFFI / Swift errors.
- [ ] External conditions: export rights / format, operator services, physical
  devices; E2EE protocol choice and review dedicated to J4.

The [J0 parity contract](protocol/PARITY.md) distinguishes the destination schemas
from the endpoints actually available. The presence of key DTOs constitutes
no crypto guarantee.

## Seventh increment: immutable paginated snapshots

The server materializes the pages in a single transactional view, keeps
their data in PostgreSQL and publishes the cursor only on the last page.
The new Rust / mobile clients assemble and validate the entire view before the
atomic SQLite application; an older native server keeps its initial route.
Quotas: 1,000 rooms, 50 roots and 50 recent replies per room since P11, 1 MiB per page / 64 MiB in
total, duration 5 minutes, 4 views per account / 16 in the instance. Room removal
and restoration invalidate the pages, including after readmission. A construction
failure cancels the partial pages and releases the reservation.

The real PostgreSQL bench tests a snapshot larger than 8 MiB with an arrival during
the download, then replay at the captured watermark. Rust and the mobile engine
with SQLite read this view; no intermediate page modifies the cache.
The tests cover concurrent quotas, total size exceeded, 110 rooms,
expiration, removal / readmission, restoration and corrupted page sequences.
The physical trials and the strict ordering of broadcasts remain open.

Local checks: 26 native Rust tests, 31 native TypeScript tests and 981
mobile tests passed; schemas / generation / inventory without diff, typecheck
and lint of the mobile files concerned passed.
The 203 tests of the desktop core / bindings and Clippy pass in Fedora; the GTK
binary is compiled with the paginated transport shared with SwiftUI.

## Eighth increment: revocations and authorizations

The eighth increment closes the race between reading and emission: opaque version
per membership, PostgreSQL barrier before HTTP delivery / frame sending, session /
account / generation rechecked and a delivery delay of 5 seconds. The tests
really hold back an unconsumed response and observe that the removal of a
member, from another server object, waits for its lock. They cover abandonment,
expiration, readmission, role, session and restoration; the sequencer stays active.
A real socket is kept during sends concurrent with the removal, receives
its minimal event then continues in another room without receiving a new
payload from the removed room. The outboxes keep and replay the same intent
on `delivery_revalidate`, with SQLite tests in the mobile app and the desktop core.

Bytes already handed to the transport may still be buffered by the network.
Future search / file reads will have to use the same barrier.

Writes also re-check the actor and hold its session until commit. The cursor
quota lock is separate from the mutation lock, so that the replay of the
already committed watermark is preserved during a delayed write.
Writes bound lock waits to 6 seconds, statements to 8 seconds and an idle
transaction to 10 seconds; the lock timeout lets the 5-second delivery expire.
A blocked writer thus releases its session and allows disconnection, with a
rollback verified in PostgreSQL.
The GTK bench starts a real Secret Service; its second launch reloads the
saved account without login injection, in a new process / bus.
The connected Swift model also passes with this keyring and the disposable server.

Local checks: 34 native Rust tests, 32 native TypeScript tests, 982 mobile tests
and 204 desktop core / bindings tests passed; formatting, Clippy, typecheck,
lint of the affected mobile files and generation / inventory without diff.
GTK and the Swift bindings / models compile; validations on physical devices
remain open.

## Ninth increment: durable creation and public rooms

Clients record the intent of a creation form in SQLite before its request.
After a lost response or a restart, the same form resumes its identity;
PostgreSQL returns its already created room, without a second event.
Older v1 clients can still create without an identity. Receipts are durable
and reject an identity reused with another name / kind or a message send.

The public directory is paginated, bounded to 20 entries, with literal search
and idempotent personal membership. It does not reveal private rooms / DMs; its
delivery also protects the visibility and revision of the metadata. The join
preserves an existing role and publishes a single personal event. The mobile,
GTK and SwiftUI search screens consume their usual models.

Local checks: 37 native Rust tests, 33 native TypeScript tests, 983 mobile
tests and 206 desktop core / bindings tests; formatting, Clippy, typecheck, lint,
schema and inventory pass. The production server is built then tested
with a disposable PostgreSQL: mobile and the desktop core discover / join each
other's rooms, GTK exchanges in the existing interface and resumes its account
from the keyring. The SwiftUI model finds a room of another account, joins it
and sends a message in it with the real bindings and the real Secret Service.
Physical trials remain open.

## J0 addendum: desktop diagnostics

Recognized HTTP errors keep `request_id` and `Retry-After` through to the desktop
provider, its connection state and the UniFFI errors. A retry
suppressed locally by the quota keeps the identity of the last server refusal and
reports its remaining delay; it does not fabricate a new identifier. Transport /
gateway errors remain without identity and do not prove a revocation.
The tests go through the real HTTP transport, the provider and the exported error.
Rust / GTK and the Swift bindings / models compile; the Rocket.Chat
login / 2FA flow keeps its tests and its existing branches.
Checks: 37 native Rust tests, 33 native TypeScript tests and 208 desktop tests
pass, with Clippy / GTK and the 6 local Swift tests; the 3 connected tests
remain conditioned on their test services.

## To close J1

The mobile queue also resumes its temporary refusals while the socket stays
connected: bounded backoff with jitter, `Retry-After`, cancellation on suspension
and stop upon understood revocation of the session. One test goes through HTTP,
PostgreSQL, a real authenticated socket and SQLite: the initial acceptance
loses its response, the journal is delayed without advancing its cursor, then the
client automatically replays the same intent. A single message exists in the database.
SQLite errors after confirmation and the 503 / 429 transitions are
also covered. Checks: 985 mobile tests, typecheck and lint pass.

- [x] Mobile pilot: probe, connection, secure storage, SQLite and outbox.
- [x] Mobile integration into the provider contract and the shared screens, persistent
  drafts and room / DM / account navigation.
- [x] Desktop provider in `rv-core`, exposure through GTK / `rv-ffi` / SwiftUI.
- [x] Atomic application of batches and cursors in the pilot mobile SQLite cache.
- [x] Same guarantee in the pilot desktop cache.
- [ ] Real Android ↔ Windows flow, with the network cut and client processes killed.
- [x] Heartbeats, broadcast rate, limits and authentication attempts bounded.
- [x] Maximum snapshot / batch sizes and cleanup of tickets / cursors.
- [x] Pagination of a materialized snapshot to exceed the pilot's bounds.
- [x] Ordering of revocations with active responses / sockets, PostgreSQL
  barrier and verification of authorization versions before delivery.
- [x] Idempotent room creation and discovery / membership of public rooms.

The pilot mobile flow and the tests without a device do not close J1: it requires
the Android / desktop flows and the remaining guarantees above.

## Next milestones

- P19 / J4, room state in the existing providers (4 October 2026):
  the common contract exposes `encrypted`, optional and false on older servers.
  The server derives this state from the existence of the MLS group. Acceptance
  of a group or of a private message publishes only a room update in the
  ordinary journal, at the same global position as its private delivery and in
  the same transaction; an exact retry does not publish a second activity. No
  text, ciphertext, key or group state goes through this journal. List / snapshot /
  details and changes carry the state to the GTK, SwiftUI and mobile caches.
  The already open room becomes locked in the existing views. The Rocket.Chat
  unlock button stays reserved for its provider. A new plaintext send is
  refused before any ordinary intent; an old offline send is marked `crypto_required`
  before HTTP, with its body kept. This wiring prepares the private projection,
  without delivering it or enabling E2EE. Private badges and the catch-up of the
  protected journal in the interfaces remain open.
  Local checks: 408 desktop tests passed (four cases ignored by
  default), strict Fedora Clippy; 288 mobile and TypeScript tests passed.
  Rust contracts and generated schema / TypeScript verified. The HTTP / PostgreSQL case
  extends the MLS bench with snapshot, list, details and two ordinary activities
  with no private text or duplicate. Server Clippy passes; its test compilation
  is interrupted by the Docker engine, even alone with two jobs and limited
  memory. Server / Swift qualification is left to the branch CI,
  without counting this interruption as a successful validation.

- P19 / J4, ceremony in the existing settings (4 October 2026): GTK and
  SwiftUI share the Rust flow for explicit root creation, signed
  device request, confirmation of fingerprints and manual transfer of public
  codes. Opaque consent bound to the viewer, with no signing or vault secret
  in UniFFI. Keyrings and private directory shared; durable selection
  indexed by URL, instance, epoch, account and HTTP device. The incarnation is
  recorded before initialization. The grant and the exact enrollment body are
  checkpointed together; resumption first consults the personal receipt and
  checks all its fields. Tests with real grants over local HTTP: explicit creation /
  approval, lost response recovered after reopening, new
  device with root compared, refusal without a root holder, closure and
  capability withdrawn before write. Selection, family lock, interrupted
  genesis, distinct origin, inaccessible storage, copy and removal tested;
  the eight checkpoint / lock regressions pass. The bridge and the Swift
  model compile; eight tests without a server pass (sixteen integration cases
  ignored for lack of a driver in this local check). The generated inventory is
  regenerated and verified. The section remains conditioned on the experimental
  E2EE capabilities: no server or client capability enabled. Renewal,
  visible revocation / recovery, pins / groups, messaging projection,
  Android, archives / files, history after removal and review remain open.
  Fedora: desktop suite of 406 tests passed (four cases ignored by default),
  then eight targeted crypto tests re-run after the last adjustments, strict Clippy
  and GTK / FFI build passed. The new GTK case is run under Xvfb
  with assertions on the mounted dialog, available actions and clearing on
  close; render inspected. The three other ignored cases concern meeting
  cards, link previews and the notification bus and remain covered
  by their usual CI drivers. A Docker connection interruption during
  compilation required a resumption limited to four compile jobs.

- P19 / J4, crypto access of the desktop provider (4 October 2026): `rv-core`
  now consumes the private vault with native HTTP; same SQLite and HTTP client
  as the existing provider, with no other account or token. Explicit attachment
  after checking the current instance / generation / user / single
  device; a single access per generation and clones sharing the
  dispatch. Terminal guard in the worker after HTTP and at the entry of private
  work, capability updates from the validated discovery and stop upon
  suspension / reconnection / end of cycle / shutdown. Weak references:
  the access does not keep the closed runner alive. Five desktop scenarios passed
  in 1.97 s with a real runner, HTTP, SQLite and MLS package: closure before
  vault, replaced scope, device ambiguity, byte-identical resumption after
  closure during POST, requester cancellation during checkpoint with
  OS lock kept and no late POST. Full desktop suite:
  403 successes, zero failures, three display / bus scenarios ignored in this
  ordinary run; strict Clippy and GTK / FFI build over the whole workspace.
  The 17 private HTTP workers
  pass again in 4.27 s; strict Clippy with and without HTTP. No change to screens,
  to the Rocket.Chat provider or to the E2EE mask. Ceremonies / keyring
  adapters / interface projection, suspension of removed rooms, mobile,
  archives and qualification remain open.
  [Desktop session boundary](../apps/desktop/docs/NATIVE_CRYPTO.md).

- P19 / J4, readmission into the same vault (4 October 2026): new package /
  Welcome, preview in a temporary provider and consent binding package,
  old state, pins and current certificate. No persistent mutation during
  the preview. Atomic acceptance: old MLS removed, new package consumed,
  accepted references kept, previous cursor removed and previous cache
  marked outside the current projection. Uncertain operations settled before
  readmission; abandoned personal documents still recoverable.
  `EventKind::Readmission` announces the replacement to the provider before its
  confirmation; no interface or capability enabled. Six private scenarios
  pass in 5.15 s, including a corrupted Welcome with a valid signature, stale
  pins / rights, old cache, reopening and lost external checkpoint. Targeted
  regressions: 14 message cases outside the heavy capability test, 12 journals and
  17 HTTP workers; strict Clippy with HTTP. Real HTTP / PostgreSQL bench passed
  in 59.00 s: leave / return, fresh access right, MLS remove / add and Welcome
  in the same vault / device; no content from the old admission in
  the new journal. Eight messages, five transitions / epochs, two Welcomes
  and two packages consumed; thirteen frames accepted, zero plaintext messages.
  The CI of the previous `2959999` passes the crypto suites of the three OSes and the HTTP
  bench, but `verify` rejects three unused internal items without HTTP.
  Fix: public abandon request in the API of the protected coordinator,
  consistent with that of messages; strict Clippy without HTTP and the full
  default suite passed: 135 successes, zero failures, one crash child ignored and
  run by its parent, in 160.47 s. The eight other jobs of the previous commit
  finished successfully; its full CI remains red because of `verify`.
  Suspension / projection in the apps, archives / files, physical
  devices / keyrings and independent review remain open.
  [Replacement policy](../crates/rv-crypto/READMISSION.md).

- P19 / J4, settlement of group transitions (4 October 2026): personal receipt
  available after removal / expiry, abandon route with the original opaque
  intent, migration 0042 and typed Rust / TypeScript SDKs. Acceptance and abandon
  share the author's lock: an accepted receipt wins, otherwise the
  durable marker refuses the late POST without revision / epoch / position, or
  package consumption. Quota of 256 new abandons per day / account; exact
  terminal replay kept. Restored-epoch scope, other author and substitution refused.
  The vault keeps the original and the abandon intent before HTTP, with a registry bound
  to the account / device / incarnation / root. Abandoned genesis: unaccepted group
  deleted; abandoned rotation: only the prepared commit released. The journal
  keeps its position and the accepted epoch. A peer successor keeps
  the old uncertain original; new preparation blocked until settlement.
  The accepted HTTP receipt stays memorized without advancing a rotation before its position.
  Local tests: six new protected cases, 17 private HTTP scenarios after fixing
  the fixture routing, 12 journal scenarios and five server settlement cases
  including quota (3.48 s), after 31 group scenarios passed; contracts, eight TS
  transport tests, typing, ESLint and strict Clippy. The first full private run
  counts 141 successes / three fixture failures; these three cases pass on targeted
  replay after the fix, the next full suite is left to the CI.
  Real worker / HTTP / PostgreSQL bench: success in 42.70 s, nine frames accepted
  over three epochs, rotation abandoned after a lost response, resumption without an
  extra transition POST, late attempt refused and a single admitted package
  consumed. The bench's external storage is simulated, no physical keyring
  proof added. Readmission, app projection, archives / files,
  review and qualifications remain open; E2EE capability disabled.
  [Policy and boundaries](../crates/rv-crypto/GROUP_SETTLEMENT.md).

- P19 / J4, final settlement of personal sends (4 October 2026): abandon
  route resuming the original bytes, account lock common to sends
  and a durable personal trace. An accepted message wins and keeps its receipt;
  otherwise late POSTs and reuse of the operation are refused,
  including in the ordinary spaces / uploads. No journal position,
  plaintext projection or ciphertext copy is created by the abandon.
  The worker checkpoints the intent before HTTP and resumes that decision after
  a cut before server arrival, lost response, reopening or expired
  certificate. An abandon status from another session triggers recovery of the
  exact receipt against the protected proof. Terminal marker and recoverable
  private document, explicit release of the body, old generation consumed
  and new operation mandatory. Abandoned messages no longer block
  a rotation; prepared transitions remain a separate settlement.
  Local checks: four new PostgreSQL cases, including races between
  real MLS packages / abandon, removal / expiry / new session, namespaces,
  persistent quota and substitutions. The thirteen server delivery cases pass
  in 5.82 s; the full native workspace then passes its 313 tests, with the
  ignored private bench run explicitly. Formatting and strict Clippy pass.
  Three new private checkpoint / body / generation cases and three HTTP
  abandon cases are added: 14 HTTP cases pass in 3.34 s, ten journals in 7.06 s.
  The messaging suite before the last persistent-intent addition passes
  its 14 cases in 154.29 s; the modified cases are then re-verified directly.
  Seven mobile transport tests, typecheck, lint and contract generation
  pass. Real private HTTP / PostgreSQL bench: lost abandon confirmation,
  reopening and exact recovery, late POST refused, six messages accepted
  / nine frames over three epochs, seven POST attempts including one abandoned,
  a single personal marker and no plaintext document in SQL, in 33.09 s.
  Full multi-OS crypto suite followed by the batch's CI; interfaces unchanged,
  no capability enabled. Readmission, app projection / bridges, rotations
  after large generation jumps, archives / files, review and qualification
  on devices remain open. [Private settlement](../crates/rv-crypto/SETTLEMENT.md).

- P19 / J4, historical authentication (4 October 2026): cryptographic
  verification of certificate / transition / package separated from its
  current validity. Current publications / admissions / sends keep `verify(now)`
  on the client and server side. The journal reads expired epochs only with a
  current reader, same admission and keys / root / incarnation unchanged;
  approved peers, known revocations and a non-future certificate are required.
  Private records keep the historical role and the real receipt date,
  for reopening without claiming current validity or a send date.
  Four MLS / SQLite cases added pass: three epochs expired after
  renewal of the reader, reopening / replay, new send still refused,
  revocation / signature / future refused and clean old rotation prepared
  consumed after the message that precedes it. The ten journal cases pass
  in 6.40 s on the first run.
  Full verification: formatting / strict Clippy of both workspaces,
  31 E2EE server tests in 9.89 s, real HTTP / PostgreSQL bench in 35.27 s and
  129 private tests in 159.96 s, without filter and crash child run.
  Expirations are proven in the vault with a fixture clock;
  no hour of real elapsed time is simulated in the HTTP bench.
  Renewal ceremony in the apps,
  readmissions / history after revocation, projection, archives and crypto
  review remain open. [Policy and proofs](../crates/rv-crypto/JOURNAL.md).

- P19 / J4, private journal pages (4 October 2026): fixed window and cursor
  bound to the admission; messages, transitions, ratchets and private content share
  a protected transaction per page. Native positions are exact; parents /
  epochs remain chained by MLS. The historical roster comes from the real
  plan, own access must match the current observation. A late
  signature also refuses the earlier mutations of that page.
  The exact clean-rotation ACK keeps the old epoch until the messages
  that precede its commit. Separate consumers do not bypass the
  started journal. The last batch is replayable from the reopened vault,
  even after the external checkpoint write was refused with no published result.
  Six new MLS / SQLite scenarios pass in 3.86 s: three missed
  epochs, resumption between pages, substitutions / gaps / order, late rollback,
  clean rotation with unread message, removal of another member and new
  access refused, checkpoint failure. The real HTTP / PostgreSQL bench uses
  the pages and their replay in both vaults: six messages / three epochs,
  ACKs lost after commit, six POSTs / opaque rows, nine frames and no plaintext
  document in SQL, in 30.15 s.
  Formatting / strict Clippy pass; 124 full private tests in 157.95 s,
  crash child exercised by its parent, no filter. An HTTP scenario added
  afterwards verifies interrupted read / reopening, replay and refusal of a
  substituted route without advancement: eleven HTTP cases in 2.84 s, six journal cases in
  4.03 s and PostgreSQL bench re-verified in 30.93 s. Expired / revoked historical certificates,
  readmission, durable app projection, archive beyond the bounded cache,
  files, bridges and qualifications remain open; capability disabled.
  [Protected journal](../crates/rv-crypto/JOURNAL.md).

- P19 / J4, HTTP worker for protected messages (4 October 2026): preparation
  / ratchet / document in the checkpoint before network, receipt searched from
  the historical metadata before resending. A 404 allows only the original
  retry after new observation / check of grants, head, pins and
  expiry; an exact ACK remains confirmable after removal / expiry / cooldown.
  Reception against the current head in an owned task, plaintext delivered after
  checkpoint and stop verification. Bounded / canonical conversions of the
  package, receipt and opaque Header, digest and metadata exactly bound;
  their decoding does not replace the MLS / certificate authentication of the vault.
  Five new HTTP scenarios and two conversion ones pass; the ten worker cases
  pass together in 2.85 s and the full private suite counts 118
  successes in 162.91 s, with the child crash exercised by its parent and no filter.
  The combined real PostgreSQL / HTTP bench passes in 29.76 s: six messages over
  three epochs, each response lost after commit, fresh Managers / SDKs for
  confirmation, rich documents and replies decrypted by both vaults.
  SQL keeps six ciphertexts, nine frames, six exact POSTs and no plaintext
  document. The fixture consumes each epoch before rotation; it does not close
  the historical catch-up, the durable ordered prefix, final refusals /
  readmissions, projection, files / archives, bridges, review and
  qualifications on devices. Formatting / strict Clippy pass; no E2EE
  capability enabled. [HTTP boundary](../crates/rv-crypto/GROUP_HTTP.md).

- P19 / J4, opaque message delivery (4 October 2026): POST of real
  MLS ciphertext and certified proof, historical personal receipt and journal
  common to transitions / messages. Position allocated by the native sequencer in
  the same transaction; exact retry with no new ciphertext or new frame.
  Persistent quotas and operation identities shared with the ordinary flows;
  write right, exact head, devices / grants and activation
  of all peers guarded until commit. Activation fences precede
  the room lock, compatible with concurrent sends and operators.
  Pagination with fixed watermark, exact native order and per-device admission
  witness; a re-membership with a new Welcome does not expose the old
  messages. Migration of existing transitions and their witnesses exercised
  with the exact SQL. Own receipt available after removal without access to the content.
  The Rust / TypeScript SDKs keep positions above `2^53` and
  bound crypto responses before JSON; no plaintext document stored on the
  server side. Nine PostgreSQL / real MLS / HTTP scenarios pass in 4.17 s,
  11 contract scenarios and six crypto transport scenarios pass.
  The 1,273 mobile tests pass in 55.09 s; typecheck of the whole app and targeted
  lint passed. The native workspace counts 308 successes, with the private HTTP bench
  ignored by default and verified separately; 285 TypeScript provider tests,
  formatting / strict Clippy, schema / generations and inventory pass.
  The private worker,
  full historical prefix, projections / interfaces, files, physical
  devices and review remain open. [Contract](protocol/E2EE_MESSAGES.md).
  No interface change and no E2EE capability enabled.

- CI / files, effective removal (4 October 2026): the `verify` job of
  `37173763923` fails on a read assertion launched concurrently with
  a still-blocked removal. A compatible read may be admitted before the
  removal's commit; PostgreSQL row locks do not guarantee that queue
  priority. The test keeps the proof of the pending removal, then
  waits for its commit before requiring the refusal of the next chunk. A second
  response captured before removal remains refused after re-membership; a new
  authorized request finds the file again. The eight file scenarios pass
  locally in 13.38 s, with formatting / strict Clippy; no change to the
  production transport. The three crypto suites, the private HTTP bench,
  Swift and the Windows core of this CI are green.

- P19 / J4, protected application messages (4 October 2026): real MLS
  ciphertext with routing AAD and external device proof, MLS author / certificate
  compared with the active list and canonical rich document (Markdown, thread,
  quotes with exact revisions, cards). Send / receive ratchet, original
  outbox, private content, exact receipt and last received position share the
  checkpoint. Own echo accepted only from the original private bytes;
  late refusal without consumption, retry without re-encryption and historical ACK
  without send right. A rotation waits for prepared messages, even if its
  consent precedes their preparation; a prepared transition blocks
  new messages. Cache of 64 contents / 4 MiB, explicit removal after receipt,
  identities and receipts retained to prevent reuse of an operation.
  Ten scenarios cover exchange / reopening, lost checkpoints, AAD / author
  substitutes, bounds, real pending commit, order and cache release.
  Full private suite: 111 successes in 164.33 s, with the child scenario
  ignored run by the crash parent; no filtered case. Before optimization
  of the curve arithmetic of the test profile, the ten targeted scenarios alone
  took 271.45 s. The coordinator's assertions remain active; canonical encoding
  and signature authentication remain two distinct steps.
  Formatting / strict Clippy pass; three public regressions and the
  15 server group scenarios, including the current combined worker, pass
  (17.14 s for this last set). Journal / HTTP / message worker,
  projection in the apps, catch-up across removals / readmissions,
  final refusals, purge / archive policy, files, Android bridge and
  review remain open. [Private contract](../crates/rv-crypto/MESSAGES.md).
  The batch stays isolated, with no E2EE capability enabled and no closing of J4.

- P19 / J4, combined bench of the private worker (4 October 2026): separate
  binary `delivery_smoke` called by the real Rust / PostgreSQL test server,
  temporary tokens via stdin and SQL access removed from the client environment.
  Devices / certificates registered over HTTP, two batches of real packages,
  targeted genesis / Welcome, rotations by Alice then Bob. First publication
  response and each transition response cut after server commit:
  new Manager / SDK searching for the receipt without a second POST. Local parent
  kept before ACK, same new epoch secrets at the peers, plaintext send
  refused. SQL: two publications, three transitions / events,
  a single Welcome and package consumed. Initial combined scenario passed in
  12.62 s; the 15 group route scenarios pass together in 14.05 s,
  then this scenario is re-verified without SQL credentials on the client side in 12.36 s.
  Formatting and strict Clippy of both workspaces pass. Real private
  SQLite, external checkpoint simulated in memory: destruction of the private
  process / physical keyrings not qualified by this bench. Dedicated job
  `native-crypto-http` running this test, ignored by default, with the binary required.
  Encrypted messages, scheduling / interfaces, full catch-up / removals,
  refusals / expired packages, archives / files / import and review remain
  open. No capability enabled.

- P19 / J4, portability of the HTTP bench (4 October 2026): the macOS job of
  `37168795438` reveals a `WouldBlock` on socket read, then a
  second panic in cleanup. Accepted sockets are explicitly
  blocking, their timeout is aligned with the SDK's 15 seconds and cleanup
  keeps the initial error without interrupting the whole suite. Formatting /
  strict Clippy and the five HTTP flows pass locally; fixed CI
  `37169133442` fully green on Linux / Windows / macOS. No change
  to the production transport.

- P19 / J4, experimental private HTTP worker (4 October 2026): optional
  feature `native-http` using the existing SDK. Instance / generation,
  account and single current session verified; clones stopped together,
  private work owned off the network. Receipt searched before exact retry of
  genesis / successor or package batch, outbox kept after lost
  response / refusal, merge at the exact receipt. POST 429 delay saved in the
  vault and respected after recreation, receipt GET always available.
  Reception from the local receipt, page validation then preview /
  confirmation with the roster observed anew. Initial full suite:
  100 successes in 45.17 s, plus crash child run by its parent; five
  targeted HTTP flows re-verified after adding the lost rotation, with
  equality of the peer's new secrets and no extra POST at
  reconciliation. Formatting / strict Clippy pass. These flows use
  a deterministic network fixture, real MLS and on-disk vaults;
  combined worker / server / PostgreSQL bench and network publication of
  packages still open. Scheduling in the apps, final refusals,
  full catch-up / removal / return, messages, Android bridge, archives /
  files / import, qualifications and review remain open. E2EE capability
  disabled. CI extended to this feature on the three OSes; the CI of the
  previous batch `37167174920` is fully green, including GTK / Swift / Windows.

- P19 / J4, HTTP boundary of the coordinator (4 October 2026): the shared DTOs
  now carry genesis / change, packages, original preparation,
  receipt and event to / from the vault. Scope / roster / nonces checked,
  metadata compared with the real TLS KeyPackage and its reference, canonical
  encodings / exact big integers, proof / digests / targeted Welcome and
  page chaining verified. No implicit approval. The SDK bounds
  crypto successes and errors to 4 MiB before JSON, including chunks, keeping
  `Retry-After` and the available GETs. Six new MLS / DTO scenarios,
  four SDK HTTP tests and the 14 PostgreSQL scenarios pass; full
  vault suite: 96 passed, plus crash child run by its parent,
  in 43.66 seconds. Final chaining re-verified by the six targeted tests; fmt /
  strict Clippy pass. The preparation CI `37165856413` is fully
  green on the three OSes; CI of this batch `37167174920` fully green.
  Connected scheduler / refusals / full catch-up, local removal / return,
  encrypted messages, Android bridge / apps, archives / files / import and
  qualifications / review remain open. E2EE capability disabled.
  [Private boundary](../crates/rv-crypto/GROUP_HTTP.md).

- P19 / J4, client preparation of successors (4 October 2026):
  `preview_change` / `prepare_change` verify the observed server head
  and the old MLS tree, then prepare rotation / add / remove / replacement
  in a protected transaction. Changed nonces require a fresh Remove+Add;
  retained devices keep their admission index / reference. An already
  revoked device can be removed; renewed local certificate installed in
  the real leaf. Original proof / tree / commit / Welcomes saved before
  checkpoint and result, merge only at the exact receipt. Eleven new
  scenarios pass through the real coordinator, including epoch-zero singleton,
  disk resumption / lost checkpoint, replacement with two removals / one add,
  bounds and spent references. Full suite: 90 tests passed, plus
  crash child run by its parent, in 38.48 seconds. Formatting and
  strict Clippy pass. The reception CI `37164702081` is fully
  green on the three OSes; its CI `37165856413` is also fully green.
  HTTP conversion / scheduler, full catch-up / local removal,
  encrypted messages, Android bridge / existing apps, archives / files /
  import, qualifications and review remain open. No capability enabled.

- P19 / J4, protected client reception of commits (4 October 2026): real
  rotation / add / remove after admission, MLS author / index / key tied
  to the signed proof and pins. AAD binding operation / parent / versions / devices
  without circular digests; context / tree / leaves checked separately.
  Add references compared with the real MLS packages, Welcomes limited to
  new admissions, memory of references observed after removal.
  Prepared local commit replaced only after transactional success; late
  refusal after merge restoring state / ratchets / outbox. Clean ACK and exact
  receipt following an active group, resumption after lost checkpoint, tree
  configuration kept on joined groups. Eleven new scenarios pass;
  full suite: 79 passed, plus crash child run by its parent.
  Strict Clippy and CI `37164702081` green on the three OSes; Unix import of the publication test
  made conditional to fix the Windows Clippy refusal of `37162727300`.
  All its other jobs are green, including the Windows file bench and GTK.
  Public preparation continued in the next batch; full catch-up / local removal,
  messages, transports / bridges / apps, archives / files / import and review
  remain open. [Private contract](../crates/rv-crypto/GROUP_COMMITS.md).
  E2EE capability not enabled.

- Desktop qualification, file resumption bench (4 October 2026): the CI
  of the roster `37161366000` validates server / mobile, Swift and crypto on the three
  OSes, but its Windows lost-upload-ACK test sometimes observes the queue after
  a retry already finished. The mock now keeps each lost response until
  its session has actually stopped, then separately opens the preparation and the ACK of the
  next process. The two file tests and targeted Clippy pass in
  the existing Fedora bench; Windows confirmation expected in the next CI.
  No production code or interface is modified by this fix.

- P19 / J4, protected client publication (4 October 2026): real KeyPackages
  generated in the vault with the exact HTTP request and MLS references, before
  handoff after checkpoint. `rv-protocol` DTOs used directly; fresh ID
  generated in a transaction, original batch found after a cut / restart.
  ACK compared field by field and kept, historical resumption after loss of
  checkpoint / expiry, no new implicit authorization. Lookup
  limited to scope / ID, refusal to resend after real consumption by Welcome.
  Observed local revocation also blocking group preparations.
  Bound of 64 bundles, release after real admission without destruction based
  on time alone. Nine new tests pass, 68 vault scenarios in
  total and crash child run by its parent; strict Clippy of the system backend
  passes. Network reconciliation of refused / expired, following commits,
  messages, bridges and apps, archive / files / import and review remain open.
  E2EE stays disabled. [Batch contract](../crates/rv-crypto/PACKAGES.md).

- P19 / J4, authorized roster observation (4 October 2026): Rust and
  TypeScript route / SDK exposing policy, membership / activation versions of each
  active member and public head metadata. Same SQL view as the validation
  of plans; sorted / complete list, refusal beyond 128 members with no partial
  page. Read allowed before crypto enrollment, with no MLS admission or
  key approval. Session / membership / epoch protected during HTTP handoff,
  body bounded by the lease and the session expiry; `no-store` everywhere.
  Six new PostgreSQL scenarios verify confidentiality, inactive account,
  leave / return / reactivation, locks actually observed, limit and
  restoration; 14 group tests pass. The real SDK obtains the nonces
  over HTTP and signs an accepted transition, with no SQL access on the client side.
  Rust contracts / SDK, six TS crypto / parity tests, typecheck / lint, Clippy,
  schema / generation / inventory pass. Reception of commits / messages,
  following transitions, wiring of the vault to the transports / apps,
  archives / files / import and review remain open. Capability not enabled.

- P19 / J4, protected client admission (4 October 2026): preview of the real Welcome
  without persistent consumption, confirmation then atomic join. Comparison
  of each leaf / certificate / pin, package actually consumed, incarnation,
  MLS author, ID / context / tree / epoch and current memberships / activations.
  Public proof validly signed but inconsistent with MLS refused; late
  application refusal cancelling any consumption and write. Group and receipt
  kept together, exact recovery after lost checkpoint / reopening.
  Eight new scenarios pass; full suite: 59 passed and child
  actually run / killed via its parent, strict Clippy without warnings.
  The CI filter now distinguishes the private engine from the public formats; isolated
  batches avoid server / mobile / unchanged drivers, any consumption
  by another crate reactivates their regressions. A workflow change
  keeps all validations. Reception of commits / messages, following
  transitions, transport / bridges / apps, archives / files / import and review
  remain open; no E2EE capability enabled.

- P19 / J4, protected client genesis (4 October 2026): real MLS group prepared
  in the vault, indices derived from the validated tree, opaque confirmation bound
  to the pins / certificate / policy / nonces / packages and scope. Leaf
  incarnation explicitly bound to that of the vault; MLS state and signed request
  saved before emission. Commit held pending until the exact receipt,
  resumption of the same bytes after stop / lost checkpoint, substituted receipt refused
  before merge. Change of trust / expiry blocks the retry without
  removing the search for the accepted receipt. Nine targeted tests pass, with a real
  join in a second vault and the same epoch secrets, i.e. 51 verified
  crypto scenarios; formatting and strict Clippy with native backend pass.
  The server batch `0dce551` has its CI `37155993042` fully green, including
  the existing clients and the Linux / Windows / macOS crypto matrix.
  [Contract and open follow-up](protocol/E2EE_GROUPS.md). Reception / following
  transitions, message outbox, HTTP / apps wiring and Android bridge,
  archives / files / import and review remain open. Capability not enabled.

- P19 / J4, server group transitions (3 October 2026): signed proof
  bound to the context / tree / commit / recipients, parent / revision / epoch,
  policy and membership / activation nonces. MLS references consumed with
  targeted head / event / Welcomes and durable receipt, in a single transaction.
  Per-incarnation locks also covering the creator without a package, refusal of
  new plaintext writes after genesis and of a conversion with history /
  active plaintext upload. Reads bound to the session / incarnation / membership,
  with a monotonic deadline kept during serialization and HTTP body.
  Rust / TypeScript routes / SDK, exact fixtures and independent Node vector.
  Real add commit / join / context / tree, local ciphertext, removal,
  replay / restart, already consumed package, leave / return, concurrent mutation,
  other device and expired response verified against PostgreSQL.
  Checks: 18 E2EE server / deadline scenarios, 3 public group
  proof tests, protocol / Rust SDK tests, 21 TS transport / parity tests,
  typecheck and targeted lint pass; Clippy without warnings and the
  Node/OpenSSL verifier pass; the server delivery and file regressions
  pass too. [Contract](protocol/E2EE_GROUPS.md). Group engine / client verification,
  message outbox / delivery, Android bridge, existing interfaces,
  archives / files / import and review still open; capability not enabled.

The entries report the delivered batches from most recent to oldest. The parity
matrix gives the current exit conditions; the limits of older batches
are kept with their verification results.

- P19 / J4, first server wiring of the public directory (3 October 2026):
  common formats / verifiers extracted into `rv-crypto-public`, with no private
  vault in the server dependencies. Registration bound to the current session,
  proof of possession / signed grant, immutable root, conditional renewal,
  replacement with persistent signed revocation; real OpenMLS verification
  of KeyPackages, withdrawn references kept and atomic batches. Exact receipts
  found after a lost response, crypto limit and quotas, private / no-store directory,
  Rust and TypeScript SDKs with no interface change. Eight targeted PostgreSQL / HTTP
  tests and the 42 crypto tests verify these paths; public schema and fixtures
  cover the exact revisions. Twenty targeted TypeScript tests, typing / lint,
  Clippy without warnings and independent Node vectors pass. Admission, single consumption / Welcome,
  MLS groups / outbox and integration into the apps remain open. E2EE stays false.
  The previous batch `9cc6fd6` has all its CI jobs `37146743934` green.
  [Contract and limits](protocol/E2EE_DIRECTORY.md).

- P19 / J4, root backup and recovery (3 October 2026): random 256-bit OS
  code distinct from the password / session, bounded representation
  with input checksum, XChaCha20Poly1305 package bound to the root / backup / date
  and 24-byte nonce. Only the root seed is exported, encrypted; no
  ratchet, leaf, pin, revocation or history. First restoration into a
  blank vault / provider, derived public key verified and cancellable transaction.
  Receipt of the exact package saved with the root: lost checkpoint
  then replay do not reset a new leaf / request.
  Eight dedicated tests pass: wrong code / tampering / scope / limits,
  inconsistent plaintext, refusal of an active vault, reopening / transactional refusal /
  lost checkpoint, i.e. 42 Linux crypto plus the child actually killed. Formatting,
  Clippy without warnings and the independent identity / add vectors pass.
  The previous batch `6d30d7e` has its CI `37145272953` green: server / mobile and
  three crypto platforms; long clients avoided since the crate is isolated.
  The recoverable backup
  claims no forward secrecy; an old code and package remain
  usable as long as the root is not replaced. Backup ceremony and outbox in
  the existing apps, control delegation, delivery service,
  archive / files / Android bridge and review remain open.
  E2EE stays disabled. [Format and invariants](../crates/rv-crypto/RECOVERY.md).

- P19 / J4, device addition and durable private receipt (3 October 2026): fresh
  leaf key / incarnation, signed request bound to the expected root,
  proof of possession and 10-minute window. Opaque local confirmation
  bound to the request / root / registry and expiry; root agreement bound
  to the exact certificate. Replay returning the original Grant, refusal of an
  old preview, substituted ID, Grant of another request / key and write of a stale
  local object. Bounded registry, purge of expired receipts and monotonic
  clock marker; refusal before reopening of an old window. Eleven dedicated tests,
  i.e. 34 Linux crypto plus the child actually killed, pass; real KeyPackage
  signed by the new key, reopened on-disk vault, transactional refusal and
  Grant found after checkpoint failure. Clippy / formatting pass, public Rust
  vector and independent Node / OpenSSL one as well. The identities batch
  `654d5ac` has its CI `37143957558` green: server / mobile and crypto matrix
  Linux / Windows / macOS; long client drivers avoided since the crate is isolated.
  Delivery / ceremony in the current apps, control delegation,
  recovery, room / archive / files policy / Android bridge and
  review remain open. E2EE stays disabled.
  [Flow and format](../crates/rv-crypto/ENROLLMENT.md).

- P19 / J4, certified identities and local approval (3 October 2026): client
  Ed25519 root, certificate bound to the instance / UID / device / incarnation /
  MLS key, explicit pins and out-of-band verification. The signature alone
  grants no access: a real KeyPackage validated by OpenMLS must present the
  certified key and the approved device. Changed root suspended, confirmed
  replacement erasing the old approvals, additive revocations after
  reopening, refusal of an old confirmation and of a new key under the
  same incarnation. Private root and decisions saved in the
  transactional vault; no private export API. Nine dedicated tests pass, i.e.
  23 Linux crypto tests plus the child actually killed; Clippy with keyring and
  all targets without warnings. Public vector accepted by Rust and by
  an independent Node / OpenSSL verifier. The previous batch `845ef86` is
  confirmed by all green jobs of workflow `37140904530`, including the three
  crypto platforms and the server / mobile / desktop / Swift regressions.
  Signed request / proof of possession, new-device ceremony,
  recovery, room policy and delivery remain open, with archive,
  files, Android bridge and review. No E2EE capability enabled; J4 stays open.
  [Format and rules](../crates/rv-crypto/IDENTITY.md).

- P19 / J4, checkpoint and system keyring (3 October 2026): Rust coordinator
  `protected::Manager`, OS lock owned until the end of the platform write,
  verification of the predecessor / protected confirmation before network / UI result.
  Canonical directory bound to the entry to refuse a database copied under another
  lock, authenticated empty genesis resumed after lost initial checkpoint,
  keyless tombstone before SQLite purge and refusal of a withdrawn incarnation.
  keyring 3.6.3 backend with explicit native Linux / macOS / Windows features;
  no mock fallback. Fourteen Linux tests pass, with keyring errors /
  ambiguities, local copy, removal, abandoned worker and inherited descriptor.
  The real Linux Secret Service driver passes: concurrent refused, process
  killed before checkpoint, new bus / daemon, outbox resumption and removal.
  Clippy with backend and example, formatting, syntax and verification of the CI
  scope on real disposable commits pass. A Linux / Windows /
  macOS crypto matrix keeps its own checks; the long client drivers remain required
  as soon as a client / server / workflow changes or consumes the crate.
  The previous vault `fdaaf33` has its four CI jobs green (`37138503102`), including
  Windows disk tests / forced stops. Android bridge, wiring to the apps,
  installed keyrings / Windows ACLs / power loss, destruction of
  old keys, identities / delivery / archive and review remain open.
  E2EE stays disabled. [Vault contract](../crates/rv-crypto/README.md).

- P19 / J4, transactional private vault (3 October 2026): isolated Rust crate
  [`rv-crypto`](../crates/rv-crypto/README.md), OS key / nonce, XChaCha20Poly1305,
  authenticated scope and OpenMLS provider / private records in a
  single SQLite commit. A refusal destroys the temporary provider; a tampered
  reception thus does not consume the durable state. Protected external checkpoint
  required, blocking until the marker is saved and resumption of only the authenticated
  successor after a crash between SQLite / keyring. Old head restored,
  changed scope, stale writer, SQL failure and oversized state are refused.
  Six Linux tests pass: MLS exchange after real disk reopening, forced stop
  before then after commit, AEAD / scope / limits / permissions / links.
  Formatting, Clippy without warnings, CI syntax and root lock unchanged pass;
  these tests join the server check. The previous prototype `f34e91e` is
  confirmed by the four green jobs of workflow `37135884643`.
  Real keyrings / checkpoint lock, interrupted initialization, purge,
  destruction of old storage keys, identities / delivery / archive and
  mobile bridge remain open. No client depends on the vault yet and
  no forward secrecy of the durable storage is announced. E2EE stays
  disabled; P19 / J4 are not finished. [Specification](rfcs/0002-e2ee-native.md).

- P18 / P19 / J4, crypto specification and prototype (3 October 2026):
  [RFC 0002](rfcs/0002-e2ee-native.md) details identity / devices, ordered delivery,
  removals, persistence, recoverable archive and RC compatibility.
  The working MLS choice uses OpenMLS 0.9.0 / RustCrypto 0.6.0, suite 0x0001,
  in a feasibility crate and a separate lock, with no dependency from the apps.
  Three scenarios verify Welcome / exchange, tampering / replay, removal and
  new device without automatic history. Two behaviors require application
  guards: a tampered reception consuming a key before refusal, a send
  possible in the old epoch with a prepared commit. Restoring the writes
  then reloading the group allows resuming reception in the prototype.
  Storage is in memory and delivery simulated; this is not a durable
  vault, an audit or a qualification of the app. The three tests, formatting,
  Clippy without warnings, syntax of the CI check and lock isolation pass.
  E2EE stays disabled.

- P20 / J4, mobile wiring to the existing calls (3 October 2026): room /
  profile buttons, activity card and same WebView screen routed to the
  account's provider. SQLite migration 0032: one start intent per
  room, ID kept after lost response / restart, no automatic start
  on reconnection. Purge on removal / re-membership / restoration, exact acknowledgment,
  per-account availability probes and view / session / membership guards.
  Ten targeted tests pass, plus the migrations and regressions of the caches / runner.
  The existing PostgreSQL bench mounts the real mobile binding with HTTP / WebSocket
  and on-disk SQLite: activity projected into the card, lost confirmation, resumption
  of the same ID after reopening, camera / microphone entry and late URL refused after
  unmount. Typing, lint and Android / Hermes export pass; inventory at
  369 files / 450 occurrences. The desktop batch `1e957ae` is confirmed by the
  four jobs of the native workflow `37131483850` and macOS `37131483848`, all green.
  The mobile batch `0444253` is confirmed by workflow `37134341411`, with its
  four Linux / Windows / Swift jobs, mobile regressions and Android export green.
  The real Jitsi service, media / moderation and the apps on devices remain
  to be qualified; P20 / J4 remain open. [Contract](protocol/MEETINGS.md).

- P20 / J4, desktop wiring to the existing calls (3 October 2026): room and
  profile buttons, join / info card and GTK / SwiftUI windows
  routed to the account's provider. The native activity keeps the meeting
  ID through to the existing cards. The SQLite core keeps the start
  before HTTP; the next click resumes the same ID after a cut / restart,
  with no automatic launch. Purge on re-membership / restoration and acknowledgment
  limited to the original intent; transient private URLs, shared links without
  JWT, HTTPS / origin / conference / expiry verification and account,
  navigation and membership guards. A profile call waits for the projection of the new DM
  by the journal before using its membership. Desktop capability enabled only
  with a configured server; mobile capability still disabled.
  Four storage / URL tests, three HTTP scenarios (replay after reopening,
  wrong scope / revocation / restoration, DM created from a profile), the
  real GTK card under Xvfb and eight Swift tests with regenerated bindings pass.
  Clippy core / FFI / GTK, formatting, 17 protocol tests, generator and inventory
  (368 files, 450 occurrences) pass. The Jitsi server workflow `9a1c884`,
  `37129062962`, is fully green (four jobs). The macOS compilation of the
  interface of this new batch remains to be confirmed in CI; mobile, real Jitsi
  service / media / moderation and installed applications remain open.
  [Contract](protocol/MEETINGS.md); P20 / J4 are not declared finished.

- P20 / J4, Jitsi server and transports (3 October 2026): private operator
  HTTPS configuration, HS256 limited to one conference / domain / audience / application,
  duration ≤ 120 s; shared link without token. Start bound to membership / epoch,
  durable receipts and one active conference per room; single structured activity.
  Private entry, authorized end and delivery lease protect the response against a
  concurrent end / revocation. Client capabilities stay disabled until
  wiring to the existing call screens. Four PostgreSQL / HTTP tests with
  mobile transport and independent Node verifier pass, as well as a
  configuration test, 17 protocol tests, 16 TypeScript transport regressions,
  mobile typecheck, lint without warnings and Clippy of the three touched crates.
  Quota of new operations, resumption of receipts after maintenance, revoked
  session and precise JWT expiry are covered. Checks and limits of the real
  service in the [contract](protocol/MEETINGS.md). This batch does not close P20 / J4.

- P21 / J3, Linux reply reactivation via portal v2 (3 October 2026):
  probe of the portal / purpose `im.reply-with-text` and GLib ≥ 2.86 before selection,
  native payload with actions exported from startup, target and text received
  via `org.freedesktop.Application.ActivateAction` in a `((ss)s)` tuple.
  Durable capture and private validation stay in the existing core / window.
  Display and removal are serialized per scope so that a late response
  from `AddNotification` does not keep a removed or replaced toast. Diagnostic
  consistent with the chosen backend; legacy providers kept.
  Two capability / payload tests, a disposable D-Bus server with delayed /
  replaced / removed display, GTK Clippy and the real compiled binary pass.
  The D-Bus script closes GTK, observes the loss of the name and compares the PIDs before /
  after a reactivation with a Unicode target and text; malformed parameters refused.
  No user account / installation is modified. The consulted Plasma v1 backend
  does not advertise this flow; it keeps the live reply.
  Installed portal v2 / Plasma, private account and OS notifications remain to be qualified.
  The two CIs of the persistent click `43ec7ea` are fully green:
  `37125203094` (four jobs) and `37125203112` (macOS).
  The portal v2 workflow `9413bae` is also fully green:
  `37127332646`, four jobs including the D-Bus script with its 30 s CI limit.
  P21 / J3 are not declared finished. [Contract and sources](protocol/PUSH.md).

- P21 / J3, persistent offline click (3 October 2026): minimal destination
  kept in the configuration SQLite before account resumption, with no text
  or bearer. A synchronous reservation before waiting for the keyring keeps the last
  click; late capture and acknowledgment cannot replace / erase the new one.
  GTK and SwiftUI resume the exact account before the default account, then
  validate message / root / membership / epoch in the same screens. The withdrawn
  OS registry and a bounded snapshot do not lose the captured destination.
  Temporary network errors kept for resumption; permanent refusals removed. Explicit
  navigation, new link, account change and logout cancel the wait.
  Checks: twelve targeted Rust tests (notifications, links and old
  responses), including eight HTTP click scenarios with on-disk SQLite, reopening
  after 503, root outside the cache, deletion, re-membership, restoration, replaced
  click and cancellation during resolution; oversized metadata refused.
  Eight Swift tests with regenerated bindings and Clippy core / FFI / GTK pass.
  The real compiled GTK binary is launched via D-Bus in a disposable XDG: description
  and dispatch of the action at startup pass, with refusal of a foreign scope.
  The two workflows of the previous batch `d90fdde` finished successfully:
  `37122994121` (four jobs) and `37122994132` (macOS).
  KDE with a stopped process, installed system notifications and imported J5
  links remain open. [Contract](protocol/PUSH.md).

- P21 / J3, offline replies before network validation (3 October 2026): GTK
  and SwiftUI record the reply and its receipt in the exact account's outbox before
  resumption / HTTP, even if the thread root is not cached. Destination metadata
  and attempt marker are durable, with no copy of text or bearer;
  `IMMEDIATE` transactions for two concurrent captures, cap of
  256 unresolved replies with no eviction. The ordinary flusher and a manual retry
  cannot bypass the private check of the message / root / membership / epoch.
  Permanent refusals and text remain in the usual failure states; purge of the
  room / account and restoration remove the intents. Removing a toast
  after reading does not lose a reply already accepted. After a lost
  confirmation, the message of the send ID is re-read under the same guards before any
  new POST, even if the notification target has since been deleted.
  Checks: 62 targeted Rust tests (notifications, links, projection
  transactions), including capture without HTTP, disk reopening, absent root,
  connection concurrency, removal / re-membership, changed generation, deletion
  and response loss after commit; eight Swift tests and compilation of the models
  with regenerated bindings; Clippy core / FFI / GTK without warnings.
  The CI `37121052414` of the COM batch `bf4cf8f` is fully green, including its
  new cross-process Windows test. The navigation click still pending
  offline stays in memory; cold KDE, installed flows and imported J5
  links remain open. [Contract](protocol/PUSH.md).

- P21 / J3, Windows reply activator (3 October 2026): local COM server
  `INotificationActivationCallback`, stable CLSID and HKCU registration / Inno
  Setup shortcuts, cleanup on uninstall. The COM launch switch is removed
  before GTK parsing; account / membership / epoch are checked by the native
  path delivered in the previous batch. AUMID, arguments and bounded UTF-16
  text are verified.
  The COM handler replaces the WinRT handler in memory when it is registered,
  so that a reply is not submitted twice to the Rocket.Chat provider.
  Nine Windows tests pass, including a second real process that instantiates
  the first one's COM class and hands it the reply; the bench modifies no
  registry of the user's Windows account. Seven portable tests, Fedora
  formatting and Linux / Windows Clippy without warnings pass; the Windows
  workflow adds these checks to its existing job.
  The AppKit CI `37119774771` of batch `abd21db` completed successfully:
  the menu visibility defect is fixed. The Swift model, Windows core,
  server / mobile and GTK bench jobs of `37119774779` are green: both
  workflows of the previous batch completed successfully.
  Launching from a real toast of an installed app remains to be qualified,
  as do cold KDE, actions durably waiting for the network and the imported
  J5 links; [contract](protocol/PUSH.md).

- P21 / J3, persistent notification actions (3 October 2026): SQLite registry
  of 256 destinations without content or bearer, written before handing over to
  the OS. The GTK / SwiftUI callbacks find the exact account again, wait for its
  rooms / connection, re-read the message / root privately and keep the initial
  membership. The reply and its ID are atomically recorded in the outbox with a
  local receipt: an identical callback after reopening does not create a second
  send. GApplication startup for GNOME, registered protocol for the Windows
  click, resumption handling in the SwiftUI AppModel. Five core tests, including
  on-disk SQLite reopening and real HTTP / WebSocket, seven OS bridge tests,
  Clippy of the four crates and eight Swift tests with regenerated bindings
  pass. The real GTK binary is activated as a D-Bus service in a throwaway XDG:
  the `(ss)` action description, dispatch of a foreign scope without an account
  and closing pass. This startup bench is added to the CI after the existing
  build, without rebuilding the binary. Linux installs add the service and the
  required desktop keys. The previous macOS CI revealed the internal visibility
  of `membershipIsCurrent` in the link menu; it is made public for the app's
  view. The server / mobile, GTK, Swift model and Windows core jobs of batch
  `830dd1b` are all green: its native-server CI completed successfully. The
  AppKit CI awaits the visibility fix in this delivery. Windows reply with a
  stopped process, cold KDE delivery, offline action before network validation,
  installed trials and imported J5 links remain open; [contract](protocol/PUSH.md).

- P21 / J3, native links and existing menus (3 October 2026): complete HTTP(S)
  service, distinct instance / epoch and notification recipient, strict parsing
  without scope fallback, current account or unique match on desktop, explicit
  Android gesture with validation before switching. GTK / SwiftUI wait for the
  connection and the rooms, reject results from a previous account / link;
  HTTP resolution of the message / real root with membership and generation
  barriers. The three current menus copy a shareable permalink without bearer or
  author account; native jumps compare decimal positions, existing threads
  reveal the reply. Five Rust tests (including real HTTP), 22 mobile checks,
  eight Swift tests via regenerated bindings, desktop typing / Clippy and
  Android Hermes export and Kotlin compilation of the Android receiver pass.
  Installed journeys, desktop notification actions persisted cold and
  resolution of imported J5 links are still open.
  [Contract](protocol/ROOM_LINKS.md).

- P17, fix after CI `74c787e` (3 October 2026): the macOS build is green; the
  server replay / privacy test revealed that the personal annotation added to
  HTTP reads was not present in the sync. The HTTP / WebSocket batches now fill
  in the captured mentions for their sole reader, without modifying the stars or
  the shared journal. A PostgreSQL test checks recipient, author and @here in
  the stream; the HTTP replay / privacy scenario passes with the updated
  personal expectation. The test keeps its independent check that no private
  stars are present.

- P17 / J3, desktop notification wiring (3 October 2026): live creations
  captured with the SQLite cursor, silent history / catch-up / edits,
  deduplication, preferences and read / membership barriers. The
  `Message.personal_mention` contract fills in the readers from the server
  capture, without a personal property in the shared journal. GTK and SwiftUI
  keep their notifications, with navigation to the message / thread and reply
  through the normal send queue; OS references are pinned to the account / epoch.
  Four core tests, including a real WebSocket and thread replies, seven
  PostgreSQL / HTTP tests and nine contract tests pass. Desktop / server Clippy
  and mobile typing pass; Swift bindings / models rebuilt and six local Swift
  tests pass. The nine Swift integration tests without a server are explicitly
  skipped, not counted as proof. AppKit compilation to be confirmed in the macOS
  CI; installed system notifications and cold-start actions (P21) remain open.
  The CI of the Android push `66b032b` is entirely green. [Contract](protocol/PUSH.md).

- P17 / J3, server push and Android wiring (3 October 2026): registry tied to
  the session family, atomic task capture, bounded leases / retries, FCM HTTP v1
  OAuth and an identifiers-only payload. The private read keeps the permission
  barriers until delivery. The current Kotlin plugin fetches the content via
  WorkManager and keeps the conversation notifications, with idempotent native
  reply, deduplication and links pinned to the account. FCM rotation also
  resumes, in the background, the native families already registered, without a
  bearer in the WorkManager queue. Six PostgreSQL / HTTP server tests, nine
  contract tests and 29 targeted mobile checks pass, as do typing / lint,
  Clippy, Android / Hermes export and real compilation of the Kotlin plugin in
  the Android app. The Gradle cache created for this workstream was moved to D:
  after C: filled up; the Guava dependency now exposes the `ListenableFuture`
  used to acknowledge the durable registration of a reply.
  The server, Linux / Windows desktop and macOS CIs of the cards batch `6c85995`
  are green. Real Firebase and a physical Android with the app stopped remain
  open. Desktop notifications: next P17 batch. [Contract](protocol/PUSH.md).

- P15 / J3, integration cards and activation (3 October 2026): contract
  `SendMessage.cards` / `Message.cards`, three pieces and 16 KiB in total,
  bounded text / links / fields and unknown properties rejected. Same send,
  permissions, replay fingerprint, journal and tombstone as messages.
  The GIN index of the cards completes text search. SQLite, temporary search
  and quote refresh keep the pieces; GTK uses its existing renderer, mobile and
  SwiftUI complete their current cards with the missing fields for both
  providers.
  Two contract tests, 24 targeted mobile tests, typing / lint, Android / Hermes
  export, desktop SQLite projection and UniFFI model, GTK widget and six local
  Swift tests pass.
  The macOS CI of the previous reader `1e073b1` is green, as are the Swift
  models and the Windows core. The server now advertises `structured_cards`,
  and `link_previews` if an object volume is configured; the mobile image bench
  no longer alters discovery. The PostgreSQL / HTTP benches verify permissions,
  replay, search, edit and erasure, as well as the real mobile provider and its
  presentation. [Contract](protocol/INTEGRATION_CARDS.md).
  Server and desktop Clippy without warnings; schema / types / inventory
  synchronized (356 production files, 443 occurrences).
  macOS compilation of the cards batch and qualification of installed
  applications remain open; P15 is not globally closed, the encrypted part
  belongs to J4.

- P15 / J3, desktop wiring of previews (3 October 2026): SQLite projection and
  temporary search results in the existing GTK / SwiftUI article, image and video
  cards. Private paths carry neither origin nor credentials; the shared reader
  checks the image and the current message after HTTP, then the membership and
  generation after decoding. Bounded cache, reuse after a reaction, removal after
  edit / revocation and new proof after re-membership, even for an identical
  opaque path.
  Direct images use the existing viewers; saving revalidates access before
  publishing the file. Two new core tests with HTTP / WebSocket / SQLite pass,
  among 361 core / UniFFI regressions.
  The real GTK widget under Xvfb displays the texture, reuses the cache, then
  removes it and reloads it after a membership change; this journey joins the CI.
  Core / FFI / GTK Clippy without warnings, formatting, bindings and six local
  Swift tests pass; sixteen connected Swift journeys remain conditional on
  their benches and are not run in this check. AppKit / SwiftUI compilation
  must pass the macOS CI of the commit. The server capability remains disabled
  in this batch. Structured integrations, activation and qualification of
  installed applications remain open; P15 is not globally closed.

- P15 / J3, mobile wiring of previews (3 October 2026): the existing article,
  image and video cards read the native SQLite projection.
  Private references are tied to the message / descriptor / membership and to
  the account's reader; bounded cache, four simultaneous reads, temporary
  search and removal of pixels after edit / deletion / revocation.
  A reaction without an image change keeps the cache. The viewer keeps zoom and
  saving; the export re-reads the current message, checks access before the copy
  and erases its temporary file.
  Verifications: 48 final targeted tests pass; general mobile suite of 1,241
  tests without failures, typecheck, generated schema / types, Rust Clippy and
  Android / Hermes export succeeded. The PostgreSQL bench uses real HTTP,
  WebSocket and SQLite for private read, cache and removal after edit.
  Targeted lint succeeded; the React Compiler rules already failing in the
  viewer were disabled only for its local check, without modifying the
  configuration or its existing gesture code.
  The CI files test now waits for the exact revocation lock, avoiding confusion
  with a release of a previous reply; its PostgreSQL regression passes. GTK /
  SwiftUI, structured integrations, server activation and qualification of
  installed applications remain open in P15.

- P15 / J3, preview collection (3 October 2026): bounded native metadata,
  PostgreSQL tasks with content generation, leases, retries and deadline;
  the network runs outside the transaction. Public DNS fully verified then
  pinned, redirects revalidated, private / loopback networks and remote
  authentication refused. HTML / images bounded; thumbnails normalized to PNG
  and served with session / membership / current message verified. The Rust
  transport verifies fingerprint and dimensions. [Contract](protocol/LINK_PREVIEWS.md).
  Verifications: 18 targeted tests pass, including seven with PostgreSQL and a
  real SDK / HTTP read; mixed DNS refusals, chunked limits, expiry during a real
  journal wait, revision / deletion / epoch and read permissions covered.
  Workspace Clippy without warnings, Rust corpus and contracts, edit / deletion
  regression and operator CLI pass; the desktop core compiles with the additive
  contract and its lockfile synchronized.
  TypeScript schema / types synchronized, typecheck and 14 mobile SQLite tests
  pass; no interface rework is delivered in this server batch.
  The capability remains disabled until the existing mobile / GTK / SwiftUI
  cards are wired; caches / invalidation, videos and integration cards remain
  open. The operator health test now follows the latest compiled migration,
  fixing CI failure `33` versus a frozen expectation of `32`.

- P07 / J3, custom emojis (3 October 2026): versioned operator catalog,
  shared receipts / audit, normalized PNG / JPEG import and bounded GIF, unique
  names / aliases without masking Unicode, private images with size / fingerprint
  check. The live stream announces revisions; the SQLite caches hide removed
  entries and refuse late catalogs, including after restart. The existing
  pickers, completions, message bodies and reactions on mobile / GTK / SwiftUI
  use this catalog and their protected readers. A lost reaction keeps its
  canonical name after an alias change; a removed emoji can no longer be added,
  but its existing reaction can be removed. Verifications: 4 PostgreSQL journeys,
  1,230 mobile tests, typing / lint and Android / Hermes export; 359 desktop core
  / UniFFI tests, clippy and 2 targeted floor / image / capability mask tests.
  The real GTK widget passes 11 checks; Swift file / emoji models against the
  server and Secret Service pass in 3 s. The real mobile HTTP / WebSocket /
  SQLite provider displays the private pixels, canonicalizes the reaction and
  removes names / pixels after an operator deletion. The CI of the previous
  batch is green on the desktop clients; its only mobile error was the table
  assertion forgetting `native_upload_intents`, fixed and verified here. macOS
  compilation of the new batch, installed Android and desktop animation remain to
  be qualified; P07 / J3 remain open. [Contract](protocol/CUSTOM_EMOJIS.md).
  Next: P15 cards.

- P14 / P07, quoted files (3 October 2026): authorized resolutions include the
  descriptors of the current source message, without creating a link or a
  permission in the destination room. The caches keep the files in the source
  tied to its membership, without artificial history or a private copy of a
  descendant in the parent. Deletion, a more recent unavailable view, removal /
  re-membership and generation also close the read of an old manifest still in
  cache. The existing mobile / GTK / SwiftUI cards pick up the protected images
  and summarize documents / voice messages / videos, down to the second quote
  level. Additive contract generated, server and desktop Clippy succeeded; 7
  PostgreSQL quote / file journeys, 34 targeted mobile tests, typecheck / lint
  and 370 desktop tests pass. The GTK composer passes 8 checks under Xvfb;
  the Swift models pass quote / file read and the existing login / actions /
  threads / resumption journey. Two CI assertions that still expected the
  disabled files were fixed, keeping the check of the intersection of
  server / client capabilities. macOS compilation and the installed interfaces,
  codecs and the mobile module remain to be qualified; P14 is not globally
  closed. Next J3 item: custom emoji catalog.

- P14 / J3, desktop wiring (3 October 2026): existing GTK / SwiftUI composers,
  progress, retry / abandon and readers wired. Private copy, fingerprint and
  durable SQLite intents; resumption after lost responses, reception of the
  current message and offline abandon. Streamed / verified cache, Range for
  reuse, temporary search, closing after removal and private path for the Swift
  readers. Two SQLite tests pass; the PostgreSQL bench and the GTK composer under
  Xvfb pass without a screenshot. The real Swift models are compiled and tested
  with Secret Service. Codecs, installed applications and quoted files remain
  open; no global P14 closure.
- P14 / J3, mobile wiring (3 October 2026): `uploads` queue, progress,
  retry / abandon and current readers / share wired. SQLite intent 0030
  atomic with the private origin file, fingerprint, membership and two stable
  IDs. Real HTTP / PostgreSQL / SQLite resumption after lost prepare, transfer
  and confirmation responses: one message per intent. Offline abandon proven
  after restart, without a message. Private cache streamed and verified before
  rename, reader URLs without credentials, revalidation of reads / Range,
  cache removal on generation change and temporary search files.
  The Android / iOS Expo module transmits from disk without redirection; when
  absent, the button stays disabled. 103 targeted tests pass in 5.8 s; typecheck /
  lint, Android autolinking and Hermes export succeeded. Native compilation of
  the new module and the installed readers are not validated by this export:
  APK / iOS rebuild and devices remain to be qualified. GTK / SwiftUI and quoted
  files are the next wirings, J4 keeps responsibility for the encrypted part.

- P14 / J3, server-side files and transports (3 October 2026): reservation
  tied to membership / generation, streaming on the volume, size / SHA-256 /
  signature verified, transfer leases and atomic message confirmation.
  Logical quotas, cancellation / expiry, resumption without a second message and
  protected download with Range and per-frame revalidation. Descriptors in
  history / snapshots / journal, tombstones without files; empty caption and
  file retention after edit. Seven dedicated PostgreSQL tests pass
  in 3.1 s, including the real TypeScript transport with two lost responses,
  in-flight cancellation and reader removal between two frames. Rust streaming
  explicitly exercised; 28 server tests, 7 transports, 6 profiles / avatars and
  9 contracts passed, as well as Clippy; repeated edit check after adapting
  the caption. 21 TypeScript SDK tests, typecheck / lint and 9 desktop core
  checks pass. The dependency locks include SDK streaming without
  changing the drivers' HTTP versions. Contract: [FILES.md](protocol/FILES.md).
  The outboxes, attachments / readers of the three existing interfaces are
  the immediate follow-up; installed qualification, quoted and encrypted files
  remain open. Both CIs of the administration batch `ff4a75f` are entirely green.
  No new client is created.

- P23, operator administration (3 October 2026): CLI for accounts / permissions /
  deactivation, rooms / members / settings, paginated lists, audit and diagnostics.
  The commands return persistent receipts; an old receipt does not reapply
  its state after a reactivation and a concurrent identical ID creates only one
  room. Device revocation under the delivery lock, retention of accounts /
  passwords / factors / conversations and propagation through the existing
  journal. The transactional audit excludes secrets and messages; the operator
  role remains distinct from application permissions. Verifications: server
  Clippy and 14 PostgreSQL tests (5 administration, 4 invitations, 5 recovery),
  including a real CLI binary scenario and a wait on the delivery lock. Nine
  Swift scenarios connected to PostgreSQL / Secret Service pass in 31.3 s after
  fixing the reconnection wait of the profile test; incremental compilation
  12.4 s. The GTK scenario also waits for the peer account's connection before
  its profile: Clippy, Fedora compilation and 44 checks of the real binary pass.
  Compilation of the macOS views of the previous batch is green in CI 37093755876.
  Contract in [ADMINISTRATION.md](protocol/ADMINISTRATION.md). Installed
  qualification, import / restore and J5 operations remain open; J3 continues.

- P16, desktop DM identities (3 October 2026): the existing GTK / SwiftUI lists
  and headers display the current name and protected photo of their
  counterpart. Common core projection, SQLite link by UID and membership,
  offline resumption, purge after removal / membership or authority change and
  refusal of a live photo older than that membership. The information button
  opens the same public profile card by UID. Photo removal erases the DM's
  pixels. The macOS CI flagged the loading of the profile attached to the Devices
  section; it now belongs to the Settings view that owns this model.
  Verifications: 13 targeted Rust tests and clippy; 43 checks of the real GTK
  binary, including name / photo in the DM, card by UID and removal. Swift
  bindings and models compiled; connected journey against PostgreSQL / Secret
  Service succeeded in 6.7 s (incremental compilation 14.3 s), with renaming and
  avatar removal in the other account's DM.
  Compilation of the macOS views to be confirmed by
  CI and installed qualifications still open; independent next step: P23.

- P16, desktop personal forms (3 October 2026): GTK reuses its editor
  and SwiftUI its form, behind the account's provider. Profile / status,
  512-pixel PNG photo, language and notifications go through the common
  intents; private verified email in Security, recent proof / resumption / abandon.
  Draft revisions kept against a concurrent change; profile notification
  without cancelling a current avatar. Verifications: 12 Rust tests /
  clippy; 39 checks of the GTK binary with profile saving; Swift model
  against PostgreSQL / Secret Service in 1.4 s. Session ID access error
  detected by macOS fixed, views to be revalidated by CI. Desktop DM list
  metadata / photos and installed qualification remain open in P16.

- P16, desktop public cards (3 October 2026): same GTK / SwiftUI dialogs and
  same message tiles, profiles by UID, live renames and DMs by stable UID.
  Authenticated avatars bounded to 128 entries / 32 MiB / four downloads,
  removal / replacement and late responses protected. The core and UniFFI
  share the persistent personal commands (profile / preferences / photo)
  without duplicating private data in the public cache. Targeted SQLite / HTTP
  verifications: restart, generation, lost response and replay without restoring
  an old profile: 12 targeted tests in 1.8 s and desktop clippy pass. Scenarios
  added to the existing GTK and Swift benches; local Swift compilation verified,
  execution with a server reserved for the CI bench. The desktop personal
  editors and settings remain to be wired; P16 stays open.

- P16, mobile personal profile (3 October 2026): "Mon profil" and the existing
  settings edit name / username / bio / status, bounded PNG photo and native
  language. Private email read-only with a pointer to the verified P02 journey;
  existing identity confirmation for a recent proof. SQLite migration 0029,
  original profile / preferences / avatar intents, immutable bytes, resumption
  after a lost response and restart, refusals kept and explicit abandon. Ordinary
  resets preserve the account's commands; another generation purges them.
  Unmodified preferences are kept; the push setting stays hidden
  until P17. Verifications: 40 targeted tests in 1.5 s, typing / lint, real
  HTTP / PostgreSQL / WebSocket / SQLite bench in 9.7 s (compilation 3.3 s),
  including replay after a lost response without overwriting a more recent
  concurrent modification.
  The CI of the previous public batch is green on its four jobs. Wiring of the
  cards / settings / caches and GTK / SwiftUI intents, then installed
  qualification remain to be pursued; P16 stays open.

- P16, mobile public cards (3 October 2026): the existing profile sheet
  opens from authors / mentions with its provider's data.
  Preloading guarded on account change, identities / avatar versions
  propagated by the live stream to SQLite, earlier reads refused. The photo
  tiles of messages, DMs and cards receive local PNGs coming from the
  authenticated transport; bounded memory cache, concurrency limited to four and
  purge on close. Removal / replacement erases the pixels, even in case of a
  late response. The Message button resolves the current UID even after a rename.
  Verifications: 25 targeted mobile tests, typing / lint and real HTTP /
  PostgreSQL / WebSocket / SQLite bench; this journey does not qualify the
  Android screen.
  Mobile personal editor / preferences and GTK / SwiftUI wiring remain
  the follow-up of P16; no other client or interface is created.

- P16 / J2 / J3, profiles foundation (3 October 2026): public APIs without email,
  personal profile with private verified address, name / bio / status commands
  and separately versioned preferences. Username change protected by recent
  proof; idempotent personal receipts, conflicts and shared budget of 20/minute.
  PNG / JPEG avatars on a local volume: bounded decoding, re-encoding without
  metadata, durable finalization before the SQL reference, authenticated
  downloads and immediate invalidation of old URLs. Orphan cleanup after crash,
  delivery check and statuses retained across devices. Common DTO / schema and
  Rust / TypeScript transports available; public profile stamps in the live
  photos, without changing the journal. The client masks remain closed:
  persistent intents and wiring to the existing mobile, GTK and SwiftUI
  cards / settings / caches are the next step, before declaring P16 delivered.
  Targeted verifications: 5 PostgreSQL API tests, 2 live regressions, 7 native
  transport tests, 14 protocol tests; Clippy of all targets of the three root
  crates. 19 mobile transport tests, typing / lint, generated schema
  and inventory conformant. The desktop live cache passes its targeted test.
  The CI keeps all its checks; Fedora / Swift / server / check images
  are now cached via Buildx, Cargo caches saved per commit with
  restore from matching dependencies. The efficiency of these caches
  remains to be measured on the next runs; no time saved is claimed.

- P13 / J2, search (3 October 2026): PostgreSQL text index of the written text,
  access limited to current members, roots / replies paginated by exact
  position and response capped at 50 messages / 512 KiB. Edit / deletion
  update the index; a quote does not index the private text of its source.
  Separate budget of 20 searches / minute / device and delivery barrier on
  session / memberships. Temporary results wired to the same mobile,
  GTK and SwiftUI screens, without history or cursor writes. Their context
  distinguishes accounts / rooms; access losses, mutations and suspension expire
  them, whereas a read refresh keeps them. Re-run with Enter.
  Verifications: 211 root Rust tests, Clippy; 221 desktop unit tests
  (204 core, 11 bindings, 6 GTK), Clippy of all targets and GTK compilation;
  1,193 mobile tests, typing / lint, generated fixture and inventory conformant.
  The real mobile PostgreSQL / WebSocket / SQLite provider verifies results
  outside the window, threads, permissions, existing rendering and suspension.
  GTK passes 36 real checks, including search / new query / suspension, without
  capture. The connected Swift model passes with real bindings and keychain. Both
  P12 CIs of commit `d6a94f3` are green. P13 / J4 part still open: local index
  of decrypted content, indication of available history and purge on lock.
  Installed qualification open. [P13 contract](protocol/SEARCH.md).

- P12, presence / typing (3 October 2026): PostgreSQL UNLOGGED per-device leases,
  60 s presence and 10 s typing; active renewal, stop and rate-limited
  emission on the client side. WebSocket snapshots negotiated separately from the
  journal, 8 s local expiry, real identity of a DM's counterpart and membership
  tokens verified; removal / re-membership, revoked session and restoration
  do not revive an old typing state. The existing GTK / SwiftUI / mobile
  composers and indicators are wired. `@here` captures only the
  online / busy members at first send; a later edit or connection
  adds no ping. No temporary state enters the outbox or SQLite.
  Verifications: 209 root Rust tests, Clippy, generated contracts; 349 desktop
  core / bindings tests, 6 GTK tests and workspace Clippy; 1,191 mobile tests, types and
  lint, then 3 targeted monotonic clock tests. Two real mobile
  PostgreSQL / WebSocket / SQLite providers verify typing via the existing
  engine, the DM counterpart, stop / suspension and membership purge.
  GTK passes 33 widget / composer checks under Xvfb and Secret Service,
  including 6 new presence / typing checks, without a screenshot. Two connected
  Swift journeys pass with the real keychain, including presence / emission /
  stop / suspension. The CI of the previous batch `33a7084` is entirely green.
  Qualification of installed applications open. [P12 contract](protocol/LIVE.md).

- P11, threads (3 October 2026): separate roots / replies, counters and last
  reply, thread pages and monotonic per-thread reads delivered on the Rust / transports side.
  Same mobile screen and same GTK / SwiftUI panels: durable reply keeping
  its root after restart, clean draft, quotes in the thread and counter
  in the room without a second root. Root deletion: old replies
  viewable, old committed send replayable, new send refused and draft
  kept. Removal / re-membership: purge of private data and old callbacks
  refused. Snapshots keep 50 roots and 50 replies per room.
  The real mobile provider against PostgreSQL verifies lost confirmation,
  SQLite restart, replay after deletion, independent reads and removal.
  GTK runs the real menus / composers / cards without capture; the Swift
  models open, reply, quote and resume the draft in the existing panel.
  Verifications: two PostgreSQL thread scenarios, four SQLite scenarios of the
  desktop core, mobile cache tests and exact common Rust / TypeScript fixture.
  Global validation: 207 server / protocol tests (two targets fixed then
  revalidated), 361 desktop tests, 1,187 mobile tests then the shared contract at
  16 tests after adding its thread fixture. Clippy, GTK compilation, Swift
  generation, typecheck / lint and inventory pass. The GTK journey comprises 27
  successful checks; the connected Swift journey passes. Installed Android / Windows / macOS
  qualification still open. [P11 contract](protocol/THREADS.md).

- P07, nested quotes (3 October 2026): personalized resolution over two
  levels, eight references per source, permission and position specific to each child.
  The shared journal remains made of references; a parent source keeps
  no descendant private copy. The desktop / mobile caches reuse the existing
  cards, cut cycles and refresh indirect dependencies after edit, deletion
  or removal. A late response does not restore the withdrawn text, even after
  reopening the mobile cache.
  Verifications: 205 server / protocol tests, 357 desktop tests and 1,185
  mobile tests; formatting, Clippy, typecheck, lint, generated schema and inventory pass.
  The real GTK composer / widget passes 15 checks. The journey of the Swift
  models connected to PostgreSQL / keychain verifies nested sending then the purge
  of the deleted child alone (one test run, none skipped).
  Contract: [native quotes](protocol/QUOTES.md). Quoted files and
  trials on installed applications remain open; P07 is not closed.

- P07, structured room activity (3 October 2026): creation, members,
  settings and roles published in the transaction of their action; replays without
  duplicates, counters without system activity, message actions refused.
  Projection into the existing translated mobile / GTK / SwiftUI rows,
  kept in SQLite, without a new component or screen.
  Contract: [system messages](protocol/SYSTEM_MESSAGES.md).
  Local verifications: 203 native Rust cases covered by the global suite
  and the targeted resumptions of the history hypotheses; 356 desktop tests;
  1,183 mobile tests then the final projections and separator targeted
  (31 tests), typecheck / lint. The real GTK widget and the Swift models
  against PostgreSQL / keychain pass; no Swift test skipped. The CIs of the
  previous commit validated SwiftUI, Windows, server / mobile, GTK quotes
  and Swift models; the remote email GTK bench was still running at this
  report. Qualification of installed applications remains open.

- P07, quote controls of the existing applications: the Reply action,
  banners / cards and composers of GTK, SwiftUI and mobile use native
  references; Rocket.Chat permalinks keep their historical path. Queueing
  transmits the selection tied to the membership, accepts a quote alone
  and keeps the words after a local rejection. Removal / modification of a source
  purges the open previews; the unavailable label is translated in the current
  cards. The GTK renderer now displays these cards even without a
  Rocket.Chat session, a condition that prevented their display in the cache-only batch.
  Flat quotes enabled by `quotes` on the server side and intersection of
  client / server capabilities. The GTK journey under Xvfb clicks the real reply menu,
  confirms the send, inspects the card widgets, deletes the source and verifies
  purged preview / kept words; reproducible scripts added to the native CI.
  The real Swift models and the keychain pass the corresponding scenario; the
  mobile provider passes PostgreSQL / HTTP, lost response, on-disk SQLite,
  removal and identical replay. Trials without a configured server or with a bad
  fixture are not used as proof.
  Regression: 201 native workspace tests, 1,182 mobile tests and 355 desktop
  workspace tests succeeded,
  typecheck / lint, Android export, Clippy and GTK compilation pass. The additional
  render / masking checks are verified after adjustment. The CI of batch
  `43f2f3e` is green (`native-server` 37063060051, `desktop-swiftui` 37063059954).
  Nested quotes and quoted files J3, system messages / custom emojis and
  installed qualification remain open; P07 is not closed.
  [Contract](protocol/QUOTES.md).

- P07, durable quote-send bodies: the desktop core, the mobile engine and
  the UniFFI bridge select the confirmed sources from the existing cache.
  Queueing rechecks revision, generation and source / destination membership
  in the local transaction; only the ordered references travel to
  the server. SQLite reopening, reset, source removal and retry keep the
  initial body. The existing optimistic cards lose the private excerpt after
  removal, and the old text intents keep their replay.
  The real mobile engine, HTTP / PostgreSQL and on-disk SQLite verify lost
  response after commit, removal, resumption without duplicate, conflict on an
  edited source and new selection. No desktop / mobile screen or component is
  created or replaced; wiring to the current controls is the next step.
  The CI `37056782968` of the previous batch revealed a stale edit that lost
  its draft before queueing. Desktop and mobile now keep this intent
  as failed with `revision_conflict` without sending it; the Swift scenario
  that was failing passes against the real server and secure storage.
  Local verifications: 1,181 mobile tests and 355 desktop workspace tests
  succeeded, without failures or ignored tests; typecheck, lint, all-target Clippy and
  GTK compilation succeeded. The real Swift test passes after a fresh compilation.
  The Swift CI objects have a distinct cache, without restoring from different sources,
  to avoid reusing objects after the UniFFI bindings change.
  The `quotes` capability, the unavailable label, the reply controls and the
  installed Android / macOS / Windows trials remain open: this batch does not
  close P07. [Contract](protocol/QUOTES.md).

- P07, quote retention on edit: the existing GTK / SwiftUI / mobile commands
  capture the ordered references in SQLite with
  their text, expected revision and nonce. Source removal, reset and resumption
  keep the initial body; the adapter sends it in `content.quotes`.
  An old edit without a captured body stops, keeping its draft for
  a new submission. The migrations are additive and no edit view
  or Rocket.Chat transport is replaced. Targeted tests: 53 mobile and 43 desktop
  cache succeeded, with inaccessible source, exact values, response loss,
  SQLite reopening and migration; typecheck, lint and core Clippy pass.
  Full regression: 1,179 mobile tests and 353 desktop workspace tests
  succeeded, without failures or ignored tests; Android export, all-target Clippy
  and GTK binary rebuild succeeded. Inventory, protocol generation
  and changelogs valid. These local results do not validate a physical
  installation of the apps.
  Sending quotes from the current controls and the installed trials
  remain open; `quotes` capability still disabled.

- P07, mobile quote cache: additive SQLite migration for ordered
  references and source views, with membership and exact position independent of
  the quoting reply. Edits / deletions / access losses refresh the
  `pieces_jointes` column observed by the existing `Citation` component.
  Reopening, reset, generation change, cursor rollback and late responses
  are covered in the real database. Native texts resembling a Rocket.Chat quote
  prefix are kept on mobile and desktop; handling of
  official quotes remains available.
  Verifications: 38 targeted tests then 1,176 full mobile tests succeeded,
  without failures or ignored tests; typecheck, lint and Android / Hermes export pass.
  Desktop core: six piece / quote tests and nine cache tests pass,
  with Clippy on the workspace. History and positions above JavaScript
  precision remain intact at migration. The cache does not close
  the physical Android / macOS / Windows trials. The unavailable labels,
  durable reply / edit commands, nested quotes and quoted files
  remain open; the `quotes` capability remains disabled.

- P07, desktop quote cache: ordered references and source views are
  persisted separately in SQLite. The edits / tombstones received from a source
  refresh its quotes in other rooms. Removal, new membership and
  reset purge its excerpts; old revisions, old memberships and unavailable
  results are arbitrated without restoring a deleted text. An HTTP response
  can refresh the source view without replacing a more recent quoting response.
  The list and selection reads project this data into the existing GTK /
  SwiftUI cards, with their Markdown, without touching the screens.
  Targeted verifications: nine SQLite cache tests succeeded, including reopening,
  cursor rollback, removal / re-membership, dated absence, deletion, reference
  order and values beyond JavaScript precision; two UniFFI model tests
  succeeded, including a quoted source outside the history window and its
  tombstone in the real shared models. Full regression: 351 desktop
  workspace tests succeeded, Clippy without warnings, GTK binary rebuilt;
  inventory and changelog valid.
  Mobile cache, unavailable label, reply menus and durable intents remain
  to be wired; `quotes` capability still disabled and P07 still open.

- P07, quote resolution positions: excerpt, source membership and
  instance position are read in a single SQL view. Results without an excerpt
  also carry this position; a deleted source message keeps the reader's
  membership duration, protected by the delivery proof. This gives the
  existing caches the order needed to reject late excerpts after deletion
  or removal, independently of the quoting reply's revision. Values remain
  exact beyond JavaScript precision and the text is bounded in Unicode
  characters. No screen or message component is replaced.
  Targeted verifications: five PostgreSQL quote tests, two delivery
  protections and eight Rust contract tests succeeded; server workspace Clippy,
  type generation, mobile typecheck and one mobile contract test pass.
  The native CI of commit `fc1d6ac` is green (`37047824309`): server /
  mobile verification, GTK, Windows core and Swift models.
  Wiring and purge in the client caches remain the next point;
  the `quotes` capability remains disabled.

- P07, server-side quote references: bounded commands and receipts
  including the references, resolution of excerpts according to the reader's
  membership, current revision and source membership duration, erasure at tombstone.
  The shared journal keeps the references without an excerpt. Message reads,
  history, pins / stars, snapshots and replay personalize the rendering.
  The delivery proof also keeps the source rooms of the excerpts; the
  cross-quote transactions take the rooms in a single order.
  The capability remains disabled until the existing cards and caches
  of the three clients are wired. [Contract and exit conditions](protocol/QUOTES.md).
  Local verification: 199 server workspace tests succeeded against PostgreSQL,
  including personalized quotes / journal, receipts and tombstones, concurrent
  cross-quotes and two source delivery protections; server and
  desktop workspace Clippy without warnings. The desktop cache test affected by
  the DTO passes; mobile typecheck and four native rendering tests pass. Schema,
  generated types, emojis and inventory do not diverge.
  The CI check of the documents batch `d278c3e` exposed the old size
  assumption of the snapshot scenario; the dataset now includes the document's
  cost in the JSON, with the same budgets and refusal of a partial result.
  The CI of commit `8563f22`, fix included, is green: server /
  mobile / desktop / Swift models workflow `37044250870` and SwiftUI macOS `37044732568`.

- P07, native documents to the existing renderers: `Message.text` remains
  the source and `body` provides a typed `native1` document, without a Rocket.Chat
  `md` tree or rendered HTML in the protocol. The provider adapters translate this
  document to the same GTK / SwiftUI / mobile widgets; no screen or
  composer is replaced. The markers of the existing composers keep
  bold / italic / strikethrough. Mention recognition and presentation share
  the parser, with per-occurrence exclusions, depth / traversal limits,
  and full fallback to plain text. Fifteen cases verify styles, code, text
  quotes, tasks, nested lists, links, escapes, Unicode and emojis.
  The local desktop / mobile trees are compared exactly; the runs of the
  common core also serve SwiftUI. The real PostgreSQL / HTTP /
  mobile journey verifies the corpus, SQLite, edit, refusal of an old replay, erasure
  of the body in the journal and ACL. Local verification: 340 desktop tests and
  1,164 mobile tests of the full suite, then 2 desktop rendering tests and
  34 targeted mobile tests after the marker adjustment; formatting / Clippy,
  typecheck / lint and Android Hermes export succeeded. The 11 PostgreSQL cases
  pass with the final corpus. The real GTK connected to the server shows the
  two rich messages in the current widgets at 435 px, with the document in
  SQLite and the composer contained in the window. The Swift bindings / models
  build under Linux: 6 tests succeeded and 11 skips tied to the environment,
  then the connected room management test succeeds in 3.58 s. Qualification
  of the installed Android / macOS / Windows applications remains open.
  Message quotes with ACL,
  system messages and native emoji catalog remain the rest of P07; P11
  replies / P12 presence are not announced by this rendering. [Contract](protocol/MARKDOWN.md).

- P05, existing read controls: confirmed badges roots + replies and
  mentions, separator tied to the opening position and visible ID timers
  wired in GTK / SwiftUI / mobile. The screen's membership duration is
  rechecked in the SQLite transaction; positions remain exact strings
  and only the display counters are bounded. An acknowledgment does not
  move the opening bar and a burst does not push back the timer.
  GTK verifies the bounds of the linked widgets, the active window and focus in
  the content; SwiftUI tracks visibility, keyboard window and panels. The
  mobile uses FlashList's visible indices and its displayed data,
  in the foreground on the active route; exit / background flushes only
  the IDs already seen. No retry substitutes the cache's last message.
  Verifications: 339 desktop tests, Fedora Clippy / GTK compilation; 1,160
  mobile tests, typecheck / lint and Android Hermes export. The ten PostgreSQL
  journeys pass, including the mobile controller used by the view, the real
  provider, lost response, closed callback and old witness after re-membership.
  The Swift bindings / models and six local tests pass; the connected journey
  reads a first message while keeping the next one unread, keeps the
  bar and refuses earlier models after re-invitation. The real GTK verifies
  hidden window without read, visible position saved offline, badges
  kept then cleared on acknowledgment, and bar kept. 435-pixel capture
  inspected. Inventory: 318 files / 443 occurrences. Both
  workflows of the reads batch `0a2147b` are green (`37032625434`,
  `37032625413`), including the new SwiftUI views on macOS; qualification
  of installed applications open. P11 replies and P12 `@here` remain their
  next batches.

- P05, favorites in the existing interfaces: GTK and SwiftUI offer the action
  in the room card and menu; mobile keeps its card's button.
  The active provider uses the native protocol or the official Rocket.Chat
  route. Only the confirmed personal state changes the ranking. The click
  captures favorite revision and membership duration, verified in the SQLite
  transaction before an intent is created. Resuming keeps the original ID; a
  refusal requires erasing that exact ID. GTK keeps its card cached offline
  to present the request, without restoring old metadata.
  Verifications: 336 desktop tests, formatting / Clippy and Fedora GTK compilation;
  1,153 mobile tests, typecheck / lint and Android Hermes export. The ten
  PostgreSQL journeys pass, including the mobile provider called by the button, with
  loss of HTTP responses and recovery without a second write. The Swift bindings
  compile, six local tests pass and the connected journey with Secret
  Service verifies offline wait, confirmations and rejection of an old click.
  The real GTK binary verifies menu, visible wait, confirmed add / removal and
  refusal of the obsolete click; the 435-pixel card is inspected. Inventory:
  315 files / 443 occurrences. After fixing the assignment of the favorite
  error in the SwiftUI view, both `49a88dd` workflows are green
  (`37025290486`, `37025290897`), including the macOS compilation of the views. Trials
  on devices remain open. The next wiring of badges, separators
  and timers is recorded in the increment above.

- P05, buffers of open rooms: the GTK / SwiftUI / mobile composers
  attach draft reading, saving, erasure and sending to the membership
  duration that opened them. The check and the SQLite write are atomic.
  Removal or new membership erase the private buffers / forms; an
  old cleanup cannot overwrite the new draft. Role changes
  keep the text. Mobile waits for its first read of the witness before
  mounting the composer; GTK and Swift close the views whose witness changed.
  Verifications: 335 full desktop tests, Fedora Clippy / compilation and ten
  targeted unit tests of the last guard; 1,152 mobile tests, typecheck / lint
  and Android Hermes export. The ten PostgreSQL journeys pass, including the real
  mobile store kept after missed removal / re-membership. The existing GTK journey
  verifies role / draft then departure / empty composer. The Swift bindings
  and models compile, six local tests pass; the connected journey
  with Secret Service verifies re-invitation and rejection of old saves / sends.
  Inventory: 312 files / 414 occurrences. The four jobs of the durable batch
  `2eb3ecb` are green (`37014714087`). Badges, favorites and timers of the
  existing interfaces remain to be wired; trials on devices remain open.

- P05, durable mobile / desktop intents: SQLite keeps the position of the
  confirmed message actually observed, then groups observations by exact
  maximum. The favorite keeps its ID, expected revision and original value;
  after a lost response the runner reads its receipt before any PUT.
  A confirmed receipt stays saved until a current read covering its
  version, without restoring a historical preference. Refused forms require
  erasure of their exact ID; removal / new membership or generation
  purge both queues. The read and favorite timeouts are separate: the
  read quota keeps socket, sends and favorites available.
  Verifications: 332 full desktop tests, then four targeted HTTP / SQLite
  journeys, Clippy and Fedora GTK compilation; 1,149 full mobile tests then
  four targeted network journeys (one new), typecheck / lint and Android
  Hermes export. The ten PostgreSQL journeys pass: the real mobile runner
  misses two responses, recovers the receipts without a second write, keeps a
  later unread message and purges its queues after re-membership. Inventory:
  310 files / 414 occurrences. The four CI jobs of the cache `19871f0` are
  green (`37009882605`). Buttons, badges, timers and cleanup of the open buffers
  of the existing interfaces remain to be wired before activating the capabilities.

- P05, mobile / desktop confirmed cache: SQLite separates versions of the
  metadata and of the personal state. New reads do not roll back the room's
  name nor invalidate its permissions; old responses restore no
  favorite. The membership witness also detects a missed removal / re-membership,
  purges the old private content / drafts / intents and invalidates
  in-flight responses. A modified role keeps the membership duration. The first
  witness purges the intents of an old cache that had none; the
  desktop recovers the witnesses already present in its old room payloads.
  Verifications: 322 desktop tests and Clippy / GTK compilation in Fedora;
  1,138 full mobile tests then eight targeted cases (one new), typecheck
  / lint and Android Hermes export. The ten read journeys and the fifteen existing
  native / room journeys against PostgreSQL pass, with real mobile SQLite migration / database,
  snapshot after missed removal / re-membership and rejection of an earlier response.
  Inventory: 308 files / 414 occurrences. The CI of the P05 server / transports
  `c4a9f95` has its four jobs green (`37006738251`). The durable read /
  favorite queues and the existing controls remain the next increment.

- P05, server-side mentions: exact usernames of active members resolved at
  first send, `@all`, repetitions deduplicated and priority of the named mention
  over the group. Code, quotes, links, escapes and encoded names
  trigger no false recipient. An edit removes the deleted mentions
  without notifying a new recipient; read / deletion and
  re-membership remove the old badges. `@here` depends on the P12 presence
  leases and remains text until that batch. Verifications: 186 native
  workspace tests pass, including six Markdown cases and ten PostgreSQL /
  HTTP read journeys. The real mobile transport also exercises mentions, edit and read.
  The quota of 60 real advances keeps reads / favorites available.
  Durable controllers and wiring to the existing P05 interfaces remain open.

- P05, first server / transports batch: personal states attached to rooms
  after checking recipients / memberships, without private data in the shared
  journal. Reads by maximum across two devices, root counters
  excluding one's own send and decreasing on deletion, explicit favorites with
  independent revision and personal receipts. Removal / re-membership renews the
  membership duration and purges the preference; a modified role does not renew it.
  Old receipts restore no preference. Six PostgreSQL /
  HTTP scenarios pass, including the real mobile transport with lost response and receipt
  recovery without a second write. The full native workspace passes its 175 tests,
  then the sixth dedicated scenario added also passes (176 in total).
  The 1,131 mobile tests, typecheck / lint, and the 314 desktop tests, Clippy /
  GTK compilation in Fedora pass; schema / types and inventory reproducible.
  Mentions, durable controllers and P05 UI remain open; client capabilities
  still masked and replies reserved for P11. [Contract](protocol/READ_STATE.md).

- P04, existing composers: GTK / SwiftUI / mobile use the effective `send`
  permission, with an exception for owners / moderators in a read-only room.
  The cards keep the global setting. SQLite ties these hints to the
  account, generation and room version; a new version invalidates them.
  Removal / re-membership and late responses restore no permission.
  Concurrent reads are grouped and the existing drafts / send intents
  remain durable. The server remains the authority for every send.
  Verifications: 314 desktop tests, formatting / Clippy / GTK binary, 1,128 full
  mobile tests then three targeted permission cases (one new), typecheck /
  lint and Android Hermes export. Six local Swift tests and the connected
  PostgreSQL / Secret Service journey pass: blocked member, authorized owner,
  promotion then demotion refreshing the composer. The real mobile
  provider / PostgreSQL also verifies HTTP refusal of the member and the moderator's send.
  GTK runs the same owner / member pass in the real form and
  composer, then transfer / departure and purge, at 435 pixels; its capture
  is inspected.
  P04 development is finished; the qualifications of the installed
  applications remain open. The next batch is P05, reads / unreads,
  mentions and personal room favorites. The macOS CI of batch `a4df1fd`
  (`37000328250`) and its four native jobs (`37000328247`) are green.

- P04, controls in the existing cards: mobile / GTK / SwiftUI expose
  the settings, the paginated member list, roles and departure according to the
  current permissions and provider capabilities. The forms keep their
  revision; resuming an original command, explicit erasure of a refusal
  and re-reading of permissions before the form revision are accessible.
  No operation identifier is displayed. The Rocket.Chat journeys remain
  selected by their provider. P04 remains open for the effective
  composition permissions in the composers, already enforced server-side.
  Local verifications: 312 desktop tests, formatting / Clippy / GTK binary,
  1,126 mobile tests, typecheck / lint without warnings and Android
  Hermes export. The Swift bindings / models compile; six local tests pass,
  eleven remain conditional on their benches. The new connected Swift journey
  passes with real PostgreSQL and Secret Service: settings, promotion of a
  second owner, demotion and departure, refusal of the last owner
  and explicit erasure. The real mobile provider resumes a receipt after
  response loss without a second PATCH against PostgreSQL. GTK runs the settings,
  roles, transfer / departure and refusal of the last owner at 435 pixels; the
  captures are inspected. The installed applications remain to be qualified.

- P04, settings / roles / departure intents: SQLite saves the original
  command before HTTP on desktop and mobile, then consults the personal receipt
  before each resumption. A lost response and a restart do not reapply
  the mutation; revisions are never silently refreshed.
  Final refusals keep the form until explicit erasure; temporary
  errors use the existing backoff. Removal / generation change
  purge the private intents; a receipt projects no setting.
  The three commands are verified with real HTTP and on-disk SQLite databases,
  plus conflicts, foreign receipts, read errors, removal and closing.
  Verifications: 312 desktop tests, Clippy / formatting, 1,124 mobile tests,
  typecheck / lint without warnings and Rocket.Chat inventory up to date.
  The controls of the three cards remain the next batch: their mutation
  capabilities are still masked. The CIs of the cards `6a081df` are entirely
  green: four native jobs (`36988516194`) and macOS (`36988516235`).

- P02, last wiring of e-mail recovery: the existing mobile / GTK / SwiftUI forms
  offer an explicit anonymous request and resumption. Opening the form and the
  countdown make no network call; the generic receipt does not claim to confirm
  that the account exists or that the message was delivered. A request that is
  expired, acknowledged or tied to an older generation is kept until its explicit
  local erasure. The received code / new password use the recovery flow already
  shipped, followed by the normal two-factor authentication.
  GTK and Swift share the new `Form` coordinator, with a private candidate,
  view revisions and cancellation of late actions; no nonce crosses the FFI.
  Verification: 306 desktop tests, formatting / Clippy / GTK binary, six local
  Swift tests, 1,113 mobile tests, typecheck / lint with no warnings and an
  Android Hermes export. Ten connected Swift tests remain conditional on their benches.
  The GTK form and the real Secret Service are run twice against a disposable
  HTTP fixture: opening without a POST, a single explicit anonymous request,
  no account activated; the 435-pixel captures are inspected. This fixture
  is not an SMTP / PostgreSQL trial, which is already covered on the server side.
  The installed Android / Windows / macOS keychains and the external SMTP relay
  remain to be qualified with the devices / access needed. The CI of the vault
  batch `cd69389` (`36975796250`) is fully green (four jobs).
  Functional e-mail development is closed for this stage; the next batch
  is P04, roles and server / room settings. No new SMTP batch is planned.

- P04, existing room details: neutral reads in the mobile provider,
  shared GTK `RoomInfo` model and existing SwiftUI `RoomDetails` binding.
  Topic, description, announcement, member count and read-only state are displayed
  without a new chat screen. The `room_info` announcement is intersected with the client;
  native favorites stay hidden until P05. The owner keeps their GTK
  invitation form. Revision changes refresh the details, including a topic
  changed without a name change. Account closing, room removal and a replaced
  generation discard late responses.
  Verification: 307 desktop tests, Clippy / GTK binary, 1,118 mobile tests,
  typecheck / lint with no warnings and a fresh Android Hermes export. Swift
  bindings / models compiled: six local tests pass, ten flows conditional
  on their benches; the connected flow of the existing models passes against the
  real PostgreSQL and Secret Service, with a topic change on another
  device. GTK renders the details at 435 pixels, refreshes the topic while it is
  open, then closes the dialog after the reader is removed; the three captures
  are inspected. The bench is disposable; the installed Android / Windows
  / macOS keychains remain to be qualified. Durable commands and controls for settings,
  roles and leaving are the next P04 batch. The previous foundation `fcb411d` has its
  four CI jobs green (`36984189328`).

- P04, server-side details / roles / settings and transports: migration 0022,
  bounded metadata, paginated member list and an opaque revision independent
  of messages. Owners set visibility / read-only / texts
  and roles; explicit transfer and leaving protect the last owner.
  The administrator has no implicit private access. Original commands
  have personal receipts, also after demotion / leaving, without
  replaying an old setting or deleting a re-membership. Invitations, removals
  and memberships now publish a fresh revision for all members.
  The affected snapshots are invalidated, and delivery of details / members
  holds back its version until the HTTP body is actually submitted. Verification:
  170 native workspace tests, including eight dedicated PostgreSQL / HTTP scenarios
  and one stale-delivery test; the real TypeScript transport exercises transfer,
  demotion and a receipt after leaving against this server. 1,116 mobile tests,
  typecheck / lint, 306 desktop tests and Clippy pass. Schema / types / inventory
  are verified. [P04 contract and limits](protocol/ROOMS.md). Durable wiring
  to the three existing screens remains the next batch; P04 stays open.
  The previous e-mail batch `2b46b48` has both CI runs fully green: native
  `36979565276` (four jobs) and macOS `36979565203`.

- P02, e-mail recovery request vaults: the common Rust coordinator
  GTK / Swift and the mobile vault keep the original operation before HTTP,
  without received code / password / address / bearer. Private namespace per URL and
  username, instance / generation scope, conservative local delay of one hour,
  generic acknowledgement and local closing protected against old views.
  Reading sends nothing; an ambiguous response resumes the same candidate and an
  expired request is never replaced automatically. The desktop OS lock
  stays held by the real keychain write after the caller is cancelled.
  Mobile uses SecureStore and a queue shared by the vault instances.
  The received `Retry-After` is kept after the vault is recreated; the Rust SDK
  also shares this cooldown between clones while leaving discovery available.
  Twelve new Rust tests and twelve TypeScript tests pass, as do the 303 desktop
  tests, Clippy, 1,113 mobile regressions, typecheck and lint. The inventory is
  regenerated: 296 files scanned / 344 occurrences. The GTK / SwiftUI / mobile
  request buttons and their connected flows remain to be wired.

- P02, server / SDK password recovery by e-mail: migration
  0021, anonymous request with generic acknowledgement, random intent bound to
  the instance / generation and mail only to the already verified contact.
  256-bit code valid for one hour, hash in the existing recovery and an
  encrypted outbox sharing the SMTP budgets of the other producers. Resumption
  of the same code after an ambiguous SMTP response, deleted / limited requests
  persisted as opaque receipts and contact details erased after account
  deletion, without reactivation when a username is reused. Confirmation
  re-verifies contact / authority / generation under lock, changes the password
  without a session, keeps conversations / factors / backup codes and revokes the
  old families. Replaying the receipt does not revoke a new login.
  The vaults and request buttons in the three clients remain to be wired;
  the existing recovery form accepts the received code through the same API.
  Twelve dedicated PostgreSQL tests pass: real HTTP / SDK requests without
  bearer, shared worker / loopback SMTP relay, ACK loss, concurrency,
  restart, contact changed during the acceptance lock, generation,
  deadline, deletion / reuse of the username, budgets and wrong key.
  A real conversation and the TOTP profile are kept; the backup code allows
  a new login that replaying the receipt does not revoke. The five tests of
  legacy operator recovery stay green. Full verification:
  154 server tests and seven protocol / client tests, 151 native TypeScript tests,
  1,101 mobile regressions, 291 desktop tests, formatting / Clippy, typecheck / lint,
  schema / generation / inventory with no divergence. These tests use a
  disposable PostgreSQL and synthetic addresses; they do not qualify
  external deliverability or an installed keychain. The native CI `36971804421`
  of commit `be42f85` passes its four jobs, including the existing connected GTK /
  Swift / mobile benches. The test PostgreSQL is deleted after verification.

- P02, enrollment of the e-mail factor in the three clients: explicit buttons
  in the existing mobile / GTK / SwiftUI settings, confirmations bound to the
  contact and the displayed profiles, view guard and resumption of the private receipt. The
  backup codes share their presentation / copy / acknowledgement with TOTP.
  The address controls explain and prevent its replacement or removal
  while the e-mail profile is active. Disabling TOTP or e-mail describes how
  the other profile is kept; e-mail alone allows the common backup codes.
  The mobile, GTK and Swift benches each pass three real processes, with
  PostgreSQL, a contact verified by SMTP / TLS and lost activation / removal
  responses. After activation, they confirm identity again with a backup code,
  also lose the proof responses and recover its receipt before removal.
  SQL requires a single family / credential, two origin profile operations,
  a single contact mail, no OTP sent and the contact kept after removal
  of the last factor. GTK / Swift use Secret Service; mobile recreates its
  provider, its SQLite projection and a portable private storage on disk.
  These benches join the CI in three distinct projects. The 291 Rust desktop tests,
  Clippy / GTK build, 1,099 mobile tests, typecheck / lint / Android export,
  bindings and six local Swift tests pass. The FFI checks refuse
  a stale revision or a closed handle. The GTK view without secrets is verified
  at 435 × 760. Inventory: 295 files / 344 occurrences. The bench's private
  services and volumes are deleted after verification. SwiftUI macOS build
  and installed qualifications remain separate checks.
  The CI `36966528293` of the vault `9c35bbb` passes its four jobs, including
  the connected OTP / TOTP / contact regressions of the two desktop clients.
  The native CI `36968362558` of the batch `6a6a48c` passes its four jobs; macOS
  `36968362546` builds, packages and starts the application with SwiftUI.
  Account recovery by e-mail is the P02 wiring in progress.

- P02, e-mail factor enrollment vaults: the Rust desktop
  and mobile coordinators keep the operation, the displayed contact and the version of the profiles
  before HTTP, in the same private vault as TOTP / backup codes. A lost response
  resumes the receipt and the original ten codes; a concurrent request cannot
  replace this receipt before its acknowledgement. Contact / generation / family,
  closing, refused storage and stale versions are checked. Removal
  stays available without SMTP and keeps TOTP / backup codes if it remains installed.
  The common backup codes can also be regenerated with an e-mail profile alone.
  Six new Rust tests and nine dedicated TypeScript tests pass: 291 desktop tests
  and 1,099 mobile tests in total, formatting / Clippy / GTK build,
  typecheck / lint / Android export, bindings and six local Swift tests.
  The inventory counts 294 files / 344 occurrences. The desktop transport
  also verifies the removal route with the TOTP / SMTP capabilities absent and
  refuses a vanished profile capability before HTTP. These vault tests
  do not yet replace a positive connected enrollment flow through the
  widgets: the mobile / GTK / SwiftUI buttons are the next wiring.
  The native CI `36963735968` of the Swift OTP batch `e0ee062` passes its four jobs,
  and its macOS CI `36963735943` passes build, package and launch.

- P02, SwiftUI OTP challenges: the existing screens offer e-mail at login
  and at identity confirmation. `NativeLoginAttempt` / `NativeSecurity`
  expose status, deadline, capability and displayed revision; the candidates and
  challenge / delivery IDs stay in the Rust vault. Sending, resumption and resending
  are explicit. The real send job keeps its lock after foreign
  cancellation; closing and a stale revision block late callbacks. The
  status also distinguishes e-mail alone from TOTP to keep the right authenticator
  setup actions. Real bindings, model compilation,
  six local Swift tests and 285 Rust desktop tests / Clippy / GTK build
  pass. The new Swift bench passes three processes and Secret Service with
  real HTTP, PostgreSQL and SMTP / TLS. It loses the delivery /
  confirmation responses, tests resumption after restart, resend delay, closed handles
  and stale revisions, without logging the codes. SQL confirms two consumed
  OTPs, a single family / credential, an unchanged proof age, three SMTP
  admissions with the initial contact and the ten backup codes kept. This
  bench joins the Swift CI with its own database / proxy, independent of GTK.
  The existing Swift TOTP / backup code / contact bench also passes its three processes
  and its SQL check with the new bindings. Both benches and their private volumes
  are deleted after validation. The native CI `36961965082` of the GTK
  batch `1f11eba` passes its four jobs, including the new GTK OTP flow.
  Compilation of the SwiftUI view is checked by the macOS CI; installed
  devices / native keychains remain to be qualified. Explicit enrollment
  of the factor in the three clients and e-mail recovery remain the next
  P02 wirings.

- P02, GTK OTP challenges: the existing login and identity-confirmation forms
  offer e-mail, status, explicit send / resumption and resend.
  The keychain resumes an ambiguous delivery after restart without recreating the
  challenge; hiding the view cancels its guard. The code is cleared on each command
  and stays transient. The real GTK bench uses a previously verified contact,
  its explicitly enabled factor, PostgreSQL and a local SMTP / TLS relay.
  Three processes with Secret Service lose the delivery and confirmation
  responses then recover the delivery, the session and the origin proof.
  SQL finds two consumed deliveries, a single family / credential, a
  complete proof with its initial age, three SMTP admissions (contact included),
  no OTP payload kept and the ten backup codes unchanged. Resending during
  the cooldown adds no mail. The real empty form is checked at
  435 × 760; no code is captured. This bench joins the GTK CI in a distinct
  disposable project. The 285 Rust desktop tests, Clippy, GTK build and
  regenerated inventory (293 files / 344 occurrences) pass. The native CI
  `36959580252` of the foundation `d08c4f3` passes its four jobs. SwiftUI, enrollment
  of the factor in the three clients, e-mail recovery and qualifications
  on devices remain to be pursued.

- P02, desktop OTP vaults: the Rust coordinator keeps the delivery in
  the initial login or reauthentication challenge, under the same OS lock
  and in the private keychain. Sending saves its candidate before HTTP,
  resumes a lost response and distinguishes an explicit resend with a re-read delay.
  Scope, view guard, private metadata and deadline are verified; entered
  codes stay transient. A new password proof does not
  replace an ambiguous delivery before the expiry barrier. Without SMTP,
  the receipt and an already sent code remain usable on the same challenge. The
  old formats remain readable. Ten dedicated tests pass among 285 Rust
  desktop tests; Clippy, GTK build and regenerated inventory pass. The
  HTTP checks also verify no bearer before login, family
  kept for the proof, capability disappearance and changed generation.
  Generated bindings, build and six local Swift tests pass. The
  existing GTK and Swift TOTP / contact benches each pass three real processes
  with Secret Service and their PostgreSQL check, on two distinct
  disposable projects: their response-loss proxies must not be shared.
  They qualify vault compatibility, not yet a rendered and connected
  OTP flow. The private projects and volumes are deleted.
  The GTK / SwiftUI forms are not yet wired to these operations.

- P02, Swift private copy during reconnection: the CI `36955805765` of the
  mobile commit `020b5b6` revealed a race between backup code regeneration
  and their copy. The FFI read resumes the same receipt after reconnection, with
  the same family, displayed revision and view guard; no new mutation
  is triggered. The connected flow forces this reconnection and keeps
  the refusals of a stale copy or one after closing. Local verification: 275
  Rust desktop tests, Clippy, GTK build, bindings and six local
  Swift tests pass; three Swift processes with the real Secret Service and PostgreSQL
  check pass. The disposable bench and its private volume are deleted.
  The native CI `36957450999` of the fix `3a4d12f` passes its four jobs;
  the macOS CI `36957450981` passes build, package and launch.
  Wiring the OTP challenges to the desktop forms is the next point.

- P02, mobile OTP challenges: login and identity confirmation offer e-mail
  in the existing forms, with resumption of the delivery candidate in the
  private vaults, view guard for resends and preservation of the deadline.
  Eleven vault tests pass. The driver of the real provider, HTTP, PostgreSQL,
  loopback SMTP and SQLite deliberately loses the four start /
  finish responses and finds two deliveries, two proofs and no duplication.
  The 1,090 mobile tests, typecheck, lint and Android / Hermes export pass.
  The full native check passes: 142 server tests, 7 protocol / client,
  140 native TypeScript, Clippy and generated contracts.
  The portable driver does not close validation of the Keystore or the installed rendering.
  The desktop challenges and explicit enrollment of the factor in the three clients
  remain the next P02 wirings.

- P02, explicit e-mail factor on the server / SDK side: migration 0020, conditional
  enrollment and removal with private receipt, OTP on an existing login or
  reauthentication challenge, resumption without resending and bounded resends of the same code.
  The initial deadlines are not extended. The queue shares the SMTP budgets and
  keeps no business lock during transmission. Nine PostgreSQL tests
  and three transport tests pass: concurrency, lost response, ambiguous SMTP ACK,
  TOTP coexistence, absent relay and expiry under a real lock.
  The full check passes: 141 server tests, 7 protocol / client, 129
  native TypeScript, Clippy and generated contracts; the 1,079 mobile tests, the
  typecheck and the lint also pass.
  The CI `36953451597` of commit `b887462` passes its four jobs: server /
  mobile, Windows core, connected GTK and connected Swift.
  The OTP forms and vaults of the three clients are the next wiring;
  account recovery by e-mail and external qualifications remain open.

- P02, independent factor profiles: migration 0019, common authority view
  and authenticated validation of the e-mail profile key on its exact contact.
  Login and reauthentication consider e-mail alone or coexistence; the
  old TOTP proofs keep their identity. Backup codes belong to the
  account and are erased only when the last factor is removed. Changing the
  reference profile requires a new proof; a TOTP enrollment presents a
  single replacement list, without adding up the old backup codes. The routes
  block removal / replacement of the active contact; the SQL constraints
  refuse its removal or the change of its version.
  Eight PostgreSQL tests pass, including a real migration from 0018 with pre-existing TOTP,
  counters, consumed backup codes and login proof left intact.
  The full check passes: 132 server tests including the 27 factor regressions,
  7 protocol / client tests, 126 TypeScript tests, Clippy and generated contracts.
  The rebuilt server Swift bench passes three processes and the SQL check
  with the real Secret Service, local SMTP TLS and lost responses. No e-mail
  enrollment or OTP issuance was exposed in this first foundation; batch 0020
  above wires them on the server and SDK side.

- P02, common SMTP budget: extraction of the persistent admission of
  verification into a shared component, keeping the keys of the commands
  already admitted. The future OTP / recovery purposes will share the
  global, per-account, per-address and per-IP limits. Five PostgreSQL tests cover concurrency,
  resumption after restart and saturation, address case, expiry,
  absence of private values in clear text and cancellation under the real quota lock.
  The full check passes: 124 server tests, 7 protocol / client tests,
  126 TypeScript tests, Clippy and contract generations. This component does not
  yet make the e-mail factor or password recovery available.

- P02, desktop contact removal: buttons in the existing GTK / SwiftUI settings
  and a single private entry shared between verification and removal.
  The format of the old verifications stays readable; no removal keeps
  the old address. A confirmation pins contact / revision before HTTP;
  old revisions, providers, closed views and generations are refused.
  The OS lock stays held during keychain work cancelled on the caller side.
  A lost response keeps the initial operation; Cancel does not relaunch the
  start and a winning acceptance stays visible until Finish. A receipt
  cleaned without a recorded acceptance does not allow inferring success from the
  mere absence of an address. The contact stays viewable and removable without SMTP,
  while new verifications follow their own capability.
  Verification: 22 contact tests including 12 for removal, HTTP guards without SMTP /
  TOTP, 275 Rust desktop regressions, Clippy and GTK build pass; generated
  bindings, build and six local Swift tests succeed. The GTK / Swift PostgreSQL
  benches each pass three real processes with Secret Service and local SMTP
  TLS: lost verification start / confirm, lost removal, resumption after
  a further restart, explicit closing and old callback refused. SQL keeps
  one family, one proof with its age, two consumed backup codes, one regeneration,
  one admission and one removal, with no old contact, challenge or job. Removal leaves
  the second factor active before its deactivation, explicitly tested separately.
  A first GTK scenario found the old dialog still closing:
  the wait now targets its actual disappearance; the full bench passes.
  The final view fits at 435 px and displays no private code. SwiftUI
  compilation is confirmed by the macOS CI `36944950019` of commit `b06487b`:
  build, package and startup succeeded. Its native CI `36944950072` passes
  server / mobile, GTK and Windows core but fails in the Swift bench: no
  verification start had been sent after the regeneration reconnection.
  The bench now requires a fresh view before explicit submission and separately
  observes the responses actually lost by the disposable proxy. Its fix
  passes build, six local tests, three connected processes and the PostgreSQL
  check of the rebuilt server. The fix and the SMTP budget of commit
  `fab08e0` pass the four native jobs `36947405591` and macOS `36947405670`.
  E-mail factor,
  recovery and installed keychains / apps remain the rest of P02.

- P02, mobile contact removal: button with native confirmation in the existing
  settings, pinned revision / focus and transient inputs.
  SecureStore holds a single e-mail intent, verification or removal,
  before HTTP; the old verifications stay readable. Removal keeps
  scope / versions / operation and receipt, without the old address. A lost
  response stays unconfirmed, a known acceptance requires its versions and
  the absence of a contact; a receipt cleaned without a recorded response stays stale.
  Cancel never relaunches the start and keeps a winning acceptance until
  Finish. The contact stays readable / removable without SMTP or TOTP
  configuration, and an unreceived verification can be closed after SMTP is stopped.
  The connected bench reuses the same bearer and the same family against a second
  runtime without SMTP / factor key. It cancels before receipt, refuses an old
  start, loses the removal response, refuses a private write then
  resumes the receipt. PostgreSQL finds one family, one admission and one removal
  receipt, with no contact, challenge or job remaining.
  Verification: 12 removal vault tests, 12 verification tests and provider
  guards; 119 server tests and 7 contract / client, 126 SDK tests and
  1,076 mobile tests pass, with Clippy, typecheck, lint, Android bundle and
  contracts. The line markers of the Rocket.Chat inventory are regenerated
  after the translations. ADB sees zero connected devices on 2 October 2026.
  The `native-server` CI of commit `10eade4` is fully green (run
  `36941624686`, four jobs: server / mobile, Fedora, Windows core and Swift).
  The GTK and SwiftUI buttons / vaults, the e-mail factor and recovery
  remain the rest of P02. The installed widgets / SecureStore remain open.

- P02, server / SDK contact removal: migration 0018 and three private routes
  start / resume / retire, with an additive capability independent of SMTP. The
  first removal requires a recent proof and the displayed versions; it
  deletes the contact, old challenges and delivery payloads on all devices,
  without changing family, bearer, factors, password or proof age.
  The hashed receipt, without the old address, lasts five minutes. Replays, cleanup or
  replacement of the contact do not allow removing a new address.
  Cancellation compares contact and head: it blocks a late start and preserves
  a new verification under the same head after a contact change.
  Fourteen Rust PostgreSQL / HTTP / SDK tests cover these races, absence of
  SMTP, authority, deletion of old codes and deadlines expiring under
  lock. The [e-mail contract](protocol/EMAIL.md) specifies the guarantees.
  The full suite passes: 119 server tests, 7 contract / client tests, 112
  TypeScript SDK tests, Fedora desktop workspace, 1,062 mobile tests, typecheck
  and lint. A first parallel launch of the builds exceeded the one second of an
  old locking test; this test passes in isolation then in the suite
  with `RUST_TEST_THREADS=4`. No product test or delay was modified.
  The `native-server` CI of commit `39177c1` is fully green, with Fedora,
  Windows core, server / mobile and Swift models / benches.
  The mobile / GTK / SwiftUI removal vaults and buttons remain the next
  batch; the e-mail factor, recovery and installed devices remain
  open. This foundation does not close P02.

- P02, desktop e-mail address: forms in the existing GTK / SwiftUI settings,
  FR / EN translation and a Rust vault shared with proofs and factors.
  The candidate precedes HTTP in the keychain; no entered code or private
  operation identifier crosses the Swift ABI. The displayed revision binds its
  actions to the right attempt. Nine tests cover ACK losses, refused / altered
  delay / identity, old receipt, write failure and two vaults under one OS
  lock, held until the real end of the write after the caller is cancelled.
  The GTK (435 px) and Swift benches pass with two processes, real Secret
  Service and local SMTP TLS: attempt pending at restart, lost confirmation
  resumed without another code, receipt explicitly closed, refused address
  cancelled without removing the contact. PostgreSQL requires one family, one identity
  proof, one mail admitted / confirmed and the delivered payload erased. All
  workspace desktop tests / Clippy pass; the Swift models compile
  with actually generated bindings. The CI runs of commit `0336f62` pass:
  `native-server` (Fedora, Windows core and Swift models) and SwiftUI macOS
  build / startup. The installed Windows / macOS keychains remain open.
  The mobile refused-address correction also passes against HTTP / PostgreSQL /
  SMTP, with 11 vault tests and 1,060 mobile tests green, typecheck and lint.
  Contact removal, e-mail challenges and recovery remain in P02.

- P02, mobile e-mail address: the existing Security section displays the private
  contact, offers a code and its delivery status, then resumes / cancels a
  verification or confirms its receipt. Inputs disappear on exit /
  suspension; the candidate and the versions stay in SecureStore through five
  scope fields. The security queue serializes HTTP and storage. Old
  callbacks, address replacements, altered identities or delays are refused.
  Ten vault tests and one provider guard test cover these invariants.
  The connected bench uses the real provider, SQLite, HTTP / WebSocket,
  PostgreSQL and loopback SMTP: start / confirm ACK losses, receipt write
  failure, resumption without a second code or a new family. Its code-reading
  route is private to the test build; its private storage is
  simulated. Verification: 105 server tests, 7 contract / client tests, 109
  TypeScript SDK tests and 1,059 mobile tests; typecheck, lint, contracts, inventory
  and Android export pass. Qualification of the widgets / SecureStore on an
  installed app remains open. ADB sees zero connected devices, an AVD
  `Medium_Phone_API_36.1` is available for the next installed bench.
  The GTK / SwiftUI settings, contact removal, e-mail challenges and
  recovery remain the rest of P02.

- P02, e-mail challenge cleanup: migration 0017 and durable reservation of the
  device head. Cleaning up an expired challenge can no longer allow
  replaying an old start with a new deadline, nor a new candidate
  under the same head. Explicit removal opens the next head. The PostgreSQL
  regression and the full suite pass: 104 server tests, 7 contract / client tests
  and 98 TypeScript SDK tests, with Clippy and generated contracts.

- P02, verified e-mail address on the server / SDK side: migration 0016, private routes
  start / resume / confirm / retire and status with delivery barrier and
  `no-store`. The additive capability is published with SMTP and operator key
  configured. The account confirms its identity on the current family; the
  contact stays out of the directory. The original receipt neither extends the deadline nor the proof
  age, creates no bearer and does not modify the factors. The per-device
  head protects against delayed starts / confirmations / removals.
  Challenge and encrypted queue are atomic, with persistent quotas per account,
  address, IP and instance; the worker does SMTP outside business locks with lease,
  retries of the same code and initial deadline. A local relay loses the ACK then a
  new runtime delivers the same code. Real TLS exchanges cover STARTTLS,
  implicit TLS, refusal of an unknown authority and refusal of the wrong certificate name.
  Expiry during the budget lock is re-read before creation, and an expired
  family can no longer deliver a job already queued. Local verification:
  32 library tests and 71 server integration tests, 7 contract /
  client tests, 98 TypeScript SDK tests; Clippy, schema / generation / inventory,
  mobile typecheck and lint pass.
  The [e-mail contract](protocol/EMAIL.md) details the states and bounds.
  The forms of the three clients, contact removal, e-mail challenges,
  recovery and qualification with a real relay / devices remain
  open. This batch does not close P02.

- P02, SMTP foundation: Rust transport with required TLS, mounted private JSON
  configuration, bounded message templates, four simultaneous sends and a total
  deadline of 30 s. Tokio work keeps the permit after the caller is cancelled.
  This first batch did not yet publish an e-mail route or capability. The five
  transport tests pass: configuration / injections,
  private file and symlink, refusal of a relay without TLS, loopback SMTP exchange and
  cancellation; Clippy, 90 server tests, 7 protocol / client tests and 95 TypeScript
  SDK tests pass, as do schema / generation / inventory. The
  [e-mail contract](protocol/EMAIL.md)
  sets out what follows: verified address, durable encrypted queue and quotas, explicit
  challenges, recovery that keeps the factors and wiring of the three
  clients. The local TLS exchanges are qualified in the next batch above;
  deliverability of the production relay remains open.

- P02, SwiftUI settings / FFI object: the Security section joins the existing
  grouped preferences, on the `NativeChat` and the current family.
  The opaque object shares the `rv-core::native::security` vault with GTK; the
  candidates / proof, operation and receipt IDs stay internal. Inputs
  are transient and confirmations are bound to the displayed revision.
  The copy re-reads intent and version before its MainActor callback, itself still
  conditioned on account / provider / visibility. Closing and suspension
  erase the private values and invalidate the callbacks; Refresh can
  resume the same intent after reconnection without replaying password or
  code. The dedicated PostgreSQL bench with two Swift / Secret Service processes
  passes login and proof with lost ACKs, incorrect code, regeneration,
  receipt resumption after restart, stale confirmations, copy during
  closing, old provider and deactivation with a lost ACK. The SQL checks
  confirm a single family, a complete proof, two consumed codes,
  one regeneration and the original age. Swift bindings and models compile; six
  local tests pass and eight flows stay conditional outside the bench, including
  this new flow actually run twice. The 240 core / FFI tests,
  Clippy and GTK build pass. This bench joins the Swift CI job; the
  macOS CI of commit `c45cdc6` built and packaged the SwiftUI interface then
  started the app and its gallery / soak flows. The keychains of the installed
  apps remain distinct from the Linux test. SMTP / verified e-mail remain to be delivered.

- P02, GTK settings / common desktop vault: the existing preferences and
  the Devices dialog open identity confirmation on the current family.
  TOTP setup, ten backup codes with explicit confirmation,
  regeneration and deactivation use `rv-core::native::security` and the
  existing private keychain. The dialog stays bound to the URL / UID / family /
  instance / generation; entered secrets are erased before sending and on
  closing. HTTP and KV operations are serialized by an OS lock,
  held by the real storage work even after the caller is cancelled.
  Responses from an old connection are refused. Refresh resumes the original
  intent after the reconnection caused by a factor mutation;
  it never resends the password or another code.
  Eight tests cover start / finish resumption and activation / replacement /
  deactivation, unavailable / corrupted storage, lock after cancellation,
  old provider, late response and removed capabilities. Verification:
  240 core / FFI regressions, Clippy and GTK build succeeded; inventory and
  changelog checked. The FFI `live` test stays conditional in this suite.
  The disposable PostgreSQL bench with two real GTK / Secret Service processes
  exercises password, incorrect code, lost start / finish ACKs,
  regeneration, private receipt after restart, backup code confirmation and
  deactivation after the socket generation changed. SQL confirms a single
  family, a single complete proof, two consumed backup codes, a single
  regeneration and the original proof age / expiry. The rendered dialog
  fits at 435 px and the captures exclude private codes. This bench is added
  to the desktop CI job. SwiftUI is wired in the next batch above. SMTP and
  the physical keychains / devices remain the rest of P02; this batch does not
  qualify an installed Windows or macOS app.

- P02, mobile settings / vaults: the Security section of the existing screen
  sets up TOTP, keeps then confirms the ten backup codes, regenerates or deactivates
  the factor. Identity confirmation stays on the current family, including
  for revoking another device. Private vaults bound to the URL / UID /
  family / instance / generation, intents persisted before HTTP, entered
  passwords and codes transient. Callbacks lose their right to act on
  leaving the screen, suspension, logout or provider change.
  The TOTP controls follow the capability; the password proof stays
  available without a TOTP operator key. No new client or chat screen.
  The additive route removes an expected proof head before replacing an
  absent / expired pending, then the vault probes the original candidate again.
  The PostgreSQL barriers preserve the age / provenance of existing proofs
  and prevent late resumption of an old start / finish. The code bags
  carry their committed version; a concurrent change makes them stale.
  Twelve vault scenarios and one runner scenario cover lost ACKs,
  resumption after recreation, refused / corrupted storage, concurrency, stale
  callbacks, generation change and explicit confirmation of the backup codes.
  The real TypeScript transport now exercises both vaults on PostgreSQL,
  loses the activation, start / finish and regeneration ACKs then resumes the
  original operations before deactivation. Two additional SQL scenarios
  cover retirement, context, preservation of the age and of more recent receipts.
  Verification: 85 server tests, seven protocol tests, 95 native TypeScript and
  1,045 mobile regressions succeeded; targeted final checks, typecheck / lint,
  Clippy / 232 core and FFI regressions, GTK build, schema / generation and
  inventory succeeded. Android Hermes export produced; it is neither an installed
  APK nor a validation of the Keystore. The Android /
  iOS Firebase files remain absent and the on-device flows remain open.
  The GTK and SwiftUI settings / vaults, SMTP and on-device validations
  remain the rest of P02. The CI of the mobile batch `7e7c10e` is fully green
  (run `36885412776`, four jobs).

- P02, server / SDK reauthentication: migration 0015, proof status and
  start / finish / resume flow on the current family, with no new bearer
  or device. Password then current factor give a fifteen-minute proof; a
  five-minute receipt resumes a lost response without extension.
  The device version blocks the old body even after the receipt is cleaned up.
  The CPU / SQL limits are shared with login, attempts are persistent
  and proof errors do not revoke the chat. Login and reauthentication
  share the TOTP counter and backup codes; their provenance identifies the secret
  actually proven. A newly enrolled authenticator does not benefit from
  an old proof, including after a clock rollback; families migrated
  without provenance must confirm again. The allowed factor settings
  advance the guardian's authority without making the proof younger or changing its provenance.
  Two HTTP regressions reproduced a success after expiry under the device
  lock and a deactivation of a new factor after a clock correction;
  they are fixed and covered. Eleven new PostgreSQL scenarios cover
  these barriers, single-use code, restart / rotation, pruning, challenge quota,
  key / code errors, password changed under lock and authority / generation.
  The real TypeScript transport loses the start / finish ACKs, resumes the proof
  then regenerates / deactivates from the family originally enrolled.
  The Rust SDK resumes the same proof after restart / rotation.
  Verification: 83 server tests, seven protocol tests and 82 native TypeScript
  pass; 1,032 mobile regressions, typecheck / lint, Clippy / core and FFI
  regressions, GTK build, schema / generation and inventory succeeded.
  The reauthentication vaults / forms and settings of the three clients,
  SMTP and on-device validations remain open.

- P02, server / SDK backup code regeneration: migration 0014 and private
  endpoint targeting a precise version and a persisted operation. The transaction
  replaces ten codes, keeps the TOTP secret / counter, advances the authority and
  revokes the other families / sync resumptions. A five-minute encrypted receipt
  lets the same device recover the batch after a lost response, restart or
  rotation, without a second revocation. The quota of three successes / fifteen minutes
  survives the revocation of the device; expired ciphertext and metadata
  are cleaned up in bounded batches. Five additional HTTP / PostgreSQL regressions
  cover concurrency, stale version, old proofs, wrong key,
  ciphertext of another purpose, generation / authority, expiry after lock,
  pruning and absence of new consumption / revocation on replay. The Rust
  SDK recovers the receipt after restart / rotation; the real TypeScript transport
  loses the ACK then finds the same batch again with a recreated transport.
  Verification: 72 server tests, seven protocol tests, 82 native TypeScript
  tests and 1,032 mobile regressions pass; formatting, Clippy, typecheck,
  lint, schema / generation and inventory succeeded. Settings of the three clients,
  explicit reauthentication and SMTP remain open; no factor enabled
  on a user instance.
  The native CI `36870100630` passes its four Linux / Windows / Swift jobs.

- P01 / P02, expiry under lock: the authorization lock re-reads the PostgreSQL
  clock after acquiring the account and the session. `now()` stays frozen
  at the start of the transaction, and a predicate with `clock_timestamp()` can also
  precede the `FOR SHARE` wait without a row update. A real HTTP regression
  reproduced a rename accepted with an expired bearer; both
  lock waits now give `401`, with the initial name unchanged.
  Formatting / Clippy and all PostgreSQL server regressions pass,
  including 28 API, factor, invitation, recovery and native client scenarios.
  The native CI `36866737534` passes its four Linux / Windows / Swift jobs.

- P02, FFI / SwiftUI login: opaque UniFFI object for the attempt, unindexed
  private vault and existing form wired to TOTP / backup codes. The commit
  keeps the expiry and E2EE key, then cleans up the proof; account activation
  is synchronous after the form / selection guards. Callbacks of a left
  view cannot install a provider. Replaying a committed handle
  resumes the same provider without rewriting an already renewed / deleted bearer.
  Verification: formatting / Clippy, FFI regressions and regenerated bindings,
  build / six local tests of the Swift models and syntax analysis of the view.
  Five connected flows pass on PostgreSQL and the real Linux Secret Service,
  including preservation of the active account, proof recovered by a new model,
  left request, wrong code, lost response, confirmation without code, resumption
  from the keychain and replay after forced rotation. SQL confirms a single
  family and a single consumed backup code; the renewal counters pass.
  Inventory: 280 files / 344 occurrences. The private bench is deleted after
  verification. The native Linux / Windows CI and the SwiftUI build / startup
  on the macOS runner pass. Qualification of the Keychain and of the installed
  macOS application remains open. P02 continues with
  the settings of the three clients, explicit reauthentication, backup codes and SMTP.

- P02, GTK login: existing form with TOTP / backup code choice, private
  proof outside the account list and keychain operations keeping their
  lock after cancellation. A refused session save does not activate it;
  cleanup compares the exact proof and the saved credential. Hiding
  the window or leaving the form invalidates late responses without
  deleting the durable candidate. Rocket.Chat keeps its existing flow.
  Verification: formatting / Clippy, core / bindings suite and GTK build
  succeeded; mobile typecheck and inventory 279 files / 344 occurrences.
  Disposable PostgreSQL / real Secret Service bench: wrong code, successful response
  discarded by proxy, resumption without a new code then client restart under
  a new D-Bus. SQL confirms a single family and a single consumed backup code.
  The ten GTK launches for exchange, edit, devices, invitation, factors
  and recovery pass; the mobile peer and the rotation counters pass.
  The factor form was rendered and inspected at 435 pixels, fields empty.
  The private volume is deleted after the trials, the development server
  stays unchanged. SwiftUI / FFI, settings of the three clients, SMTP and Android
  devices / Windows / macOS keychains remain open.

- P02, common desktop vault: `rv-core::native::authentication_vault` serializes
  the challenge / candidate by canonical URL and identifier with an interprocess
  file lock, with no secret on disk. The storage contract keeps this lock
  in platform tasks that survive the cancellation of their caller.
  Seven tests cover lost responses, parallel resumptions, storage
  comparison, generations, corrupted data and a blocking write cancelled
  while another instance waits. Formatting / Clippy, full core / bindings
  suite and GTK build succeeded. The keychain adapters and the
  GTK / SwiftUI forms remain to be wired; these tests use a
  portable vault and do not qualify the real Credential Manager or Keychain.

- P02, mobile login: existing form wired to TOTP / backup codes and a
  SecureStore vault separated by server / identifier. The candidate is written before HTTP,
  resumption probes an already accepted code and cleanup waits for the active storage.
  A new password proof does not replace a still ambiguous pending;
  the account lock and the challenge expiry bound its replacement. The
  vault instances share their queue, stale forms do not delete
  a new attempt and a proxy error keeps the candidate.
  Verification: 1,032 mobile tests, eleven new vault scenarios,
  typecheck / lint with no warnings and Android / Hermes export succeeded.
  PostgreSQL bench: lost response, two concurrent resumptions, new
  password and a single consumed backup code. This bench exercises the portable vault; the real
  Android SecureStore remains to be qualified. The GTK / SwiftUI forms and the
  settings of the three clients remain the rest of P02.

- P02, desktop / mobile authentication coordinators: distinct session / challenge
  steps, pinned identities, durable candidate before code, candidate probe
  and validation of the current device alone before installation. A lost response
  is recovered after the challenge expires without reusing the factor. Only a
  structured refusal of the candidate allows replaying the operation; other errors do not
  change the active account nor the pending. Enrollment / recovery keep
  this same factor step, with UID comparison. Five core tests and eight
  TypeScript tests cover ambiguous responses, generation, UID, unavailable vault,
  old server and recovery; the mobile coordinator resumes a real session
  of the HTTP / PostgreSQL bench after a response loss. The keychain adapters and
  the wiring of the three forms remain the immediate next step of P02.

- P02, server and SDK TOTP / backup code foundation: migration 0013, operator key
  supplied by a private file outside PostgreSQL, secrets encrypted with AAD per
  instance / UID / purpose. Five-minute challenges bound to authority and generation,
  five persistent attempts, strictly increasing TOTP counter and ten 128-bit
  backup codes with atomic consumption. The anonymous SDK steps do not replace the
  active bearer. A durable candidate and a hashed receipt resume the same
  session after a lost response; the TypeScript bench verifies it against real HTTP and
  PostgreSQL. Proven enrollment and private deactivation require a recent
  login; after activation, a full login with the factor is also required to
  revoke another device. Rotation / activity do not make this right younger.
  Password reset keeps the factor, and restoration / deactivation /
  authority change invalidate old challenges. Missing / wrong key /
  corrupted ciphertext close authentication of the protected account.
  Verification: Clippy and full Rust suite, nine PostgreSQL factor tests,
  RFC 6238 / encryption / operator file vectors, 63 native TypeScript tests,
  1,013 mobile tests and typecheck / lint; core / bindings tests and GTK
  build succeeded. A publication / logout delay collision detected under load
  is fixed by a shorter counter wait; the full scenario passes.
  Contract in [AUTHENTICATION.md](protocol/AUTHENTICATION.md). P02 stays open
  for the forms / settings of the three clients, email / SMTP, explicit
  reauthentication challenge and backup code regeneration; no activation on a
  user instance nor on-device qualification is claimed.

- P01, operator recovery: CLI `recover-user` / list / revocation and
  "Forgot password" variant in the mobile / GTK / SwiftUI login.
  CSPRNG code bound to UID, authority and generation, hash only in PostgreSQL;
  1 to 24 h, 3 active codes per account. The transaction changes Argon2 and the authority,
  revokes the devices / tickets / receipts and the snapshot / journal resumptions,
  while keeping account, permissions and conversations. The receipt replays for
  five minutes with the new password without revoking recent sessions.
  No factor or E2EE data is erased; normal login stays distinct.
  Five PostgreSQL tests cover concurrency, new session after replay,
  authority / generation / account / expiry, real lock wait and a race
  with a login that had already verified the old password. 59 native TypeScript tests
  and 1,009 mobile tests, typecheck / lint / Android export pass, as do
  Clippy / core / bindings / GTK and the Swift models. The mobile bench verifies UID,
  conversation kept in SQLite, old bearer refused and resumption. GTK
  uses the real form then Secret Service after restart; Swift
  tests recovery / old session HTTP 401 / keychain resumption / logout.
  The real operator binary is tested for issuance, secret-free listing,
  idempotent revocation and refusal of a duration outside policy; the script refuses
  any database other than the disposable bench. Recovery by email, P02 factors and
  physical qualification remain open.

- P01, invitations: CLI `invite` / `list-invitations` / `revoke-invitation` and
  sign-up in the existing mobile / GTK / SwiftUI login screens.
  Public sign-up closed; random code kept only under a fingerprint,
  1 to 168 h, at most 1,000 active invitations per generation. A code creates an
  account without admin rights; normal login follows. Lost confirmations and
  two concurrent sign-ups find the same UID with its password.
  Expiry after PostgreSQL lock, revocation, disabled / deleted account,
  generation change and persistent quotas are tested. The clients
  verify instance / generation and the UID of the login before secure storage.
  Verification: 4 dedicated PostgreSQL tests on top of the 27 API ones, 56 native
  TypeScript tests, 1,006 mobile tests, typecheck / lint / Android export; Clippy,
  core / bindings tests and GTK build; Swift bindings and models.
  The disposable bench creates three invited accounts: mobile runner with real SQLite,
  GTK widgets with resumption after restart from Secret Service, Swift model
  with creation / resumption / logout in the keychain. Its codes stay in a private
  volume deleted at the end of the bench. P01 recovery and P02 second factor
  remain open, as do validations on physical devices.

- P01, devices: the existing mobile / GTK / SwiftUI settings list the
  account's sessions, display the current device and the dates and allow
  renaming / revoking another device. The provider re-reads the secure
  credentials before the desktop commands. Revocation requires a recent login
  on the server side; rotation and activity do not extend it. Activity tracking
  is coalesced to five minutes and skips locked rows. Closed providers
  and confirmations from an old account cannot mutate a new
  session. The transport tests keep the code / request ID of the reauthentication
  refusal; the Swift model names the device and revokes a second
  session actually created in PostgreSQL, then observes its HTTP 401 refusal.
  GTK opens the settings / devices and applies the name through the Adwaita field,
  with server reading and checking of the field limits in the dialog.
  Typecheck / lint and 1,003 mobile tests pass; the Android bundle is exported.
  The physical validations remain open, as do recovery / invitations
  and the P02 reauthentication challenge / second factor.

- P01, renewal in the apps: mobile SecureStore and GTK / Swift keychains
  keep the successor before HTTP then resume it after a lost response.
  Per-account writes are serialized, including when the caller of an
  already committed keychain write is cancelled; the old bearer cannot eject a
  renewed session. Long connections check expiry daily.
  The SQLite drafts, outbox and commands stay with the same account.
  Verification: 27 PostgreSQL API tests, 52 native TypeScript tests, 1,002
  mobile regressions, Clippy / core and bindings tests / GTK build, as well
  as Swift generation and tests. The disposable bench shortens the first bearer
  to D+1: GTK resumes its account from the real Secret Service after restart and
  the Swift models pass login / send / resumption / logout. Secret-free
  SQL counters prove the rotations of both accounts; the real mobile
  runner also renews before the HTTP / socket resumption. Android SecureStore
  and the Windows / macOS keychains remain to be qualified on devices. The
  devices, invitations / recovery screens and P02 remain to be delivered.

- J2, third batch: existing mobile / GTK / SwiftUI menus and editors wired
  to the native actions. Text / rights / revision are verified before opening;
  saving uses this revision, with an explicit conflict if another device
  modified the message. SQLite keeps one intent per message, its ID and its
  initial revision despite a lost response or an event received in the meantime.
  Confirmation and projection happen together; definitive refusals stop
  their retries and the edit text stays recoverable. Closing / refusal of the
  session blocks late calls. The clients respect the action quota
  while leaving message reads available during `Retry-After`.
  Verification: 46 native Rust tests, 41 native TypeScript tests, 991 mobile,
  211 desktop core / bindings; formatting, Clippy, typecheck, lint and inventory.
  The GTK application renders the edit before / after in its editor and resumes
  its account from Secret Service. The Swift models connected to PostgreSQL
  verify edit, concurrent conflict, recovery of the refused text and deletion.
  Swift: 6 local tests succeeded and one connected flow succeeded; two other
  flows remain conditional on their benches. The physical Android devices
  and the installed Windows application remain to be qualified.

- J2, second batch: edit / delete API with persistent receipts,
  expected revision, author delay, moderation role, tombstones and erasure
  of the old payloads of the active journal. Rust / mobile transport available,
  mobile / desktop SQLite projections and shared GTK / SwiftUI renderer integrated.
  The window of a reset replaces the confirmed history and protects against
  earlier responses, keeping drafts / intents of the rooms present.
  A real mobile / PostgreSQL / WebSocket / SQLite bench applies an edit,
  misses the deletion and 51 messages, then replaces the cache with the bounded
  snapshot without keeping the vanished message. Tests of concurrency, restart,
  idempotence, delivery barriers and page under construction are covered.
  Menus and persistent client intents are delivered in the next batch.
  Verification: 45 native Rust tests, 37 native TypeScript, 987 mobile and
  209 desktop core / bindings pass; Clippy and GTK build, schema /
  generation / inventory, typecheck and lint succeeded. Swift bindings and models
  compiled with 6 local tests succeeded, 3 connected flows conditional.

- J2, first batch: fine-grained account / room / message rights, creation
  restrictions, moderator roles and read-only sending applied in a transaction.
  The responses protect the policy versions and detect a change
  then restoration. PostgreSQL tests: announced / applied rights, no implicit
  private access for the administrator, edit delay, receipts viewable
  after restriction and real delivery locks. `rooms/discover` is now
  the alias planned by J0, with `rooms/public` kept for recent clients.
  These rights prepare the actions, enabled in the following batches.
  Verification: 40 native Rust tests, 35 native TypeScript and 208 desktop tests
  pass; formatting, Clippy, schema / generation, inventory and typecheck pass.

- [ ] J2: actions, threads, reads / unreads, presence, search, profiles and favorites.
- [ ] J3: files, voice notes, cards, emojis, native Android push and sharing.
- [ ] J4: Jitsi and standalone E2EE with dedicated specification / review.
- [ ] J5: resumable import, operations, backup / restore and cutover pilot.

The Rocket.Chat provider and its Compose remain available. No merge to
`master`, real instance change or user import belongs to these increments.
