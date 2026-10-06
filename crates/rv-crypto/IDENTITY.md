# E2EE identities and approvals: format v1

`identity` provides the account roots, device certificates, local pins and
revocations of [RFC 0002](../../docs/rfcs/0002-e2ee-native.md). This crate stays
isolated: no UI nor E2EE capability is enabled by this batch.

## Root and certificate

`Issuer::generate` creates an Ed25519 seed with OS randomness. The public root binds
the immutable instance identifier, the UID and a random 16-byte
generation. A display name, a bearer or the HTTP password does not replace this
identity. `Issuer` has no `Debug`, no `Clone`, and no public export of the private key.
`save` / `load` use `crypto-root-v1` in the **encrypted records of the
vault**; a different existing root is refused, never replaced.

The signed certificate binds this root to a device ID, a 16-byte
incarnation, a random number, the MLS suite `0x0001`, the signing key of the
leaf and a duration of at most 90 days. Its Ed25519 signature is verified with
[`verify_strict`](https://docs.rs/ed25519-dalek/2.2.0/ed25519_dalek/struct.VerifyingKey.html#method.verify_strict),
also refusing weak keys. Unix timestamps are in seconds;
admission requires `issued_at <= now < expires_at`.

The MLS `BasicCredential` carries the certificate JSON, at most 4096 bytes.
A Rocket.Chat text, unknown fields or a non-Basic format are refused.
The certificate is **neither a proof of possession, nor a room authorization**.
The received KeyPackage must first pass OpenMLS validation (signature and
lifetime); `authorize_key_package` then compares its suite and signing key
to the certificate, then requires the exact pin and device approval.
A valid KeyPackage signed by another key with a copied certificate is refused.

## Signed encoding and public vector

Each frame is `UTF8(domain) || 0x00 || UTF8(ordered compact JSON)`. It is not
JCS / RFC 8785. The fields are rebuilt in the order below,
without spaces. Integers are decimal and byte arrays are JSON
arrays of integers `0..255`. Names are at most 256 bytes, with no Unicode control characters.
The signed payload is at most 4096 bytes. A change of order or of representation
requires a new version.

| Object | Payload order | Domain |
| --- | --- | --- |
| Root | `version, instance, user, generation, public_key` | `rocketvibe-root-fingerprint-v1` for SHA-256 |
| Device | `version, root, device, incarnation, serial, suite, signature_key, issued_at, expires_at` | `rocketvibe-device-certificate-v1` for the signature |
| Certificate | `device, signature` | `rocketvibe-certificate-fingerprint-v1` for SHA-256 |
| Revocation | array `[root, device, incarnation]` | `rocketvibe-device-revocation-v1` for the signature |

The nested root respects its own order. Signatures are arrays
of 64 bytes. The [public vector](fixtures/identity-certificate-v1.json) is produced
by [`identity_vector`](examples/identity_vector.rs) with the public seeds
`[7; 32]` and `[11; 32]`, exclusively for this fixture. The Rust test uses the
production verifier. An independent Node / OpenSSL verifier rebuilds
the frame, verifies the signature and refuses device and domain substitutions:

```sh
node crates/rv-crypto/scripts/verify-identity-vector.mjs
cargo run --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target --example identity_vector
```

## Persistent trust and local confirmation

`Pins::observe` is a read; it adds nothing. The first pin requires
`accept_first` with the exact fingerprint displayed. It stays **unverified**: a
substitution at first contact remains possible. `verify_root` must only be called
after an out-of-band comparison. An HTTP response is not enough. A root
change blocks admission; its replacement requires the old and new fingerprints
confirmed and erases all device approvals.

`preview_device` returns an opaque local `Consent`, with no network deserialization,
bound to the exact certificate and to the pin state. `approve` refuses an old
confirmation after another decision. Repeating the confirmation of an already
approved device is idempotent. Changing its key under the same incarnation is refused.
The future UI adapter must also check the active account, generation and scope
of the request: this token does not replace the navigation guards of the apps.

The pins are in `crypto-trust-v1`, at most 2 MiB / 1024 accounts / 64 devices
per account. A revocation signed by the root is additive, idempotent and
kept after reopening; re-issuing a certificate for the revoked incarnation does
not readmit it. The limit of 4096 revocations per account blocks additional
additions, with no silent eviction of an old revocation.

Decisions and keys are saved through `protected::Manager::transact`;
their result only leaves after the checkpoint is confirmed in the keychain.
A refused transaction saves neither a certificate nor a trust change.

## Conditions still open

The [signed request / proof of possession](ENROLLMENT.md), its exact agreement and
its durable receipts are implemented in the isolated engine, as is the
[root backup / restore](RECOVERY.md) by distinct code. The new-device
UI / delivery ceremony and archive recovery remain to be integrated; delegation
of control rides on the history share ([E2EE_DELEGATION.md](../../docs/protocol/E2EE_DELEGATION.md)).
The internal `certify` API must not be exposed directly to a server response.
The signed list of recipients, the room commits, the single consumption
of KeyPackages and the network delivery remain to be integrated.

A revocation does not erase the data received earlier. A service may
withhold its delivery; the withdrawal of the MLS leaf and the suspension of sends
must be applied by the engine / server. If the **private root** is
compromised, a simple device withdrawal is not enough: a new root and
its out-of-band confirmation are necessary. The expiry of an admission
certificate does not by itself define the verification of historical archives.

These tests are not an independent crypto review. J4 stays open until the integrated
flows, the recovery / archive / files and the platform qualifications
recorded in the RFC.
