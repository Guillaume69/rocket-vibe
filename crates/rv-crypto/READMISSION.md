# New Welcome in the same vault

A new admission does not use the previous MLS secrets. The same vault
can keep its identity / device, its pins and its operation markers,
then join with a fresh KeyPackage and a targeted Welcome. No replacement
is triggered by a mere roster change or an HTTP refusal code.

`Coordinator::preview_readmission` authenticates the packet, the complete scope,
the current roster and the recipients with the current pins / revocations.
It requires an accepted state, no uncertain transition / message intent,
a package not observed in the accepted admissions and, for the same group
scope, a more recent revision / epoch. A confirmed rotation still
waiting for its position in the journal also blocks the replacement.

The preview deletes the old group only in a temporary copy of the
provider. It opens the real Welcome and verifies tree / context, own
leaf, author, signature and match of the private package. The persistent secrets and
package stay intact. The consent binds the exact packet,
the previous state, the pins, the local certificate and a bounded deadline.

`accept_readmission` revalidates this consent and the current checks in
a protected transaction. Deletion of the old OpenMLS state, consumption
of the new package, new group, preservation of the reference history,
removal of the previous cursor and marking of the previous cache are atomic.
Modified body, pins / rights gone stale or MLS error leave the old
checkpoint intact. An external checkpoint cut releases no result;
the same consent reconciles after reopening an old state or the new admission
already recorded. An exact ACK grants no new send after expiry.

The worker announces `EventKind::Readmission` in the preview of a new Welcome
for a room already present. `accept_event` only replaces the group after the
exact confirmation of this preview. The previews of first admission,
readmission and commits have distinct intents. This type will let the
existing interfaces announce the history boundaries at consent time.
It enables no capability in the apps.

The journal restarts from its start authorized by **the new admission**. The server
filters the old frames with its access / activation / package witnesses;
the vault itself verifies this admission on each signed plan. An old
cache or HTTP receipt does not provide the keys of the missed epochs. The bodies of
the previous admission stay marked in the bounded private cache; current reception
and page replay refuse them. The message markers are kept
and the abandoned personal documents stay recoverable through their own API.
An authorized archive of this old cache remains a distinct batch; it does not
automatically become a visible projection of the new admission.

Erasure targets the active provider and checkpoint. The old encrypted
SQLite / WAL / backup copies keep the limits described in
[README.md](README.md); no new guarantee of physical
erasure or of forward secrecy of backups is announced.

Proofs: six scenarios with real Welcomes in the same vault, corrupted
but correctly signed MLS packet, stale pins / roster, uncertain operations,
previous cache, reopening and interrupted external checkpoint. The HTTP /
PostgreSQL bench exercises a real membership departure / return, two distinct packages
consumed by the first admission and the readmission, then new messages
on the fifth epoch. Its external storage is simulated; physical devices / keychains,
suspension after withdrawal, archives, projection in the apps,
Android integration and independent review remain open.
