# Structured room activity (P07)

The additive field `Message.system` describes a server action. It is absent
from ordinary messages and from old v1 responses. It contains a typed `kind`
and only the necessary data: name, topic, description, announcement,
privacy, read-only, target user and roles before / after.
Creation, join, leave, adding and removing members are covered.
A direct call's ring publishes `call_started` (its `meeting_id` is the ring
id), and each outcome revises that row: the additive `Message.call` carries
`{state, duration_seconds?}` ([VOICE.md](VOICE.md)). An older client keeps
showing "call started". Future file and administration activities will follow
their batches.

The author of the row remains the account that performed the action. No translated
sentence, no Markdown tree and no Rocket.Chat type identifier
travel in this field. `SendMessage` refuses this field; the client cannot
create a server activity by sending text. The database enforces empty text,
absence of quoted references and absence of tombstone for these rows.

The row, its position and its journal event are written in the transaction
of the room change. Command receipts and operations with no change
avoid duplicates. An update of several fields produces one row per
modified field; a revision conflict cancels the whole transaction. The events
of these rows and the history pages use the same ACLs as messages.
A removed member receives the removal from the room, without the private activity that follows.

These rows create neither unread, nor mentions, nor a new-messages separator.
They accept neither edit, nor deletion, nor reaction, nor pin, nor star,
nor selection as a quote source. Reads can advance beyond
a visible activity without turning this activity into an unread message.

The adapters convert the data into the existing system rows,
with their author and their parameter. SQLite keeps this projection in the
sync transaction. The desktop core serves GTK and UniFFI / SwiftUI;
mobile uses `systemText`. French and English are available. The
Rocket.Chat events continue to go through their historical normalizer.

The HTTP / PostgreSQL scenario verifies replays, conflicts, forgery
attempts, refused actions, counters, synchronization and private removal.
The projection tests verify the rows and their translation. The GTK bench
inspects the row in the existing widget; the Swift bench exercises the shared
models against the server and the secure storage. The visual qualification
of the installed Android / Windows / macOS applications remains open.
