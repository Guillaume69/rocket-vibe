# P02: verified email, SMTP and recovery

## Actual state

The `apps/server/src/mail.rs` transport is delivered: SMTP relay with mandatory
STARTTLS or implicit TLS, mounted private configuration, bounded plain-text
message templates, at most four simultaneous sends and a total deadline of 30 seconds.
Migration 0016 and the private routes let the active account verify
an address. The challenge and its encrypted payload are recorded together in
PostgreSQL; the worker resumes their delivery after a restart. The Rust and
TypeScript SDKs expose the flow. The additive capability `email_verification` is
advertised only when the SMTP transport and the operator key are configured.

The mobile, GTK and SwiftUI forms join their existing security settings,
with SecureStore or a private system keyring and resumption of the initial
intent. Migration 0018 and the SDKs also allow conditional removal
of the contact, even without SMTP; the mobile / GTK / SwiftUI vaults and buttons are
wired to these three routes.
The second email factor is delivered on the server and SDK side, with explicit
enrolment, removal and delivery on an already established challenge. The login and
identity confirmation challenges are wired into the mobile client and the existing GTK / SwiftUI forms.
The shared vaults of the desktop Rust core keep their deliveries.
The desktop Rust / mobile vaults also keep the factor enrolment
and removal intents, under the common lock of the security operations.
They pin the contact and the displayed profiles, resume the same receipt after a
lost response and present the ten shared backup codes until their saving is
confirmed. Removal without SMTP keeps the other profiles; the
regeneration of backup codes also works with an email-only profile.
Six Rust tests and nine dedicated TypeScript tests cover this coordinator. The
enrolment / removal buttons join the existing settings of the three
clients, with confirmations bound to the contact and the displayed profiles. The
verified-address forms do not activate it automatically. Password recovery
by email uses the anonymous route of migration 0021 and the existing
GTK / SwiftUI / mobile login forms described below.

The mobile provider verifies identity, runner generation and visibility
before and after each call. The vault shares the local queue of security
operations, pins the five scope fields and saves the candidate before
start. Another address cannot replace a pending verification.
The code entry stays in memory and disappears on close / suspension.
Cancelling the verification is conditional and first resumes a receipt that may have won the
race; an old button cannot erase the next attempt. The accepted
receipt stays private until Finish. The server clock decides expiry,
even if the device corrects its clock.

The three clients keep verification or removal in a single private entry; the
format of verifications already recorded remains readable. Removal does not store
the old address, only the scope, the operation, the initial versions
and its possible receipt. The native confirmation pins the displayed revision and contact.
Suspension, closing, account change or a new view invalidate
its callback. A lost response exposes an unconfirmed removal, resumable or
cancellable. A cancellation never resends the start; if the receipt has already won,
it stays displayed until Finish. A server receipt cleaned up with no recorded
acceptance becomes stale; the absence of a contact is not enough to announce
success. A known acceptance stays displayable only with its versions and
the contact still absent. The old intent never removes a contact
replaced since.

GTK and Swift share `rv-core::native::security::email`. The OS lock stays
common to email proofs, factors, verifications and removals, including during the
real work of a keyring write whose caller has been cancelled. The UniFFI
handle keeps candidates, receipts, scope and versions: Swift receives only
the display values, and each email action carries the displayed revision.
A refused address keeps a stale receipt that is explicitly cancellable; no
client silently replaces or erases this intent. The GTK and
Swift benches use three processes and the real Linux Secret Service, with loss of the
verification start / confirm and removal responses, then resumption after a
further restart. The SMTP relay uses loopback TLS. The Windows /
macOS keyrings and SecureStore on an installed device remain to be qualified.

## Transport configuration

`RV_SMTP_CONFIG_FILE` names a regular JSON file of at most 16 KiB. On
Unix it must be private, for example mode 600; symbolic links are
refused. Loading fails with a fixed message if a field is invalid,
without displaying the content or the credentials. Example with no real secret:
[`docker/smtp.example.json`](../../docker/smtp.example.json). The local copy
`docker/smtp.json` is excluded from Git and from the Docker build context.
Mount the file read-only and provide its path in the container.

`tls` accepts `starttls` or `implicit_tls`. Choose the port of this service
(usually 587 / 465); no option for opportunistic TLS or for disabling
certificate validation is offered. `username` and `password` are
either both present or both absent for a relay that needs no login.
`from` is a bare address, with no display name or additional header.
The optional `ca_file` field adds a PEM authority certificate
mounted read-only: a regular file with no symlink, of at most 1 MiB.
The relay's certificate must still match the configured name; no
option disables this validation. Without this field, the usual authorities
of the transport are used.

The transport uses [lettre 0.11.23](https://docs.rs/lettre/0.11.23/lettre/transport/smtp/struct.AsyncSmtpTransport.html)
with Tokio / rustls and without SMTP traces. The relay's raw diagnostics are
never propagated: they may include a recipient or private content. The real
work owns its permit even if the HTTP call waiting for it is cancelled. An error
or deadline returns `mail_delivery_unconfirmed`: the delivery may already have taken
place. The same content must be resumed from the queue, without creating a new code.

## Verified address and durable delivery

Private responses carry `Cache-Control: no-store`. The GET also keeps
the server's authorisation delivery barrier. The address is not added
to the `User` DTO, to the directory, to the conversation journal or to the public cache.

| `/api/v1` route | Function |
| --- | --- |
| `GET /me/email` | Verified address if any, contact version, verification head and account / device / instance / generation context |
| `POST /me/email/verification/start` | Bounded admission, then atomic creation of the challenge and the delivery |
| `POST /me/email/verification/resume` | Rereading of the original candidate or of the receipt already accepted |
| `POST /me/email/verification/confirm` | Validation of the code, contact change and five-minute receipt |
| `POST /me/email/verification/retire` | Conditional rotation of this device's verification head |
| `POST /me/email/removal/start` | Removal of the displayed contact, with recent proof and initial versions |
| `POST /me/email/removal/resume` | Rereading of the original receipt, without renewing the proof |
| `POST /me/email/removal/retire` | Conditional cancellation of the removal intent before it is received |

The client prepares a private candidate of 64 hexadecimal characters, an operation
and the initial versions before start. All calls pin UID, device,
instance and generation. Start and the first confirmation require a recent
complete proof on the current family. Acceptance changes the version of the
contact and the verification head; it renews neither the bearer, the device, the
factor, the password, nor the age of the proof.

Migration 0017 durably reserves the device's head from creation.
Cleaning up the expired challenge does not reopen this head: old starts and
new candidates under this same head stay refused until explicit
retirement. An accepted confirmation also opens a new head.

The code has eight digits, expires after fifteen minutes and tolerates at most five
wrong attempts. A lost response resumes the same candidate / operation
and the accepted receipt without consuming a new proof or extending its deadline.
A contact changed from another device, or a change of factor,
authority or generation, makes the old candidate unusable. Removal
can cancel this candidate even after a contact change on another
device; an old removal cannot cancel a new head.

Admissions persist independently of the HTTP transaction: three per
account and per address in fifteen minutes, ten per IP in fifteen minutes and 120
globally per minute. An identical replay does not bill a second admission.
The queue holds at most 1,000 undelivered messages that are still valid. A refused
admission returns `email_delivery_limit` with `Retry-After`; this delay does not block
status, resumption, confirmation or removal in the SDKs.

The payload contains the address and the code, encrypted with the operator key kept outside
PostgreSQL. Its authentication includes the job and the whole scope / the initial
versions. Each worker claims at most four jobs, with a two-minute lease
and verification of the authority / of a valid session before SMTP.
The expiry of the session or of the proof while waiting for the queue budget
is reread before the message is created. The business locks do not cover the send.
At most eight attempts resume exactly this payload before
the original deadline, with a five-second delay per attempt, capped at one
minute. A lost SMTP ACK can lead to several messages carrying the same
code. Confirmation or acceptance by the relay erases the encrypted payload.

Resumption exposes `queued`, `sending`, `deferred`, `accepted` or `exhausted`.
`accepted` means that the relay accepted the SMTP, not that the final mailbox received
the message. No raw SMTP diagnostic, code or private content is logged.

## Contact removal

The additive capability `email_removal` is independent of SMTP and of the delivery
key: an account can read and remove its contact even if the relay is
disabled. The SDKs do not apply the SMTP cooldown to these three routes. The
first removal requires a recent proof on the current family, the original
operation, the version of the displayed contact and the head of this device. It keeps
password, factors, bearer, family and age of the proof.

The transaction locks the account, the device, the verifications and their jobs
in the order of the producers. It rereads the real session and proof expiries
after any wait on these rows. It deletes the contact as well as
all the account's verifications and their SMTP payloads, then changes the version
of the contact and the device's head. The old codes can no longer restore
the address. A mail already in flight may nevertheless arrive; its code stays refused.

The receipt contains only the resulting versions and the context. PostgreSQL
keeps neither the old address nor the operation in clear in `email_removals`.
This receipt expires after five minutes and is resumed only on the original family,
authority, versions and generation. The replay removes nothing
new and extends no deadline. After cleanup, the old
versions prevent the removal from being recreated, including if another device has
confirmed a new address.

Cancellation compares both the contact version and the device's head.
If they are still those displayed, it opens a new head and blocks
the old start, without removing the contact. After the contact is replaced, it
preserves a new verification even if this device still has the same head.
If the removal has already won, cancellation does not reverse it: the client must
resume its receipt before concluding or erasing the local intent. The mobile / GTK / SwiftUI
vaults and forms implement these rules, with read / removal without
SMTP or TOTP configuration. A verification not received that has become unavailable
stays explicitly closable. The installed flows remain to be qualified.

## Contract for the rest of the workstream

1. **Verified private address.** The active account confirms its identity on the
   existing family before adding / changing an address. A challenge confirms
   access to the new mailbox. The address does not enter the public directory.
   The tokens stay bound to UID, instance, generation, authority version and
   initial operation. A lost response resumes the original receipt. A change
   of address or authority makes the old challenges unusable.
2. **Durable SMTP queue.** Record a challenge and its message in the same
   transaction. Encrypt the codes and delivery payloads with the operator key
   kept outside PostgreSQL. The workers claim bounded batches with a lease,
   verify expiry / authority, then do SMTP outside the business locks.
   Retries resend the same code until its deadline; no conversation
   transaction left hanging while waiting for SMTP. The operations log
   contains no code, body, full address or credentials.
3. **Explicit email challenge.** The server offers this method only with a
   verified address and adequate configuration. The user chooses it; no
   implicit fallback from TOTP. Bounds on sending / attempts / duration persist
   after a restart and apply per account, challenge, address and IP. The private
   candidate and the committed proof follow the same rules as TOTP / backup codes.
4. **Password recovery.** The anonymous request provides a uniform response
   and quotas, without revealing the existence of the account or of its mailbox.
   Only an already verified address receives the code. Confirmation keeps UID,
   conversations and E2EE keys, revokes the old families and keeps the
   existing factors. It reuses the current recovery mechanism; it
   creates no session and does not waive the second factor at the next login.
5. **Existing clients.** Add these actions to the current mobile / GTK / SwiftUI
   settings and forms with additive capabilities. Private vaults per
   scope, transient entries, exit / suspension / account change
   blocking callbacks, original resumption after a lost ACK. The Rocket.Chat
   screens continue their own flow.

## Qualification

The transport tests cover configuration and header injections,
private file / symlink / size, refusal of a relay without STARTTLS before any
credential / recipient / content, a real SMTP exchange on loopback and
cancellation preserving the permit of the real work. The plaintext relay exists
only in the private build of these tests.

A real rustls exchange on loopback validates mandatory STARTTLS and implicit TLS
with a test certificate. Untrusted relays and certificates for a
different name are refused before credential or code. The public fixtures do not
constitute an authority to install in production.

The PostgreSQL / HTTP tests with the Rust SDK cover idempotent receipt, unchanged
session, resumption after a lost SMTP ACK and new runtime, removal before delayed start
or confirmation, concurrent devices, change of authority,
expiries, persistent quotas, wrong attempts and directory confidentiality.
The TypeScript tests cover HTTP scope, original candidate, validation of
states and access to reads / resumptions during a delivery cooldown.

The removal tests also cover the absence of SMTP, deletion of the old
codes on several devices, concurrent confirmation, session /
proof deadlines expiring during a real lock wait, cleaned-up receipt, replaced
contact, cancellation before receipt and a cancellation / removal race. The Rust SDK
tests the real HTTP routes, their confidentiality and conditional cancellation.

The bench `scripts/native-email-mobile-pilot.ts`, launched by a private SQLx test,
runs the real `NativeChat` with SQLite, HTTP and WebSocket against
PostgreSQL. It loses the start / confirm responses, simulates a refused receipt
write, resumes with a new vault and keeps a single family and one
admission. It then resumes the same bearer against a runtime with no SMTP and no
factor key: cancellation before receipt, old start refused, lost removal
response, refused receipt write then accepted resumption through Finish.
PostgreSQL requires one family and one removal receipt, with no contact, challenge or SMTP
job remaining. Its SMTP mailbox and its code-reading route
exist only in the test server; no external send leaves.
The private storage of this bench is simulated. Typecheck, lint, mobile tests and
Android bundle export pass; they do not prove SecureStore or the
widgets of an installed app. ADB currently reports no connected device.

The shared desktop vault passes 22 contact tests, including 12 removal scenarios:
lost response, receipt storage failure, resumption of the same candidate, cleanup,
replaced contact, concurrency, expired proof, closing and OS lock kept
by a real write whose caller is cancelled. The HTTP guards verify
removal without verification / TOTP capabilities and refuse a closed generation or
provider before mutation. The Fedora workspace passes its 275 tests and
Clippy; the UniFFI bindings are actually generated and the Swift models compiled.
The two PostgreSQL / Secret Service benches each pass the three processes.
GTK also exercises an old native confirmation after Refresh and waits for its
effective closing before opening the next; Swift refuses the old
removal / acknowledgement revisions. SQL requires a single family, a complete
proof keeping its age, one admission and one removal receipt, with no old
contact, verification or job. The second factor stays active during the removal,
then its explicit deactivation is tested separately. The SwiftUI compilation
of batch `b06487b` is confirmed: macOS CI `36944950019` compiles, packages and
starts the application. Native CI `36944950072` passes server / mobile, GTK
and Windows core but fails in the Swift bench on a submission that preceded
the end of the reconnection after regeneration. The corrected bench requires a fresh view
and verifies the effective response losses through the throwaway proxy. Compilation,
six local tests, three connected processes and PostgreSQL invariants pass
with the rebuilt server. The fix and the SMTP budget of commit `fab08e0`
pass the four native jobs `36947405591` as well as macOS `36947405670`.

## Explicit email factor

This flow is available on the server and in the existing settings of the
three clients. A verified address does not activate it implicitly: a distinct
enrolment allows email alone or coexistence with TOTP, with shared backup
codes. The status distinguishes the effective enrolment from the runtime's
sending capability. An SMTP outage does not allow a session with the password alone.
A missing or incorrect operator key closes the protected flow, including
its fallback to the backup codes.

The factor is bound to the version of the verified contact. A contact used as
a factor must first be explicitly deactivated before replacement or removal.
Enrolment / deactivation requires the account's recent proof and its current
version; its receipts, authority changes and revocations of the other devices
follow the guarantees already applied to TOTP. Any issuance of new backup codes
is presented and kept as a private receipt, never silently replaced.

The 0019 foundation already implements the independent profiles and the shared backup codes.
An enrolled profile requires an operator key validated by an authenticated marker
on the exact version of the contact, including before a backup code is consumed.
The routes refuse to remove / replace this contact as long as the factor remains
installed; the SQL constraints refuse its removal or the change of its
version. Eight PostgreSQL tests cover email alone,
coexistence, change of proof provenance, regeneration, key errors,
last factor removed and a real migration from 0018 with TOTP data intact.
This profile foundation is used by the explicit routes of migration 0020
described below; a verified address alone does not protect the account.

Sending is requested explicitly on the login or identity confirmation
challenge already established. The client must keep its delivery candidate before
HTTP and resume the same operation after a lost response; the code stays in
memory only. The server binds the delivery to the account, challenge, purpose, contact,
authority and generation; the device context is added for identity
confirmation. Resending, SMTP retries and receipt resumption do not extend the
initial deadline. A code does not validate another challenge or another purpose.

### Email factor routes

Paths relative to `/api/v1`, strict bodies and `no-store` responses, refusals included:

| POST | Body | Scope / result |
|---|---|---|
| `/me/factors/email/enable` | `ChangeEmailFactor` | Active account with recent complete proof; `EmailFactorChange` with ten new shared backup codes |
| `/me/factors/email/disable` | `ChangeEmailFactor` | Same proof; receipt without codes, available without SMTP |
| `/auth/factors/email/start` | `RequestFactorEmail` | Anonymous login challenge; `FactorEmailDelivery` |
| `/auth/factors/email/resume` | `RequestFactorEmail` | Reading of the same delivery candidate, without resending |
| `/me/reauth/email/start` | `RequestFactorEmail` | Identity confirmation challenge of the active family |
| `/me/reauth/email/resume` | `RequestFactorEmail` | Reading of the same candidate and the same family |

`ChangeEmailFactor` pins the user / device / instance /
generation context, the version of the displayed contact, the factor version (or `null`
if there are none) and an initial operation. The encrypted private receipt lasts five
minutes. Its resumption returns the same codes and versions, with no new proof
or rotation, only while the committed state is still current. Another
enrolment, a replaced contact or an old generation close this resumption.
Six successful changes per account and fifteen minutes are admitted. Enrolment
replaces the shared list, revokes the other families and keeps the
initiating family. Removal keeps TOTP and the backup codes if it remains installed; the
last factor removed erases the backup codes. The operator key remains necessary.

`RequestFactorEmail` contains only challenge, a random 256-bit delivery candidate
and operation. The address and the purpose come from the server. Retries
of the same candidate read their receipt, even without SMTP and without a new quota debit.
A new candidate represents an explicit resend: at most three deliveries per
challenge, spaced sixty seconds apart. They resend the same eight-digit decimal
code and the same deadline. The hash of the code is bound to the raw private challenge and to the
purpose; the encrypted payloads authenticate all their versions and their scope.

The durable queue and the worker leases close their results on the identity
of the claim. SMTP transmissions run without an account,
device or challenge lock. A lost SMTP confirmation can lead to a second
transmission of the same code; it does not create a new proof. Consumption
erases the payloads and the challenge's queue entries in the transaction that accepts the proof.
Expiries are reread after the last SQL locks, including those of the
queue. Without SMTP, the backup codes remain usable; no password-only session
is created for a protected account.

Discovery distinguishes `email_factors` (key configured, profile management) and
`email_factor_delivery` (key and SMTP, new delivery). Clients must
intersect them with the flows actually implemented. Nine PostgreSQL tests
cover typed HTTP, concurrent enrolment and resumption, TOTP coexistence, lost
SMTP ACK, bounded resends, absence of SMTP, stale receipts, key / payload /
generation errors and expiry under a real lock. Three TypeScript transport tests
cover bearer isolation and resumptions during the common cooldown.

### Challenges in the existing mobile screens

The login and identity confirmation vaults keep the delivery candidate,
the initial operation and the received state in their already existing private
SecureStore entry. They read the old formats with no mail metadata.
The codes stay out of the vault, SQLite and the sessions. The common local
queue holds HTTP and writes; a lost response keeps the initial command.
Recreating the vault then resuming reads its receipt, with no additional mail.
A call interrupted before insertion can resume this same command on an
explicit gesture. Loading a screen sends no mail.

An explicit resend requires a previous confirmed state, rereads the server's delay
and saves the new candidate before start. An old view cannot replace
it. The challenge and its initial date stay identical. A new password
proof keeps a pending delivery until the expiry barrier
of the previous challenge. SMTP absent after delivery keeps the reading of the receipt and
the verification of the code already received. The focus, account, family and
generation guards refuse delayed callbacks; leaving the form erases
the code entry.

Eleven vault tests cover unavailable storage, lost ACK, concurrency,
resend, scope and expiry. The pilot `scripts/native-factor-email-mobile-pilot.ts`
goes through HTTP, PostgreSQL, SMTP loopback, the mobile provider and SQLite: the
delivery and validation responses are deliberately lost, two codes
are transmitted, two proofs are consumed, no repetition produces an
extra send or session. It recreates the vaults with a portable adapter;
it qualifies neither the installed Keystore nor the rendering on a device.

### Desktop challenge vaults

`rv-core::native::factor_email` resumes the delivery command under the OS
lock of the login vault or of the active family's proof. The candidate is
kept before HTTP; a lost response does not create a new mail. A resend
requires a known receipt, the delay reread from the server and the same view of the previous candidate.
Statuses are limited to their original deadline and to displayable metadata;
codes and passwords do not enter the keyring. The old formats
with no delivery remain readable. The guards prevent a late write after
closing; an ambiguous delivery stays recoverable in the same vault.

Reads remain available without SMTP. For an existing proof, the code
already sent stays offered for the same challenge after SMTP disappears; a
new challenge does not advertise it. Ten dedicated Rust tests cover lost ACK,
concurrency of recreated vaults, resumption of the unsent candidate, refused storage,
explicit resend, stale view, closing, malformed private status and deadline.
The provider checks also verify the family's bearer and the
generation / capability barriers. GTK wires these vaults to the login
form and to the identity confirmation of the existing settings. The buttons
offer sending, resumption of an ambiguous delivery and a bounded explicit
resend. Their selection and their statuses never trigger an automatic send.
Closing and going back cancel the guard; the code fields stay transient.
SwiftUI uses the same vaults through `NativeLoginAttempt` and `NativeSecurity`.
The only fields exposed are delivery status / deadline, resend delay,
capability and displayed revision. The candidates, nonces, challenge IDs and bearers
stay private. The real Tokio job keeps the send lock after cancellation
of the foreign call; closing the form cancels its guard. A stale revision
can neither start nor resume / resend a delivery. After an ambiguous response,
the model reloads this candidate; this read sends no mail. The buttons
and the codes stay in the existing SwiftUI screens.

The bench `compose.native-email-otp-pilot.yml` adds an account with explicit email factor,
a local TLS relay and a proxy that loses the start / finish responses.
It uses the real GTK widgets and Secret Service on three processes. The PostgreSQL
check requires two OTP deliveries consumed, a single family / credential,
a complete proof of unchanged age, three SMTP admissions including the initial
verification of the contact, no residual OTP payload and the ten original backup codes.
The resend click during the cooldown does not create a new admission.
The Swift bench adds the overlay `compose.native-swift-email-otp-pilot.yml`, in
another PostgreSQL / proxy project. It passes three processes with Secret Service,
the real models and FFI handles, the same SQL invariants and the refusal of
closed handles / stale revisions. This portable proof does not qualify the
macOS keyring nor the installed SwiftUI rendering.

The bench `compose.native-email-settings-pilot.yml` uses a verified contact
without activating its factor in the seeder. The real GTK widgets, Swift models / FFI
and mobile provider activate the profile then find the same ten
backup codes in a new process after a lost response. They then perform
a complete proof by backup code, with proof responses lost, acknowledge
the saving of the codes, remove the profile and resume this removal in a
third process. Each client uses a distinct PostgreSQL / proxy.
SQL requires a single family and credential, two original operations, the address
kept and a single contact mail; no OTP is requested by this scenario.
GTK and Swift use the real Secret Service; the mobile client uses a portable
private on-disk adapter and its real SQLite projection. The stale Swift revisions
and closed handles are refused before HTTP. The final GTK capture at
435 × 760 contains only the settings and the synthetic address.
This bench does not replace the confirmations or keyrings of an installed app.

The common SMTP admission component is extracted: it keeps the keys of the
verifications already admitted and shares the persistent global, account,
address and IP budgets between producers. Five PostgreSQL tests cover concurrency,
resumption during the cooldown, expiry, cancellation under lock and absence of
private keys in clear. The OTP producer shares these budgets and the limit of
a thousand active payloads with the verifications and the password recovery,
which adds its own binding without bypassing them. The transport
quota and the account lock remain distinct, and none of these locks
covers an SMTP transmission.

## Password recovery: server and SDK

Migration 0021 adds `POST /api/v1/auth/recovery/email/start`, advertised by
`email_recovery` when SMTP and the operator key are configured. The anonymous
request contains a random 256-bit `operation_id`, the username, `instance_id`
and `data_epoch`. The client must keep this intent before HTTP and
repeat it after a lost response. The Rust and TypeScript transports expose
the public call; the private vaults described below are available and the
buttons of the three clients remain to be wired. No automatic send is
triggered by the login.

A valid request returns `202`, `Cache-Control: no-store` and `{"accepted":true}`.
This response stays identical for a known, unknown or disabled account, one with no
verified contact or one limited by the SMTP / account / outbox budgets. It confirms
neither existence, nor address, nor send. The global bound of a thousand active requests
returns `429 email_recovery_limit` for all usernames, with `Retry-After`; a
different generation returns `409`, and absent SMTP / key `email_unavailable`.
Public admission also shares the persistent authentication budget:
120 calls / minute in total, 10 per username and per operation, 30 per TCP IP.
Its refusal returns `429 auth_rate_limited` before a receipt is created, in order also to bound
the requests that will send no mail. A refused reservation is cancelled
without extending its window. These public limits apply to retries.
These guarantees concern the status and the body, with no constant-time guarantee.

The server generates a random 256-bit code, valid for one hour, addressed
only to the already verified contact. Its hash is kept in the existing
recovery and its send payload is encrypted under the operator key. The authenticated
binding includes request, account, authority, contact, instance, generation and
deadline. A resumption repeats the same mail and does not extend the deadline. A deleted
or refused request stays an opaque receipt with no new mail; after the account is
deleted, the contact details and payloads are erased while keeping this receipt
until its cleanup. Reusing the username does not reactivate an old request.

The three producers share the persistent SMTP admissions and the capacity lock
of a thousand active payloads. Recovery also respects the existing bounds
of three valid codes per account / a thousand for the instance. The worker
rereads the versions before SMTP, claims four jobs per batch, with a two-minute
lease and at most eight attempts. No business lock covers SMTP. A mail
already in progress during a removal may arrive, but its now obsolete code is
refused at confirmation. Obsolete payloads are cleaned up without being sent.

Confirmation uses `/api/v1/auth/recovery` and its Argon2 / account /
IP limits. It changes only the password, revokes the old families and
concurrent codes, and keeps UID, conversations, TOTP, email profile, backup codes
and E2EE data. It creates no session and does not recover the E2EE keys;
the next login asks for the factors still installed. The same code and
password can find the receipt for five minutes without revoking a
new login. Contact, authority, instance, generation and deadline are
rechecked under the account lock. A code already received remains usable without SMTP
or operator key, like the historical operator recovery.

## Anonymous request vaults

The Rust coordinator `native::email_recovery` is common to GTK and SwiftUI.
The mobile module `EmailRecoveryVault` follows the same rules and has its own
SecureStore adapter in `nativeAuthenticationStore`. The private key uses
the domain `native-recovery-email-v1`, the canonical URL and the username, separately
from the active accounts, login proofs and E2EE keys. The desktop holds an
OS lock over the whole operation; the keyring adapter must keep it
until the real end of its reads / writes after cancellation of the caller.
Only empty lock files exist outside the keyring. The mobile queue
is shared between vault instances and covers HTTP and storage.

An explicitly launched request keeps before HTTP its random operation,
username, instance, generation, local date and conservative one-hour delay.
A received `Retry-After` is kept in this intent: its resumption waits for
this delay even after the vault is recreated, with no early network request and no
change of the candidate / of its deadline. The Rust SDK also shares the cooldown
of this endpoint between its clones, while leaving discovery available.
The vault stores neither address, nor password, nor received code, nor bearer.
The acknowledgement stays generic: it does not confirm that a mail was sent. A read
makes no network call; a resumption uses the original intent, and an
already acknowledged receipt is not sent again. The versions are verified around
the call. An absent capability blocks a new issuance; its disappearance
after an acknowledgement neither erases this receipt nor claims to qualify its delivery.

Expiry or a new form does not silently replace the request.
A new request requires its explicit local closing. This closing does not
revoke a mail already queued on the server side and cannot erase a more recent
intent. A guard closed during a write or an ambiguous response
keeps the original candidate without launching a late mutation. Malformed scope
coordinates, private fields or deadlines close the vault with no new
send; parsing errors do not expose their content.

Twelve Rust tests over TCP HTTP and twelve mobile tests cover keys, concurrency,
recreation, lost ACK, refused storage, changed generation / capability, TTL,
corruption, persistent cooldown, closing and late local deletion. One test actually holds
a file lock during a `spawn_blocking` write after cancellation,
then proves that the recreated vault waits and resumes the same candidate. The mobile client
cancels a guard during a real storage / response promise in progress.
The Rust coordinator `Form` keeps the intent behind a public view without
nonce. GTK and UniFFI / SwiftUI use this same view and its revisions; late
actions and closing during a real write are tested over
TCP HTTP. The three existing forms offer the email request
only on RocketVibe advertising `email_recovery`. Opening them reads the
local vault with no discovery or send. A distinct button resumes an unconfirmed
response; the acknowledgement shown stays generic. Expiry, a change
of generation or an accepted receipt require an explicit local erasure before a
new request. The countdown reads only the kept state and blocks a retry
before its deadline. The received code and new password stay in the existing recovery
form; the next login still asks for the installed
factors.

The real GTK / Secret Service form is run twice under Xvfb at 435
pixels against an HTTP fixture: no issuance at opening, one conforming anonymous
request after the button and no active account. This fixture does not qualify
SMTP or PostgreSQL. The dedicated server tests exercise them separately; the
installed Android / Windows / macOS flows remain open.

The installed flows and the real relay with operator access remain to be qualified.
A loopback SMTP / TLS test does not validate the deliverability of an external
provider. P02 remains open for the features listed in the actual
state and for qualification on devices.
