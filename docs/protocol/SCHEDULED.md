# Scheduled messages

A RocketVibe server announcing `scheduled_messages` keeps text messages and sends
them for their author at a chosen time, whether or not any of the author's
apps runs then.

## Commands

- `POST /api/v1/rooms/{id}/scheduled` takes `ScheduleMessage`:
  `operation_id`, `text` (1 to 32,768 bytes, not blank), optional `reply_to`
  (a root message of the room: the message goes to its thread), and `send_at`
  (RFC 3339, at least one minute ahead, give or take ten seconds, and at most
  30 days). It answers `ScheduledMessage`. The author must be a member allowed
  to post; an end-to-end encrypted room answers `409 encrypted_room` (the
  server never holds its plaintext). At most 100 pending per account
  (`409 scheduled_limit`). Replaying the same `operation_id` with the same
  room, text and thread answers the same scheduled message; another body under
  it is `409 conflict`, and an id already used by a sent message too.
- `GET /api/v1/scheduled` answers `ScheduledMessages`: the account's pending
  and failed scheduled messages, every room, soonest first (200 at most).
- `DELETE /api/v1/scheduled/{id}` cancels a pending one or dismisses a failed
  one (`204`). One being sent at that moment answers `409 scheduled_sending`:
  it is about to arrive. Another account's id answers `404`.

## Sending

A worker looks every 5 seconds for due messages, leases up to 16 for a minute,
and sends each through the ordinary send path as its author, with one of the
author's live sessions, so the author must still be an active member allowed to
post. The scheduled message's `operation_id` is the sent message's: a worker
that dies after the send and before removing the row replays an operation the
send path answers with the message already made, never a second one.

A sent one leaves the list; the message itself reaches every client like any
other. A refusal (no longer a member, posting not allowed, the room became
encrypted, no live session left) turns the row `failed` with the refusal's code
in `error`, kept until its author removes it. A server error leaves the lease
to lapse and the next tick retries.

Text only: no files, quotes or cards.
