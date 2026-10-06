# Custom emoji catalog (P07 / J3)

The RocketVibe provider uses the same pickers, completions, message bodies and
reactions as Rocket.Chat. The catalog is specific to the instance and
to its generation; it grants no right on a room. The additive capability
`custom_emojis` is intersected with the adapters actually installed.

## Administration and images

The operator CLI works on the database and volume configured for the server:

```sh
rv-server emoji list
rv-server emoji put party_parrot ./parrot.gif --alias vibe_parrot --operation-id import-parrot
rv-server emoji put party_parrot ./replacement.png --alias vibe_parrot --revision 1 --operation-id replace-parrot
rv-server emoji remove party_parrot --revision 2 --operation-id remove-parrot
```

The revisions in the examples are to be replaced with those of `emoji list`.
A creation may omit `--revision`; a replacement or removal requires the
current revision. The persistent receipts and the operator journal are shared
with the existing administration. Replaying an old creation after a removal
returns its receipt without restoring the entry. Reusing an ID for another request
or another generation fails.

Limits: 512 entries, eight aliases per entry, lowercase ASCII names of 1 to 80
characters (`a-z`, digits, `_+-`). Names and aliases are unique; standard Unicode
codes are reserved. Each image fits in 1 MiB and 256 × 256 pixels.
PNG and JPEG are decoded and normalized to PNG. GIFs are kept after
validation of each frame, with a maximum of 128 frames and 4 MiB of decoded
pixels. SVG, truncated images and overruns are refused before publication.

The immutable objects are in the existing private volume. Their opaque identifier
is distinct from their SHA-256; collection keeps the images referenced by the
catalog. A backup must include the database and this volume.

## Reads and updates

`GET /api/v1/emoji` returns `EmojiCatalog { revision, items }`. Each `CustomEmoji`
carries ID, name, aliases, object ID, SHA-256, MIME, size and revision. Sizes and
revisions are exact decimals. `GET /api/v1/emoji/files/{id}` requires an active
session and a current reference in the catalog; the read keeps the authentication
proofs until its bytes are delivered. MIME, size and fingerprint
are verified; image responses are `no-store` and `nosniff`.

The live feed announces `emoji_catalog_revision`, including during a limited state. This
field is a revalidation hint. A more recent revision removes the
old names and images while the authenticated catalog is reread. The SQLite
caches keep this floor even after a restart; an older response
cannot restore the entries. A new generation purges this cache.

The readers expose `rv-emoji:` handles to the rendering. The provider's
transport carries the bearer and refuses redirects. The byte cache is
volatile and bounded; account change, removal and late response are guarded.
The mobile rendering uses local PNG / GIF and the existing GIF support;
GTK and SwiftUI keep their image components and their current behavior.
Animated rendering and behavior on installed devices remain to be qualified.

Reactions resolve an alias to the canonical name before persisting their
intent. The receipt is looked up before consulting the current catalog: a lost
confirmation remains replayable after alias replacement or deletion.
An existing reaction can still be removed by its canonical name after the
emoji is deleted; a new reaction on this name is refused.

## Verification

The PostgreSQL tests exercise import, replacement, removal, conflicts, receipts,
private images and reactions. The mobile and Rust caches verify floors
above `2^53`, rollback, generation, late download and resume.
The existing file bench imports a small image with
`apps/server/scripts/seed-test-emoji.sh`, then exercises the GTK widget and the
Swift models. The installed Android and macOS validations remain open; this batch does not
globally close P07 or J3.
