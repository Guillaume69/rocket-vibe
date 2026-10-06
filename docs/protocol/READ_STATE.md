# Reads, unread counts and room favorites (P05)

Server, Rust / TypeScript transports and durable controllers wired to the
existing GTK / SwiftUI / mobile interfaces. The client capabilities
`read_markers` and `favorites` follow the features announced by the server.
Qualification of installed applications remains open.

## Personal state

`GET /api/v1/rooms/{id}/read` returns `ReadState` for the authenticated account,
with a current membership mandatory, including for an administrator. The same
optional state is attached to `Room.read_state` in lists, snapshots and
`room_upsert` events. An old v1 server may omit this field.
It is added after filtering recipients and memberships, in the same
transactional view as the read. The shared journal never stores this
personal data; the size limits include the added fields.
HTTP / WebSocket delivery keeps the existing revocation barriers.

Three versions have distinct uses:

- `revision`, a global decimal position, orders the whole personal state;
- `favorite_revision`, the decimal version of the favorite, is used for concurrency control
  of this preference. Messages and reads do not make a favorite
  form stale;
- `membership_version`, an opaque nonce of the membership lifetime, changes after
  removal / rejoin. A role change does not modify it.

The metadata revision `Room.revision` remains independent. A personal event
must not invalidate the rights or the details of the room. Clients
must compare the metadata and personal state versions separately,
as well as their identity / generation and the membership lifetime.

## Monotonic read

`POST /api/v1/rooms/{id}/read` accepts only `MarkRead`:
`root_position` and `reply_position`, canonical non-negative decimal strings.
The server advances by transactional maximum. An old device never brings
the read position backwards; an identical retry consumes no quota and
publishes no second event. A position greater than the last message
of the room produces `409 invalid_read_position`. New advances are
limited to 60 per minute per account, independently of the other commands.

Unread counts count new root messages from other authors after the
read position. Edits and reactions do not increase them; deleting an
unread message decreases them without advancing this position. Own sends excluded.
Counters and positions remain strings, even beyond `2^53`.
A new membership initializes its read position to the last existing message;
earlier history stays accessible, without adding a backlog of badges.
The migration adopts the same rule for existing memberships.

The [P11 threads](THREADS.md) have their own reads. `reply_position`
serves a global read of the room's replies; each reply uses the
maximum of this position and of the read of its thread. `unread_replies` and
mentions follow this same rule. Reading one thread does not read the other threads.

## Mentions

On the original send, the server derives the recipients from the Markdown.
Native usernames are exact and case-sensitive. They must match
an active member of the room; the author and outsiders are excluded.
Repetitions count only once per message. `@all` targets the other active
members at the time of sending. A message that
directly mentions a recipient and also contains `@all` counts in
`mentions`, with priority over `group_mentions`: no double badge.

The [pulldown-cmark](https://docs.rs/pulldown-cmark/0.13.4/pulldown_cmark/) parser
identifies the Markdown structure; the [shared native document](MARKDOWN.md) uses
the same rules and the markers of the existing composers. Its source offsets
preserve escapes.
Inline code / blocks, quotes, links and image labels do not trigger a
mention. Email addresses and raw URLs are also excluded. Names
formatted in bold / italic are still recognized. No recipient ID supplied
by the client is accepted. The text limit remains 32,768 bytes.

Counters concern only unread, non-deleted messages. An
edit may remove an original mention by deleting its token; it cannot
add a recipient or restore a previously removed mention. Reading
or deleting the message removes the badge. A new membership does not receive
a historical notification, while keeping access to the history.

`@here` waits for the P12 presence leases: it remains text with no notification
in this batch. It never means `@all`. The full catalog / rendering of
mentions in the three clients will be qualified with P07 / P12.

## Explicit favorite and receipt

`PUT /api/v1/rooms/{id}/favorite` accepts `SetRoomFavorite`:
`operation_id`, `expected_revision` equal to the observed `favorite_revision`,
and `present`. The favorite is private, requires a membership and uses the quota
of room commands: 30 new commands per minute per account.
Unknown fields and a forged recipient identity are rejected.
A version conflict produces `409 revision_conflict`.

The response is a minimal personal `RoomCommandReceipt`. The client can
re-read it via `GET /api/v1/rooms/{id}/commands/{operation}` after a lost
response, without a second write and even after leaving the room. The receipt does not
project a favorite value: the client re-reads the current state. Replaying
the original operation returns the same receipt without restoring an old preference,
even after removal / rejoin. Reusing its ID with another body or in
another command domain produces a conflict.

Removal deletes the server's personal state. On rejoin, the preference
restarts at false with a new membership lifetime and a new version.
State and receipt reads remain possible during `Retry-After`;
no secret or old preference is returned to another account.

## Verification

Six Markdown cases and ten PostgreSQL / HTTP scenarios cover two concurrent devices, own sends
and deletions, journal confidentiality, removal / rejoin,
role-independent versions, conflicts and forged fields. The real
mobile transport simulates a lost favorite response and finds the receipt without a
second write; its old replay does not restore the deleted favorite. It
also verifies deduplicated mentions, removal by edit and reading of the message.
The real read quota keeps the state, receipts and favorites available;
an old retry received by the server consumes no advance.

## Client caches

Mobile and the desktop core keep the personal state in a SQLite table
separate from the room metadata. An old personal response does not restore
a favorite; an old room revision does not overwrite its current name.
A personal update keeps the effective rights as long as the metadata
revision stays the same. Identical HTTP responses do not rewrite
the state and do not re-arm the read timers.

An authorized snapshot or event carrying a new `membership_version`
purges the old private data, drafts and intents of the room, then
invalidates the in-flight history / command responses. A role change
keeps this membership lifetime and the current intents. An HTTP response
cannot itself change the cache's membership lifetime. Caches without a membership
witness cannot prove that their old intents survived a missed
removal: their first snapshot carrying this witness purges them too.
Desktop recovers the witnesses already present in its old room payloads.

The composer also captures this membership lifetime when it opens. Reading,
saving and clearing a draft, as well as adding to the outbox, check
this witness in the same SQLite transaction as the write. An unmount flush
or a deferred save from the old screen therefore cannot reintroduce its text
after the purge, nor erase the new draft. Open buffers and forms
are reset when the witness changes; a role update keeps them.
Mobile waits for the first read of the witness before mounting the composer.

Both clients now keep their intents in the private tables
`native_read_intents` / `native_favorite_intents`. The renderer supplies the ID of the
message actually observed; only a confirmed message of the same room can be
recorded. Observed positions are grouped by exact maximum, without taking
the last message in the cache at retry time. An earlier response does not erase
a more recent observation, and recording alone re-arms no timer.
The path intended for the timers also receives the membership lifetime captured
by the screen: its verification and the recording happen in the same transaction.
An old callback after removal / rejoin therefore cannot read the history of
the new membership. The mobile provider requires an explicit observed ID; the
bindings and the Swift model keep positions as strings.

The favorite records its ID, membership lifetime, expected revision and
explicit value once. Another value does not replace an unresolved attempt.
The runner re-reads the original receipt; only `404 not_found` allows the original PUT.
A saved receipt becomes a version bound: the command stays confirmed
until a current state whose `favorite_revision` covers this bound. After a crash,
a state read resumes this confirmation without a second PUT. A permanent refusal
is kept and requires explicit clearing of its exact ID before replacement.

Reads first re-read the state to recover a lost acknowledgement, then
send only the saved observed position. Read and favorite timeouts
are separate; a read quota leaves the journal, sends and favorites
available. Identity, generation, projection and membership lifetime are re-verified
around the requests. A connection upgrades a cache without a membership witness through
a snapshot before replaying its intents.

Favorites are wired to the existing GTK / SwiftUI cards and menus and to the
mobile card, with their client capability enabled. The click keeps the revision
and the membership lifetime displayed, checked atomically before recording.
Only the confirmed personal state changes the ranking among favorites; a
pending request shows Resume, a refusal allows clearing its exact ID.
The Rocket.Chat handlers keep their official route through the active provider.

The existing badges, separators and read timers are wired into
GTK, SwiftUI and mobile; `read_markers` is enabled on desktop and intersected
with `lecturesSalon` on mobile. Badges use only the confirmed
counters and clamp them for display, without converting positions to
floating-point numbers. The separator bound remains the one captured on opening,
even after the read has been acknowledged.

GTK retains the confirmed ID of a bound row whose bounds intersect the
viewport; an inactive / hidden window, a modal card or a scrolled-up list do not
schedule a read. SwiftUI uses row visibility, the keyboard-focused window
and the closing of panels. Mobile reads the visible indices
of FlashList with the displayed projection and its confirmed positions, after
resolution of the opening bound, only in the foreground on the active
route. Timers keep their initial ID during a burst; an ID seen
afterwards waits for the next timer. Mobile flushes the observations already seen
on route change / moving to the background, without reading a new ID from the
cache. Cancelled / closed callbacks do not create a second request.

The connected GTK flows and Swift models, mobile controller / PostgreSQL,
exact-position tests and Hermes export are qualified locally. The
compilation of the new SwiftUI views awaits their CI; flows on installed
Android, Windows and macOS applications remain to be qualified.
