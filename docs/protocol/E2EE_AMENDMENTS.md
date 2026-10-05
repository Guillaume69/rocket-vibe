# Encrypted edits and deletions

Private (MLS) messages of the RocketVibe server can be edited and deleted by their
author. Both are **amendments**: ordinary application messages of the same room,
encrypted and authenticated like any message ([E2EE_MESSAGES.md](E2EE_MESSAGES.md)),
whose header says what they amend. They follow the [archive rules](E2EE_ARCHIVE.md):
an amendment is an authenticated event applied to the archive at projection time; a
deletion removes the document's projection, it does not erase a copy already made.
No production capability is enabled by this document.

## Format

The application header (`rv_crypto_public::messages::Header`) gains:

| Field | Content |
|---|---|
| `kind` | `chat` (a message), `edit` (replaces the text of `target`), `delete` (removes `target` from the projection) |
| `target` | Absent for `chat`. For `edit` and `delete`, the message id of the amended message, in the same room; never the amendment's own operation |

`kind` and `target` are in the routing header, so they are bound into the MLS AAD and
the author's proof, and visible to the server like the thread root. `thread` stays
the target's thread (its root for a reply, absent for a root), so routing and the
thread's audience do not change. The encrypted payload is a `SendMessage` with:

- `edit`: the new text, no quotes and no cards (an edit changes text only);
- `delete`: an empty text, no quotes and no cards.

Old headers without `target` encode as before: existing vectors stay valid.

## Rules

- Only the **author** amends: an amendment whose author differs from the target's
  author is ignored, wherever it comes from. The sending device checks it before
  preparing; the server refuses it on submission (`invalid_amendment_target`).
- The latest amendment by journal position wins. A deletion is final: a later edit of
  a deleted message is ignored.
- Amendments are never rows: they are left out of pages, of `has_older`, of thread
  roots and of reply counts, and applied to their targets wherever a target is shown
  (pages, thread roots, quote sources). An edited message shows the new text and an
  `edited` mark; a deleted one leaves the pages and reply counts, and a deleted thread
  root is not returned.
- No separate index: a projection walks the room's retained documents newest first,
  so it meets every amendment before its target, wherever the page boundary falls.
  Recovered history (paths A and B) carries amendments as ordinary documents; its
  amendments and the device's own are merged, the higher position winning for an edit.

## Clients

An amendment is an ordinary private operation: the same outbox, resume after a lost
response and cancellation as a message. Until it is accepted and journaled it is not
applied for readers; the author's apps show it on its target (new text, pending
mark) and retry or cancel it from there. Prepared amendments are kept like messages,
so a cancelled one leaves no trace in the projection.

## Server

`POST …/messages` refuses an `edit` or `delete` whose `target` is not an accepted
message of the same room by the same author, or whose `thread` differs from the
target's thread root. It stores the amendment like any message; it never learns the
new text.
