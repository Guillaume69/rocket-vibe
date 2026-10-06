# Public E2EE proofs

Formats and verifiers extracted from `rv-crypto` and shared without copy with the
server. This crate belongs to the root workspace; the client vault keeps
its own workspace and lock. It contains public root, certificate,
revocation, device request and grant, with their signed framings unchanged,
as well as the public plan / proof of the group transitions.

No private key, recovery, persistence or trust decision is
stored there. A valid signature is worth neither a confirmed pin, nor human consent,
nor access to the group. The clients keep these decisions in `rv-crypto`.
The public framing functions also serve the local signatures; they
sign nothing and accept no secret.

The identity / enrollment vectors and tests stay in
[`rv-crypto`](../rv-crypto/README.md). The group vector is in this crate,
with framing tests and an independent Node verifier. The server tests the real proofs,
their bindings to the session and the KeyPackage cycle.
