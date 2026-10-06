# Native profiles and settings (P16)

The server foundation and the transports are available. The public profile card and the
mobile avatars are wired to the existing interfaces. The personal editor, the
preferences and the GTK / SwiftUI clients are still in progress; the general
`profiles` mask stays disabled until they are fully wired.

## Reads and privacy

- `GET /api/v1/me` keeps the `User` v1 DTO used to resume a session.
- `GET /api/v1/me/profile` returns `OwnProfile`: profile, preferences and the personal
  verified address. The address is changed through the P02 verification flow,
  never through a public profile write.
- `GET /api/v1/users/{id}` and `GET /api/v1/users/lookup?username=…` return
  `UserProfile` without email or preferences. An authenticated account can read
  basic profiles; disabled accounts are unavailable.
- These responses are `no-store`. Building and delivering them both
  re-check the session, the activation, the generation and the profile revision.

`UserProfile.status` represents the **chosen** status, kept across devices.
Effectively observed presence remains that of the P12 leases. The public fields
are the name, the username, the bio, the status text and the avatar identifier.

## Commands and concurrency

`PATCH /api/v1/me` accepts `UpdateProfile`: `operation_id`,
`expected_revision`, `username`, `display_name`, `bio`, `status`, `status_text`.
Names are bounded to 256 bytes, the bio to 4096, the status text to 512.
The username keeps the sign-up rules (1-128 ASCII characters,
alphanumeric, `_` and `-`). A username change requires a recent session
or a P02 reauthentication with the account's factor; a duplicate returns
`username_taken`. The account identifier and existing references stay
stable after a username change.

`PATCH /api/v1/me/preferences` accepts `UpdatePreferences`: language
`auto` / `fr` / `en`, 24-hour clock, push enablement, mentions only and
desktop notifications `default` / `all` / `mention` / `nothing`. This storage
prepares the consumers' settings; it does not announce the P17 push service.
Its revision is independent of public profile changes.

Both commands, avatar upload and avatar removal share a receipt space
**private to the P16 commands** and a budget of 20 mutations per minute.
A receipt contains only `operation_id` and `applied_revision`. The same identifier
with the same content returns the initial receipt, even after a more recent
modification; it never restores the old values. Diverging content returns
`operation_conflict`, a stale revision `revision_conflict`. Clients must
keep the original intent during the retry and re-read the current profile.
Extra fields in a command are rejected.

The status choice adjusts all active leases. An old device that renews
`online` also respects the current choice `away`, `busy` or `offline`. Removing
the lease of a single device remains distinct from the global `offline` choice.

## Protected avatars and durable volume

- `PUT /api/v1/me/avatar?operation_id=…&expected_revision=…` receives the raw PNG
  or JPEG body and its `Content-Type`. `DELETE` on the same path removes the photo.
- Maximum input size: **2 MiB**; maximum dimensions: **2048 × 2048**.
  At most two simultaneous decodes, decode memory configured at 32 MiB.
  The dimension limits are strict; the decoder memory limit is
  a best-effort limit, per the [image library](https://docs.rs/image/0.25.10/image/struct.Limits.html).
  The result is downscaled to at most 512 × 512, without enlarging small images,
  then re-encoded as PNG with no metadata and no content appended to the original
  file.
- A SQL reservation validated before decoding makes even a malformed image
  consume the budget. The decoder holds no account lock.
  The session and the revision are checked again before publishing the result.
- `GET /api/v1/avatars/{avatar_file_id}` requires the bearer in a header. The identifier
  is opaque, the URL contains no credential. Only a photo currently
  referenced by an active account is served; replacement / removal immediately
  invalidates the old URL, even if a physical deletion failed.
- Delivery holds the session and reference locks until the body has been
  submitted, with the common delivery timeout of five seconds. PNG response,
  `no-store`, `nosniff`, with no redirect and no read of a user-supplied path.

`RV_OBJECTS_DIR` / `--objects-dir` selects a local volume, `data/objects` by
default. The native Compose mounts `native-objects`. The server finalizes
the immutable object, syncs the file and, on Unix, the directory before the
SQL reference. A disk failure produces neither a success nor a new reference.
A crash between finalization and commit leaves an orphan object, recoverable after
one hour by the bounded cleanup; active photos are kept. This volume
must be backed up together with PostgreSQL in the J5 operations batch.

Discovery announces `profiles`; `profile_avatars` is a separate additive
capability, true when storage is configured. Live photos include the
`ProfileStamp`s of oneself and of members of shared rooms, within the common limit
of 512 observations, in order to refresh identities and cache versions. This
temporary information does not change the cursor or the durable journal;
old v1 clients ignore the added field.

## Verification and remaining work

The PostgreSQL / HTTP scenarios cover privacy, revision conflicts,
replayed receipts, username change, proof expiry,
independent preferences, retained status, disk finalization,
removal of old URLs, disk failures, cleanup and limits.
The mobile transports are verified with the generated JSON Schema contract, the
binary body, the authentication headers and the shared cooldown.

The mobile public profile card reads each server through its provider, from a stable
UID or a mention. Preloading bounds its buffer to 64 cards and refuses
cache / navigation after an account change. Live stamps update
usernames and photo versions in `users`, without extending the history
or advancing the cursor. A profile response older than a stamp is rejected.

The existing avatar tiles load the bytes through the native transport
(`Bearer`, redirects refused), then display a local PNG URI. No image
URL carries a native credential. The application cache stays in memory, per
provider: 128 entries, 32 MiB of image characters and at most four simultaneous
downloads. Removal / replacement clears the pixels and rejects a late
response; an identity that disappears from the live photos triggers an authorized
re-read if its photo is still displayed. Closing the provider purges the
cache. No avatar file is added to the phone's storage by this cache.

The HTTP / PostgreSQL / WebSocket / SQLite bench runs this same provider:
card / preloading, protected avatar, rename, removal, DM by stable UID and
account purge. The targeted tests also cover late responses and the
concurrency limit. This bench is not a qualification of the Android screen.

The mobile "Mon profil" editor uses the same fields / photo picker and
the native provider for the name, username, bio and chosen status. The picker
re-encodes the photo as PNG of at most 512 pixels through the Expo module already present.
The verified email is private and read-only here; the existing security
section keeps the P02 verified-change flow. Recent proof
may be requested for the username, through the existing identity confirmation.

The mobile migration `0017_native_provider.sql` keeps one immutable intent per field family
(`profile`, `preferences`, `avatar`): ID, expected revision, content and original
photo bytes. No password or email is stored there. A lost response
is replayed with that same ID after resumption; the current response is re-read
after the receipt and a replay never restores the old profile over a more recent one.
Definitive refusals / proof requests stop the automatic retries,
keep the form and allow an explicit resume or abandon. A journal reset
keeps these intents of the account; another generation purges them.

The existing settings synchronize the language with the independent revision
of the preferences; unmodified fields are kept. The push levels
are wired but hidden as long as the client does not announce P17 push.
40 targeted tests, typing and lint pass; the HTTP / PostgreSQL / WebSocket /
SQLite bench also covers the personal profile, a lost confirmation followed by a more recent
concurrent profile, provider resumption, preferences and photos.

The GTK / SwiftUI public profile cards and their existing tiles use the same
Rust core: SQLite identities by UID, current names without modifying the journal,
DM by UID and protected avatars in memory (128 entries / 32 MiB / four reads).
Removed pixels and responses from a previous account are rejected. The Rust queue
also preserves the original profile / preferences / avatar intents and
their bytes, with resumption, required proof and explicit abandon through UniFFI.
The private data of the personal profile is not put in the public cache.

The existing GTK and SwiftUI personal forms are wired to both
providers. Private fields stay in memory on their account; the native
email is read-only with a pointer to Security. Selected photos
are re-encoded as PNG of at most 512 pixels by the native libraries.
Status, status text, name, username, bio, language and notification level
go through the Rust intents. The forms restore pending data,
request the existing recent proof, then offer resume / abandon.
An independent preference or photo does not give a profile draft
the right to silently overwrite a concurrent modification.

The desktop DM lists and headers use a common projection of the core,
with the counterpart's UID received in the live stream and their current public identity.
The SQLite link is kept offline for the same membership, cleared on a
removal / change of membership or authority; an old live photo cannot
restore it. Only name / UID / photo reference are persisted, with no presence,
typing, email or preferences. The information button reuses the public profile card
by UID, even after a rename. Photo removal and replacement refresh the existing
tiles; no Rocket.Chat avatar path receives a native bearer.

Verification: 13 targeted Rust tests / clippy; 43 checks of the real GTK binary
including the cards, personal saving, the DM name and photo,
information by UID and photo removal. Profile notifications
keep the current avatar downloads, whose IDs are immutable.
The Swift models and the connected profile scenario are verified with the
PostgreSQL server and Secret Service; compilation of the macOS views is followed by CI.
Qualifications on installed applications remain open in P16.
