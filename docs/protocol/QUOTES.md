# Native quotes (P07)

The references, their server-side resolution, the shared desktop
GTK / SwiftUI and mobile caches, and the durable intent bodies are delivered. The `quotes`
capability enables the reply actions of the three existing interfaces: cards,
menus, banners and composers are reused, including quotes nested
to two levels. Qualification of installed applications and full parity
of private quotes remain open; this batch does not close P07.

## Experimental private quotes (GTK / SwiftUI / Android)

The existing reply menus, banners and cards can now quote a
message kept in the private journal, root or thread reply. The composer
keeps a transient selection bound to the instance, its generation, the lifetime
of the public membership and the personal admission of the vault. A new command
re-verifies this selection before preparing the MLS document; only the three
fields of `QuoteReference` are in this document, never the author or the excerpt.
In this first immutable private format, the observed revision is the signed
publication position, kept as an exact decimal string.

A quote alone is possible. After a lost response, resumption and reopening
consult the receipt of the protected original; they do not reselect its source
and do not re-encrypt its document. The SDK bounds the references to eight distinct
sources; the current composers select one quote at a time.

The reader resolves the retained sources, including thread replies, from
the same verified private prefix. Observations are grouped by source room.
Each source must keep its membership and its admission; a re-read before
exposure masks the removed sources, without recovering their words in SQLite.
Names can reuse the public identities already known. Excerpts
are bounded to 1,024 Unicode characters, descendants to two levels and
cycles to their room / message pair. An inaccessible parent reveals no
child. The private list is rebuilt over its whole retained window so as not
to keep an old card after removal from another room.

On Android, the action sheet opens a volatile private view before any
SQL read of the message. "Répondre" passes only the selection to the
composer; its preview is rebuilt from a fresh vault access. Blur,
suspension and removal erase its words while keeping the reference for
validation or cancellation. Copy also re-reads the current private message.
A selection carrying a crypto admission is rejected by the ordinary SQL
queue, before any write. No private text transits in the navigation
parameters.

### Cleartext sources in an encrypted conversation

The GTK / SwiftUI / Android readers now combine the sources of the
vault and the ordinary excerpts already kept. The ordinary read is
bounded to the requested identifiers, the cache generation and the current
membership; the source room must be known and unencrypted. An old SQLite
row of a room that has become encrypted never serves as a private source. The cache
excerpts carry their current public revision and only the references
of their descendants. The words of a private descendant are rebuilt in
the volatile card from its own vault, never recorded in this parent.
Re-read before exposure, two levels and cycles by room / message
remain applied. Edited source: new excerpt; removed source or one from an
old membership: parent unavailable and no descendant. A removal that
invalidates the projection closes the view; a new view rebuilds the cards.

The desktop SDK and UniFFI can also select an ordinary source for
an MLS document, after verifying its revision and its membership. Only
its references are sent. The selection explicitly distinguishes ordinary source
and protected admission; clearing the admission of a private selection
does not make it ordinary. After a lost response, the same ciphertext stays
resumed by receipt, even if the source has changed.

Android also prepares cleartext references in the MLS document: the runner
revalidates the exact sources in the ordinary cache, their scope, unencrypted status,
membership and revision, then re-reads them before the native command. It passes
to the bridge one witness per room carrying only membership and references. No
excerpt is included in this witness or in the protected intent. Rust verifies
scope, bounds, uniqueness and exact matching of the witnesses; a source already
known as a protected group, even pending or removed, cannot become cleartext
by deleting its admission. The trust in the cleartext witness comes from the authenticated
cache adapter, not from an MLS signature of the ordinary author.

The existing Android, GTK and SwiftUI sheets / menus make it possible to choose
a destination where the user has the right to send, among the joined
conversations. Cleartext or private sources are re-read by the destination, whether
cleartext or encrypted. Navigation carries only the reference and its selection
authority; opening the composer sends nothing. Private previews are
volatile, and their closing / replacement invalidates late results.
These flows transmit no private excerpt to other members.

Full parity of mixed quotes, quoted files, sources
outside the retained window, evolution of revisions with private editing and
installed GUI qualification remain open. The production E2EE capability
stays disabled; this batch closes neither P07 nor J4.

## Commands and receipts

`SendMessage.quotes` is an optional list of `QuoteReference`:
`room_id`, `message_id`, `revision`. An edit command uses the same list
in `MessageContent::Plain`. No author, excerpt, right or computed attachment
is accepted in these references. An old command without `quotes` keeps
its behavior and its replay fingerprint.

A command accepts up to eight distinct references. IDs and revisions are
validated; revisions are exact positive decimal strings. A message
does not quote itself. A quote alone is possible without reply text.
On addition, the source must exist, be readable by the author and carry the observed
revision; otherwise the command fails without publication. `quote_revision_conflict`
requests a new selection of the source. Room locks are acquired
in the order of the IDs, before memberships, messages and the sequencer.

The durable identity includes the ordered list of references. A diverging resend
fails with `operation_conflict`; the original resend keeps its result even
after edit or deletion of the source. An edit can keep an existing
reference that has become inaccessible, without keeping its private excerpt.

## Reads and authorization

`Message.quotes` contains `MessageQuote` entries: `reference`, `excerpt`,
`view_position` and `source_membership_version`. The excerpt
is absent (`null`) if the source is deleted or inaccessible to the reader.
Instance administration does not bypass membership of the source room.
An inaccessible reference contains neither text nor the identity of the source author.

An authorized `QuoteExcerpt` contains author, text bounded to 1,024 Unicode characters,
date, **current** revision of the source and `membership_version` of the reader in
the source room. The reference keeps the revision observed at selection time.
The excerpt follows the current content; an old copy of the text is not kept
in the reply message. References trigger no mention.

The excerpt also carries the current `references` of its source and the resolved
`quotes` for this reader. Both lists are additive and empty by default.
The server resolves at most two levels, with eight references per source: a
response carries at most eight direct excerpts and sixty-four children. The terminal
level keeps the references of its source but no additional excerpt.
Each child has its own position and its own access right; reading the
parent source does not grant access to its private quotes. An inaccessible parent
discloses no child reference. System messages are not quotable.

Each resolution carries a `view_position`, an exact decimal string of the instance
journal, even when the excerpt is absent. The source, the membership and this position
are read in a single SQL view. `source_membership_version` is present if the
reader belongs to the source room, including after deletion of the quoted message;
it is absent without membership. When the excerpt exists, its two membership lifetimes
must match. These fields do not enter the shared event.

The PostgreSQL messages table and the shared journal receive no copy
of a server excerpt: the
SQL events keep the references. History, message, pins / stars,
snapshot and HTTP / WebSocket catch-up compute the excerpt for the reader.
The personalized materialized snapshots include these excerpts in their budgets
and are invalidated on a change of content or of access to the source.

The delivery proof covers the destination room and each source room whose
excerpt or membership lifetime is included. It re-verifies instance identity, account / session,
membership and authority version, then keeps the locks until submission of the
HTTP body or the WebSocket flush. Removal / rejoin or modification of the
source while the response is being built prevent delivery of the old
bytes; the verification applies to the source itself even if the destination remains readable.

## Existing desktop and mobile caches

SQLite keeps the ordered references separately from the views of their sources.
A view memorizes room, membership lifetime, resolution position and nullable
excerpt. History or action responses can refresh the source view
even if the public revision of the quoting reply is unchanged or older.
They never replace the references of a more recent reply.

An edit / deletion received from the source refreshes the cards in all
rooms. An unavailable result wins a position tie. A removal or a
new membership purges the excerpts of the origin in the other rooms; the existing
projection token discards old HTTP calls. An absence of membership
dated before the new membership does not purge its data. A snapshot reset
rebuilds the excerpts so as not to keep a missed deletion.

A source row keeps only its excerpt and its references; it never keeps
a copy of the text of its descendants. Nested cards are rebuilt
from the source rows, with a check of each membership, depth limit
and cycle cutting. The mobile cache also refreshes the replies depending
indirectly on a modified or removed source, in the existing transaction.
The source payloads kept after a removal therefore contain no private
descendant text, and a late response does not restore it after reopening.

The providers project the authorized references and views to the local parts
already consumed by `content::quotes`, the Swift models and the mobile component
`Citation`. Mobile SQLite refreshes `messages.pieces_jointes` in the
projection / cursor transaction; its existing listeners refresh the open lists.
The additive migration keeps the history and the exact positions already present.
The protocol carries
no Rocket.Chat tree or Rocket.Chat permalink. The existing cards keep
the Markdown of the excerpt, and an unavailable reference keeps neither author nor
text. The existing cache notifications refresh the open rooms.
Native text is kept even if it looks like an old Rocket.Chat quote
prefix; official quotes keep their historical handling.

## Existing edit intents

The desktop and mobile edit commands capture the ordered references in
the same transaction as the text and the operation identifier. The expected revision
must match the reply currently projected. The references remain
readable after loss of access or deletion of the source, without copying its excerpt
or its membership lifetime into the command. A more recent projection, a reset or
a SQLite reopening do not rebuild the body of a pending operation.
The adapters transmit it to the `content.quotes` field of the native protocol.
If the cache already holds another revision, the intent is kept as failed
with `revision_conflict` and its words remain available in the form;
no reference of a different version is captured or sent.

The additive migration marks the old commands with a nullable column.
An old edit without a captured body stops before the network call; its text
remains available in the current form and a new submission creates a
new operation. This limit avoids silently changing the body of a
key that may have been accepted before the cut. The other old actions remain
replayable. The Rocket.Chat provider and the edit interfaces remain unchanged.

## Existing native send queues

The desktop core and the mobile engine capture a selection from a confirmed
message in the cache, with its exact revision, the instance / generation and the membership
of the source. The queueing transaction re-verifies this selection and, if
provided, the membership context of the destination composer. Optimistic sources,
deleted ones, old memberships, other generations and duplicated references are
rejected before publishing the local intent.

Only the ordered references are persisted in the sent body. A quote
alone can be queued; the same identifier and the same body are transmitted
to `SendMessage` after reopening or reset, even if access to the source has since
disappeared. The optimistic cards use the existing view cache and lose their
excerpt on removal. Confirmation, deletion of the intent and cursor remain
transactional; abandon and change of generation purge the associated rows.
The old text intents migrate with an empty list without changing their replay.

The UniFFI bridge exposes this selection and the membership-bound send for the existing
Swift models. The mobile provider, HTTP / PostgreSQL and SQLite flow verifies a response
lost after commit, source removal, resumption of the original body, single message,
conflict after edit and new selection. The three menus and composers are
wired to the native references. Rocket.Chat keeps its permalinks and its
historical optimistic display. A native selection alone can be sent
without added text. A refused queueing keeps the words and the selection
for correction / cancellation. Open previews lose their words and author
if the source is no longer current or accessible; an unavailable reference has a
translated label in the existing cards.

## Next wiring and exit conditions

A new reference to an MLS message in an ordinary room requires the
same reader check as the private journal: current session / certificate,
incarnation, membership and activation, then exact witness of the historical admission
to the message. The expected revision is its opaque position. The server returns
only the reference and the membership watermark; no private excerpt, author,
ciphertext or file joins the ordinary response. An already
accepted operation keeps its receipt even after the certificate expires.

Android resolves these references in a native reader distinct from the MLS composer,
with no message preparation or draft. Rendering applies its cards after
the smoothing of the ordinary list; the SQL cache and the smoothing buffer
receive no private word. A re-read of membership / admission precedes their
publication. Blur, suspension, account / generation replacement and removal
dispose of the readers and also purge the composer banner.
Before the ordinary send, this reader validates scope, source and retained position;
a synchronous in-memory authorization and the SQL transaction re-verify its
lifetime and the membership of the source. The ordinary queue receives exclusively
the references. The ordinary call without a reader continues to refuse a private
selection. GTK / SwiftUI also apply a volatile projection on their ordinary
SQL window, including in threads. Their reader can neither write a
draft nor send; the composer has a distinct actor that re-reads the
sources before supplying a non-persistent synchronous permit to the SQL queue.
Membership, encrypted mode and projection guard are re-verified in the transaction.
The parent's personal text stays in the draft during this validation;
only the matching draft is consumed with the accepted intent. A more
recent text survives, and a refused selection does not lose its text.

The adapters translate the references to the existing quote cards,
with an explicit label for
unavailable references. The excerpt cache stays distinct from the public revision
of the reply, follows the source revisions and is bound to its membership.
The resolution positions also order the results without an excerpt: an
old response must never restore the text after a deletion or a
removal. At equal position, an unavailable result prevails over an excerpt.
The default position `0` of an old prototype provides no authority
to restore or erase the cache. A response older than a rejoin cannot
erase the excerpt of the new membership.
A removal purges the excerpts of this origin even in the other rooms;
a late response from the old membership does not restore them. An edit or
deletion received from the source refreshes the quotes already displayed elsewhere.
The durable send queue keeps the references, without capturing a right or an
excerpt as authority. The scenarios of response loss and resumption must
go through the real mobile / desktop caches and the Swift models.
The durable edit commands now keep the references; the
wiring of sending from the existing reply controls is delivered.

Quoted files are wired to the protected cards and readers of the three
clients: [P14 contract](FILES.md#quoted-files). The cache keeps the files
of each source in its own membership, even without a source message in history.
A parent does not keep the private metadata of its descendants.
Installed trials on
Android / macOS / Windows remain open. These batches do not close P07.
