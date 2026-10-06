# Native presence and typing (P12)

The clients keep their composers, typing indicators and DM badges.
The Rocket.Chat provider keeps its current transport. The RocketVibe provider
exposes `presence` / `typing` only if the server also announces them.

## Writing and expiry

- `PUT /api/v1/me/presence`: `{ "status": "online" }`, with `online`,
  `away`, `busy` or `offline`. A lease belongs to an authenticated device,
  survives the renewal of its bearer and expires after **60 seconds**.
  `offline` removes its presence and typing leases. Another active device
  keeps the account's presence. Aggregation priority: busy, online, away.
- `PUT /api/v1/rooms/{id}/typing`: `{ "active": true,
  "membership_version": "read-state-token" }`, with optional `root_id`
  for a thread. The public membership token must still be current; a
  re-membership revives no old composer. Active typing requires the
  right to send and an available root in this same room. A stop remains
  allowed after switching to read-only. The lease expires after **10 seconds**.
- Both writes answer HTTP 200 / JSON `null`. They are not
  durable commands and have no receipt or replay mechanism.
- Active clients renew presence every **20 seconds** and
  limit active typing emissions to one every **3 seconds** per
  composer. Stops follow the emissions already committed. Offline, no
  presence / typing intent reaches SQLite or the outbox.

The PostgreSQL tables are **UNLOGGED**: several processes share the
leases, but a recovery after a crash need not restore an old "writing".
The readers also verify valid sessions, the instance generation,
account activation, current membership and current rights / roots.
A suspension / closure immediately forgets the local snapshot and attempts an
`offline` without blocking the interface. If the network is cut, the leases expire.

## Read and real time

The [profiles P16](PROFILES.md) batch adds optional `profiles` to the snapshot:
identity, revision, avatar version and status text of oneself and of the members
of shared rooms. They respect the same limit and expiry; they contain
neither email nor preferences and add no durable event.

`GET /api/v1/live` returns an authorized snapshot. The same snapshot is sent every
**2 seconds** through the sync socket negotiated with `live=true`:

```json
{"type":"live","data":{"ttl_ms":8000,"limited":false,
  "presence":[{"user":{"id":"u2","username":"bob","display_name":"Bob"},"status":"online"}],
  "rooms":[{"room_id":"r1","membership_version":"grant1","typing":[]}]}}
```

A room entry may carry `direct_peer` to link the DM badge
to the correspondent's real identity, without deriving their UID from the room name.
Typing entries carry a user and possibly `root_id`: the typing
of a thread is not displayed in the room's main flow.

These frames are distinct from `SyncBatch`es, have **no cursor** and do not
modify the journal. An old socket without `live=true` continues to
receive only the durable batches. HTTP and WebSocket keep the delivery barrier
of memberships / policies. Clients refuse a snapshot of an
old membership and forget it on revocation, suspension or after
**8 seconds without a new snapshot**, without depending on their wall clock to
validate a server lease. A user absent from a valid snapshot is offline;
an absent / expired snapshot means their status is unknown.

Pilot bounds: 1,000 rooms, 512 present users, 512 typings and
256 KiB per snapshot. Beyond that, `limited=true` makes observations be forgotten instead of
exposing a truncated list. A device has 60 temporary writes
per minute, with HTTP 429 / `live_rate_limited` and `Retry-After`. This budget is
independent of sends, actions and reads. A device has only one active
composer server-side; opening another typing replaces the previous one.

## `@here` mentions

The recipients are captured in the transaction of the first send: other
active members of the room having a device with a still-valid `online` or `busy`
lease. `away` / offline users are not added.
A later connection or an edit adds no recipient. Removing
the token during an edit removes the original ping. `@here` never means
`@all`; the Markdown and thread reading rules remain the same.

## Qualification

The PostgreSQL / WebSocket tests cover expiry, room isolation,
multiple devices, session revocation, generation, re-membership, budget and
`@here` capture. The client tests cover expiry without a received stop,
stale snapshots, separation of composers, absence of persistence and serialized
stop. The connected benches use the real mobile providers, the existing
GTK widgets and Swift models. The qualification of the installed
Android / Windows / macOS applications remains an open criterion of the RFC.
