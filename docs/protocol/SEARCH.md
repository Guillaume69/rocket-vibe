# Native in-room search (P13 / J2)

`GET /api/v1/rooms/{room}/messages/search?q=…&before=…&limit=…` returns
`SearchPage { membership_version, messages, has_more }`. `before` is the exact
decimal position of the last result; pages are sorted from the greatest
position to the smallest, roots and replies together. Default and maximum:
50 results. The response stays limited to 512 KiB; a shortened page keeps
`has_more`. The existing screens present the first 50 results, like
their Rocket.Chat search; the protocol allows continuing the pagination.

PostgreSQL uses a `simple` vector generated from the written text and a GIN
index. All the words of the query must be present. Case ignored, accents
kept; no regex, SQL syntax, stemming or boolean operator supplied by
the client. Limits: 256 bytes, 16 words, at least one alphanumeric character.
Deleted messages and system events are excluded from the index.
An edit updates the vector in its usual transaction.

Only current members can search a room, public, private or DM.
The administrator role gives no implicit access. The authorized query and
its custom quotes are read in a consistent view; the delivery barrier
revalidates session, generation and rights of each source room before
transmitting. The text of quotes from another room does not enter the index
of the message that quotes them. Query, results and budget do not write to the journal.

Separate budget: 20 searches / minute / device, shared between processes via
an UNLOGGED table. `429 search_rate_limited` carries `Retry-After`; the mobile
transport respects this delay. Budget expiry is cleaned up in batches. SQL
reads are bounded to two seconds and the messaging commands keep
their own budgets. Unknown fields, excessive limit and non-canonical
position are refused.

The providers normalize the results for the same mobile rows,
GTK panels and SwiftUI models / views. They do not add them to SQLite, to the
history window, to the outbox or to the sync cursor. The public membership
version is verified before display. Edit, deletion, removal,
new generation and suspension invalidate the temporary observations; a
simple read refresh does not stale them. The search field allows
a relaunch with Enter. A late response from the old account or the old
room does not repopulate the results.

The `search` capability exposes this plaintext text search. RocketVibe
does not yet announce `e2ee`. **The P13 / J4 part remains open**: bounded local
index of the available decrypted content, indication of the downloaded history,
erasure on lock, on deletion and according to retention. It must
be integrated into the J4 native key lifecycle; no encrypted plaintext is
sent to the server to bypass this step.

Qualification: PostgreSQL scenarios for access, pagination, Unicode, edit,
deletion and budget; validation of pages and real SQLite on the client side;
journeys of the real mobile provider and checks of the GTK panel and the connected
Swift models. The qualification of installed applications remains open.
