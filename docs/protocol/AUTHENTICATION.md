# Native authentication (P02, factors and backup codes)

This batch delivers the server, the SDKs and the mobile / GTK / SwiftUI logins, as
well as reauthentication and factor management in the settings of the
three clients. The server and the SDKs also offer the email factor described in
[EMAIL.md](EMAIL.md). The email login / reauthentication challenges
are wired into the three clients; the vaults of the desktop Rust core resume
their delivery within the original attempt. The Rust / mobile vaults
also resume the explicit enrolment and removal of the email profile, with versions of the
contact and of the displayed profiles. The explicit enrolment / removal buttons
are wired into the settings of the three clients and into the shared backup codes.
P02 remains open for email recovery and for
device qualification.
The Rocket.Chat provider keeps its own flow.

The coordinators `rv-core::native::authentication` and
`providers/rocketvibe/authentication.ts` prepare this wiring. They separate
challenge and active account, pin instance / generation / UID, save
the candidate through a keyring callback before validation, then probe it
first after a lost response. An already committed session is recovered even after
the challenge has expired. Only an understood `401 session_rejected` allows a new
sending of the code; proxy refusal, network outage or an ambiguous response keep
the pending. The mobile form uses its private SecureStore vault; GTK uses
the system keyring, shared with FFI / SwiftUI on macOS. The pending is erased
only after the active session has been saved.
Enrolment and recovery go through the same complete flow and compare
the UID returned by the operator code with that of the challenge / of the session.

### Vault and mobile form

The existing login screen offers TOTP, email and the backup codes advertised by the server.
Password and operator code leave its state as soon as the challenge is issued; TOTP /
backup codes stay in memory only. Going back or losing focus prevents a
late response from starting the account installation. The Rocket.Chat provider
keeps its existing factor flow.

The vault uses a `native-auth-` key derived from a JSON tuple of domain / canonical
URL / identifier, distinct from the sessions and the E2EE keys. SecureStore
uses `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; neither SQLite nor the push extension reads
this candidate. A queue shared between instances covers reads, writes,
HTTP and the comparison of the pending. Corrupted data fails without exposing
its JSON in an error.

A new password proof first probes the previous candidate. It
keeps it as long as the old challenge can still validate a delayed request.
Replacing it requires a new challenge issued after the previous one has expired
(fixed server TTL of five minutes) and a probe after that barrier: `start`
and `verify` hold the same account lock. An ambiguous error, or a different UID,
instance or generation, cannot erase this pending.
The mobile client also keeps the pending if the two instants fall within the same
millisecond: PostgreSQL is more precise than `Date.parse`, and this equality
does not prove that the old challenge had already expired at the time of the new proof.

After a lost response, "Validate" without a code probes the session already accepted.
After a restart, a new password login resumes this same
candidate before any request for a new code. Cleanup compares challenge,
identity and the bearer actually saved; a renewed session or another
attempt keeps the pending out of caution. A failure of the active storage keeps
resumption possible; a cleanup error does not undo an installed account.

Eleven vault tests cover interruptions, concurrency, fresh proof,
storage comparison and isolation. The HTTP / PostgreSQL bench uses a
portable adapter, not the Android Keystore: SecureStore qualification
on a device, with a process really killed and system lock, remains open.

### Desktop shared vault

`rv-core::native::authentication_vault` carries the same rules for GTK and FFI:
private key per canonical URL / identifier, challenge separate from the active account,
comparison of the pending before writing, priority recovery and replacement
after the account barrier. Cleanup targets exactly the challenge and the bearer
installed; a different account, generation or renewed session cannot
remove the previous proof.

An empty file with a hashed name carries a system lock between instances / processes.
The storage trait passes this lock to each keyring operation and requires
holding it until its real end. Cancelling the calling future must not
release a platform write that is already under way. Seven tests verify
scopes, lost responses, parallel resumptions, expiry, unavailable storage,
corrupted JSON and cancellation with a blocking write still active. Clippy,
core / bindings regressions and the GTK build pass in Fedora.

### GTK form and keyring

The existing page offers the TOTP / email / backup code methods advertised by the server.
The challenge and its candidate use a private entry distinct from the sessions:
`kind: authentication` in Secret Service; a non-indexed key in the
Windows / macOS keyrings. The enumerations of active accounts ignore this
entry. No password, factor code or backup code entered is persisted.

The email choice presents explicit sending, delivery status, resumption of the private
candidate after a lost response and bounded resending after rereading the cooldown. A
new process keeps the ambiguous delivery despite its new pass through
the password; the delays of the challenge and of its delivery are not extended.
The GTK settings wire the same commands to the proof of the active
family. Resumption after an accepted code finds the original session or proof again.

Platform tasks hold the lock until the real end of their
operations, even after cancellation or the five-second timeout. The account keeps
its expiry date and its E2EE key when the accepted credential is written.
A storage error does not start the session and keeps the candidate recoverable.
Cleanup compares the exact proof with the session actually saved.

Going back, switching account and hiding the window invalidate late
responses. Password and operator code leave the form as soon as the challenge is issued;
the factor code is erased on method change, on going back and after
confirmation. The Rocket.Chat login keeps its existing methods.
The Windows / macOS adapters and Android SecureStore remain to be qualified on
devices; the settings remain open.

### FFI attempts and SwiftUI form

`NativeLoginAttempt` is an opaque UniFFI object: Swift sees the available methods
and the indication of a pending confirmation, never the challenge,
the candidate or the bearer. Verification and commit are serialised. The candidate
stays in a non-indexed keyring entry; the blocking platform tasks
keep the lock after cancellation and the five-second timeout.

The existing SwiftUI form offers TOTP / email / backup codes. It erases password
and operator code as soon as the challenge is issued. Change of server / identifier, going back,
cancellation and disappearance of the view invalidate its generation. The commit writes
the credential with expiry and preserves the E2EE key of the same account, then
cleans up the exact proof. It does not change the active account pointer.
The application activates the account after its form and selection guards,
with no wait between this check and the installation of the provider.

An already committed handle returns the same provider: replaying it does not rewrite
the initial bearer after rotation or logout. The Rocket.Chat provider keeps
its factor methods and its transport. The Linux bench uses the real Secret
Service; trials on the macOS Keychain and the installed macOS interface remain
distinct from the Swift model tests and the remote SwiftUI build.

## Operator key

`rv-server` accepts `RV_AUTH_KEY_FILE` or `--auth-key-file PATH`, never the key
in an argument. The file contains 64 hexadecimal characters, optionally
followed by a line ending: 32 bytes generated by a CSPRNG. It must be a regular file,
in a private directory; on Unix, no group / other access (mode `600`).
Symbolic links, malformed values and oversized files are refused.
Bounded read, envelopes and keys without `Debug`, erasure of the keys and of the decrypted
plaintexts when they are released, with `zeroize`.

The key is provisioned and backed up separately from PostgreSQL, with operator
access control. Keep the same key during a restore. A loss makes
the factors unusable; a password reset does not delete them. Workstream J5
must still deliver the complete procedure for backup / restore
and rotation of this key. No default secret, no implicit generation at
restart, and no inclusion in the user export.

Without a key, the additive capability `second_factors` is false and the enrolment of a
factor is refused. An already protected account stays protected: a missing,
incorrect key or corrupted ciphertext gives `503 factor_unavailable`, never
a session with the password alone. The historical login gives `400 factor_required`.

Encryption relies on RustCrypto's AES-256-GCM-SIV, envelope version 1,
random 96-bit nonce. The AAD serialises version, usage, stable instance
identity, UID and factor ID. TOTP secrets and the temporary backup code
receipts use distinct usages. For profile secrets, the `data_epoch`
generation stays out of the AAD to allow decryption after a restore;
it invalidates the challenges. The OTP delivery payloads and their receipts also
pin this generation and cannot be reused after a restore.
The library is documented [here](https://docs.rs/aes-gcm-siv/0.11.1/aes_gcm_siv/).
Its tests and the project's tests do not constitute an external cryptographic review.

## Anonymous flow

`POST /auth/start` accepts the same strict `Login` as `/auth/login` and returns
`AuthenticationStep`: `kind: session` with a session, or `kind: challenge` with
`AuthChallenge` and the user whose password has just been verified.
A protected account creates no session at this step. The opaque 256-bit challenge
is kept only under SHA-256, bound to the UID, the authority, the factor
version and the generation. It expires after five minutes; at most five
unconsumed challenges per account. The advertised methods are `totp` and, if any
codes remain, `recovery_code`. An explicitly installed email profile also advertises
`email` when SMTP is configured. Its absence removes this method from
new challenges; a code already delivered stays verifiable until its initial deadline.

`POST /auth/factors/verify` receives `FinishFactor`: challenge, method, code,
`operation_id` and `next_token`. The client generates a CSPRNG candidate of 32 bytes
in hexadecimal and saves it in secure storage **before** HTTP. It keeps
the same candidate / operation on retry; a challenge cannot serve as a bearer.
The candidate does not replace an active account before the response and the
instance / generation / UID identities have been verified. The SDKs do not perform this installation
automatically and the anonymous steps do not revoke the active account on `401`.

The instance / account / challenge / factor locks are held until the commit;
expiries are reread from the clock after waiting. A validation creates a
single device family and keeps a five-minute receipt with only the
hash of the candidate. After a lost response, challenge + operation + candidate find
the same existing session without consuming the code again. Another candidate,
a disabled account, a changed generation / authority, a revoked / renewed
session or an expired receipt close this resumption.

The persistent global / IP / identifier quotas are shared with the login,
plus one window per challenge. Five wrong codes condemn the challenge, including
after a restart. Unsupported / expired / consumed codes return
`400 factor_rejected`; the strict body refuses forged identities and rights.
Successes containing credentials carry `Cache-Control: no-store`.

The check of an already authenticated session rereads the PostgreSQL clock after
the account and session locks. A bearer that expired during one of these
waits is refused before the authorisation is returned to the mutation. The
transaction start time and a predicate evaluated before the `FOR SHARE` wait are not
enough. The HTTP regression verifies both locks, including a natural
expiry with no modification of the blocked row, and the absence of renaming.

## TOTP and backup codes

The construction follows [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238), with
HMAC-SHA1, an individual random 160-bit secret, six digits and a 30-second
period. The window comprises the previous, current and next steps; code
comparisons go through `subtle`. The accepted counter is persisted
under lock and must increase strictly, preventing a second use even on
another challenge. The tests use the normative vectors, including dates after
2038. The [HMAC](https://docs.rs/hmac/0.12.1/hmac/) library provides the primitive.

Ten independent 128-bit backup codes are generated at activation.
Dashes and case are presentation only; PostgreSQL keeps their SHA-256,
and each code is consumed atomically. They complement the password and
do not serve to reset it. No backup code enters SQLite,
the logs or the sync journal.

## Private configuration

- `GET /me/factors`: active methods, version and number of remaining backup codes.
- `POST /me/factors/totp/setup`: `BeginFactorSetup`; Base32 secret and `otpauth`
  URI, valid for ten minutes. Same operation = same secret; a concurrent
  operation is refused. The pending stays encrypted and bound to the authority / generation.
- `POST /me/factors/totp/enable`: `EnableFactor`, proof by TOTP code. Five
  errors bound the enrolment. Success = ten backup codes, change of authority,
  revocation of the other devices and sync resumptions. The secret is active
  only after proof. A five-minute encrypted receipt recovers the same backup codes
  after a lost response, with no regeneration and no second revocation.
- `POST /me/factors/totp/disable`: `DisableFactor` targeting the displayed version.
  A retry after deactivation has no effect; it cannot remove a factor
  re-enrolled in the meantime. Deactivation deletes the TOTP pending, keeps the
  email profile and the backup codes if it is active, changes the authority and revokes the
  other families. The backup codes disappear when the last profile is removed.
- `POST /me/factors/recovery/regenerate`: `RegenerateFactorBackups`, displayed
  version and operation ID saved before HTTP. A recent complete proof
  atomically replaces the ten backup codes, advances the version / authority and revokes
  the other devices and sync resumptions. The TOTP secret and its anti-replay
  counter stay unchanged. No old backup code remains usable.

Regeneration keeps an encrypted receipt for five minutes, bound to the instance,
UID, initiating device, operation, expected / resulting versions, authority and
generation. After a lost response, the same body finds the same batch, even after
bearer rotation on this device or a server restart. The replay consumes
no code, rejuvenates no proof and does not revoke a device added since.
Another regeneration, a change of authority / generation, revocation of
the device or expiry closes this receipt. Its clock is reread after the lock.
Responses containing the codes carry `Cache-Control: no-store`.

At most three successful regenerations per account and sliding window of fifteen
minutes; `429 factor_regeneration_limit` gives `Retry-After`. Replays do not
consume this quota. Revoking the device removes its access to the receipt,
but keeps the counter: changing device does not circumvent the limit.
Bounded cleanup erases the expired ciphertext, then the metadata after one
day. The initial version prevents an old request from regenerating codes
after this erasure. Codes and receipts stay out of SQLite and the sync journal.

A login less than fifteen minutes old authorises the initial enrolment.
After activation, the full login or the recent explicit proof must
have proven the identity of the current factor. The device enrolled initially can keep chatting,
but confirms its identity before deactivation / regeneration or revocation
of another device. Rotation, activity and resumption do not rejuvenate this
authorisation. An old proof returns `403 reauthentication_required`.

## Explicit reauthentication on the current family

The additive capability `reauthentication` advertises the routes, absent / false
on the earlier v1 servers. No new bearer or device is created.
The call remains protected by the current bearer; its renewal keeps the family.

- `GET /me/reauth`: `ReauthenticationStatus`, UID, device, identity /
  generation, proof version and `recent` indication derived from the same
  SQL rule as the sensitive operations. This boolean does not replace their authorisation.
- `POST /me/reauth/start`: `BeginReauthentication`, password, displayed proof
  version, operation ID and CSPRNG challenge candidate of 32 bytes in lowercase
  hex. The client saves version / candidate / operation and their account
  context in a private entry **before** HTTP, never the
  password. An account with no factor gets `kind: granted`; otherwise `kind: challenge`
  with the available TOTP / backup codes. An incorrect / absent key does not bypass
  the factor. The candidate is hashed in the database, in a space distinct from the login.
- `POST /me/reauth/finish`: `FinishReauthentication`, challenge / operation, method
  and transient code. Success returns `ReauthenticationGrant`, only
  proof metadata, no credential. The family stays the same.
- `POST /me/reauth/resume`: `ResumeReauthentication`, candidate / operation.
  Without resending password or OTP, finds the challenge or the proof already accepted,
  even after a lost response, restart or rotation on the same family. An absent
  pending gives `404 reauthentication_not_found`, without revoking the chat.
- `POST /me/reauth/retire`: additive capability `reauthentication_retirement`,
  mandatory UID / device / instance / generation context and expected proof
  version. Under the family lock, advances this version if it is
  still current and removes the associated unaccepted challenges. A late start
  request can no longer recreate them. A replay of an old version does not modify
  a new proof. A proof that is already valid keeps exactly its age,
  expiry and factor provenance, including when another attempt
  is cancelled. The response is the current status, with no secret or new bearer.

On servers advertising this last capability, start also accepts the
additive field `context` and verifies its four identifiers under lock before
any challenge / proof is issued. Earlier SDKs may omit this field;
the new vaults always supply it. After retirement, they
reprobe the original candidate: a finish that had already won the race
can still be recovered. A network error alone allows no replacement.

Argon2 uses the same four-job CPU semaphore as the login, held
by the real blocking work after cancellation. Its hash is rechecked under
lock after computation. Account, session, device / version, challenge and factor are
locked in that order after the instance. Session and challenge expiry
are reread from the clock after the corresponding waits, before consumption.
The persistent global / IP / user limits are shared with the login,
plus a challenge window; five wrong attempts and five pending challenges per account.
A wrong password / code gives `400 reauthentication_rejected`, never a
revocation of the chat. A bearer that is really expired / revoked keeps its `401`.

A validation accepts a code only once and fixes the proof at fifteen minutes.
Login and reauthentication share the same TOTP counter and the same backup codes.
The five-minute receipt allows a replay with no consumption, new proof or
extension. Another family, authority, version or generation closes this
resumption. Expired challenge / proof metadata is cleaned up in bounded batches.
Acceptance also advances the proof version of the device: after cleanup
of the receipt, the initial body cannot recreate / extend the operation. A new
confirmation requires the current version, a new candidate / operation and a real proof.

Explicit authorisations are bound to the identity / generation, authority /
factor versions, family / proof version and identity of the TOTP secret
actually proven. An authorised factor operation advances the guardian
versions without modifying the time, its proven factor identity or turning
a password proof into a second-factor proof. Regenerating the backup codes
keeps the same authenticator; enrolling a new one requires a new proof,
including after a clock rollback. Private responses carry `Cache-Control: no-store`.
Migrated families whose factor provenance is unknown must confirm
their identity again; their date alone does not prove the current factor.

The mobile client now uses these routes in the existing settings. A private
vault is bound to the canonical URL, UID, family, instance and generation; its queue
serialises HTTP calls and writes between instances. It saves the
candidate / operation / version before start and finish, never the password or
the code entered. It resumes a proof already accepted before asking for a code again.
The provider and focus generations block callbacks after
logout, account change, leaving the screen or suspension.

A second vault of the same scope keeps the intents for configuration,
activation, replacement and deactivation. The private code receipts carry
the factor version **originally committed**, also encrypted in the
server receipt, and not a version inferred after HTTP. A concurrent modification
cannot present an old list as current. The codes stay in
SecureStore until explicit confirmation; stale receipts are closed
explicitly without starting another mutation. Configuration and codes are
erased from the screen on exit / suspension. All these entries use
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, outside SQLite, push and the account index.

These flows and their ACK losses are tested through the real endpoints on
throwaway PostgreSQL and portable vaults; this bench does not validate the Keystore
on a physical phone.

GTK wires the same operations into the existing preferences. The shared
vault `rv-core::native::security` uses private keyring entries,
outside the account index / SQLite; only a lock file with no secret is
created. The OS lock covers HTTP and KV and is held until the end of the real
keyring work, even if its caller is cancelled. The intents / receipts
carry the five scope fields, the initial version and the original operation.
The dialog keeps this scope between calls and erases its secrets on close.
Each access also verifies the connection generation before and after HTTP.
A socket closure after a factor mutation refuses the old result;
Refresh can resume on the new runner of this same family, in a bounded
way and without resending the password or code entered. Closing the provider,
a change of identity or leaving the dialog forbid this resumption.

The bench `compose.native-security-pilot.yml`, added as an overlay on a distinct
throwaway project, validates the real GTK widgets, lost ACKs, the private receipt
after a Secret Service restart and reconnection. Its secret-free SQL checks
prove one family, one full proof, two backup codes consumed,
one regeneration and the original age of the proof. The captures keep
no backup code. The keyrings on devices remain to be qualified.

### SwiftUI settings and FFI security object

`NativeSecurity` uses this same private vault and the family of the existing
`NativeChat`. Its scope stays pinned between calls; no candidate, proof /
operation / receipt identifier or bearer is exposed to Swift. The DTO contains
only the form state and the private values needed for display.
The mutex taken **in the real Tokio work** stays held after cancellation of a
Swift call. The vault's OS lock also protects the other GTK / FFI processes.

The confirmations of activation, replacement, deactivation and saving
carry the displayed revision. An old confirmation is refused before
mutation or erasure of the receipt; the original identifiers stay internal.
Copying rereads the vault and the current version before returning the secret, URI or
backup codes. `SecurityModel` still verifies account, provider, visibility and
generation before its synchronous callback on MainActor that writes the clipboard.
Closing / suspension erases the fields entered and the DTO, keeping the private
intent to resume; a closed handle refuses all its later calls.

The section is added to the existing grouped form when the server advertises
reauthentication and its safe retirement. Refresh can resume after the
connection change caused by the factor, on this scope only and without
resending an entry. The throwaway project `rocketvibe-swift-security-pilot` uses
the overlay above and two Swift test processes with a real Secret Service.
It loses the login, proof and mutation responses, resumes the receipt after
restart, and verifies stale copy / confirmation, exit during a copy
and old provider. The same PostgreSQL postconditions prove one family,
one proof, two codes consumed and one regeneration, without renewing the age of the
proof. This Linux bench qualifies the models and the FFI; the macOS SwiftUI
build and the Keychain of an installed app are distinct validations.

### Independent profiles and shared backup codes (foundation of the email factor)

Migration 0019 adds a distinct email profile, bound to the version of the verified
contact. It activates no existing address. Login, recent proof and
reauthentication now take both profiles into account: TOTP remains
the preferred provenance when it coexists with email, which preserves the
identities of earlier TOTP proofs. Adding TOTP to an email-only profile or
removing TOTP while leaving email requires a new proof of the current profile.

The backup codes are attached to the account. Removing one factor keeps them as long as
the other remains installed; removing the last one erases the whole list, consumed
or not. An explicit TOTP enrolment presents a replacement list of
ten codes, without accumulating the old lists. Regeneration and its initial
receipt can also work with an email-only profile, without SMTP.

Before offering a challenge or consuming a backup code, the server validates the
encryptions of all installed profiles. The email marker is authenticated
with the operator key and bound to the instance, account, profile and version
of the contact. A missing or wrong key, an invalid marker or a different scope close
the protected flow without consuming the backup code or issuing a session.

A contact carrying an active factor must be unenrolled from that factor before
replacement or removal. The contact routes answer `email_factor_active`,
and the PostgreSQL constraints also refuse direct removal or version change.
Erasing an account after removing its session references
can still delete contact, profile and backup codes together.

This foundation does not yet provide public email enrolment or OTP issuance.
The email method is not advertised; the test profiles are enrolled in
their throwaway databases only. Without a usable transport, an email-only profile
stays protected by its backup codes, then closed if these are exhausted.
