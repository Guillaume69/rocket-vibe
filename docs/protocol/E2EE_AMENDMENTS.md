# Encrypted edits, deletions, reactions and search

Private (MLS) messages of the RocketVibe server can be edited and deleted by their
author, and any member can react to them. All three are **amendments**: ordinary
application messages of the same room, encrypted and authenticated like any message
([E2EE_MESSAGES.md](E2EE_MESSAGES.md)), whose header says what they amend. They follow
the [archive rules](E2EE_ARCHIVE.md): an amendment is an authenticated event applied
to the archive at projection time; a deletion removes the document's projection, it
does not erase a copy already made. Search runs on the device over the same
projection. No production capability is enabled by this document.

## Format

The application header (`rv_crypto_public::messages::Header`) gains:

| Field | Content |
|---|---|
| `kind` | `chat` (a message), `edit` (replaces the text of `target`), `delete` (removes `target` from the projection), `react` (adds the author's reaction to `target`), `unreact` (withdraws it) |
| `target` | Absent for `chat`. Otherwise the message id of the amended message, in the same room; never the amendment's own operation |

`kind` and `target` are in the routing header, so they are bound into the MLS AAD and
the author's proof, and visible to the server like the thread root. `thread` stays
the target's thread (its root for a reply, absent for a root), so routing and the
thread's audience do not change. The encrypted payload is a `SendMessage` with:

- `edit`: the new text, no quotes and no cards (an edit changes text only);
- `delete`: an empty text, no quotes and no cards;
- `react` and `unreact`: the emoji name as text (`[a-z0-9_+-]{1,80}`, the canonical
  name of a standard emoji such as `thumbsup`, or a custom emoji's name), no quotes
  and no cards. The server never learns which emoji.

Old headers without `target` encode as before: existing vectors stay valid.

## Rules

- Only the **author** edits or deletes: an edit or deletion whose author differs from
  the target's author is ignored, wherever it comes from. The sending device checks it
  before preparing; the server refuses it on submission (`invalid_amendment_target`).
- The server accepts an amendment only on a message this device was delivered
  (the thread root's admission witness), so a device never names a message it
  could not read.
- Any member reacts to any message. For one user and one emoji, the latest `react` or
  `unreact` by journal position wins. A message shows each emoji with the users whose
  latest action is `react`, in the order of their first remaining reaction.
- The latest edit by journal position wins. A deletion is final: a later edit of a
  deleted message is ignored, and its reactions go with it.
- An amendment never targets another amendment.
- Amendments are never rows: they are left out of pages, of `has_older`, of thread
  roots and of reply counts, and applied to their targets wherever a target is shown
  (pages, thread roots, quote sources, search results). An edited message shows the
  new text and an `edited` mark; a deleted one leaves the pages and reply counts, and a
  deleted thread root is not returned.
- No separate index: a projection walks the room's retained documents newest first,
  so it meets every amendment before its target, wherever the page boundary falls.
  Recovered history (paths A and B) carries amendments as ordinary documents; its
  amendments and the device's own are merged, the higher position winning. Recovered
  periods are walked one after another, so the comparison is by position, not by the
  order of the walk.

## Search

`journal_search` looks for a text (1 to 256 characters once trimmed, case-insensitive)
in the shown text of this room's verified documents on the device: the latest edit,
else the original text; deleted documents and amendments are left out, thread replies
included. It walks the own journal newest first, then, when the own journal has fewer
matches than the limit, the recovered history; results are newest first by message
position, at most 200, with a `truncated` flag. Nothing is sent to the server, and no
index is written: the text stays in the protected storage, never in the ordinary cache.

## Clients

An amendment is an ordinary private operation: the same outbox, resume after a lost
response and cancellation as a message. Until it is accepted and journaled it is not
applied for readers; the author's apps show it on its target (new text or reaction,
pending mark) and retry or cancel it from there. Prepared amendments are kept like
messages, so a cancelled one leaves no trace in the projection.

## Server

`POST …/messages` refuses an amendment whose `target` is not an accepted, non-amendment
message of the same room, or whose `thread` differs from the target's thread root, and
an `edit` or `delete` by anyone but the target's author. It stores the amendment like
any message; it never learns the new text or the emoji.
