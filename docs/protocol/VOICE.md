# Native voice (P21)

Every room has a voice session. A **voice channel** is a room flagged `voice`:
selecting it joins its session, the way Discord does. Any other room, direct
messages included, joins its session from the header's call button. Audio only.

The server announces `voice` only when the operator configured a LiveKit SFU
(`RV_LIVEKIT_CONFIG_FILE`). It replaces Jitsi meetings, retired from the native
server ([MEETINGS.md](MEETINGS.md)); `calls` stays in the discovery document,
always `false`, for older clients.

## The media path

The server never carries audio. It mints a short LiveKit access token for a
current member and observes the SFU; the clients speak WebRTC to LiveKit:

- the LiveKit room of a native room is `rv:{data_epoch}:{room_id}`, so a new
  data generation never meets an old session;
- the participant identity is the **account id**: an account has one voice
  connection, joining elsewhere moves it. A second device joining the same room
  takes the place of the first (LiveKit closes the older one with
  `DUPLICATE_IDENTITY`); joining another room removes it from the previous one;
- the grant allows subscribing and publishing the **microphone only**, with
  `can_publish` false for a plain member of a read-only room;
- a participant reports being deafened through its own attribute
  `rv.deafened` (`"1"` / absent). The display name comes from the profiles,
  never from LiveKit metadata.

## Encrypted rooms

An encrypted room (an E2EE group exists, [E2EE_GROUPS.md](E2EE_GROUPS.md))
has end-to-end encrypted voice: the SFU forwards frames it cannot read.

- A join must say `"e2ee": true` (the client can encrypt), or it is refused
  with `403 voice_encrypted_room`. The grant answers `"e2ee": true`: the
  client encrypts every frame or does not connect. In a plaintext room the
  flag is ignored and the grant omits it.
- The session lives in its own LiveKit room, `rve:{data_epoch}:{room_id}`,
  so plaintext and encrypted participants never meet: one connected before the
  room's group existed is evicted by the worker and rejoins encrypted.
- **The key** never reaches the server. Each device exports it from the
  room's MLS group at the current epoch: `MLS-Exporter("rocketvibe voice v1",
  group_id, 32)`. LiveKit's frame encryption (AES-GCM) takes it as its
  **shared key**, at key index 0, as the ASCII bytes of its standard padded
  base64 (`setSharedKey(String)` on Android and Swift, `Vec<u8>` in Rust: the
  same bytes everywhere), with LiveKit's default ratchet salt and PBKDF2.
- A new epoch (a member or device added or removed) is a new key: every
  client replaces key 0 when it sees its group advance. Until all have,
  frames under the other key do not decrypt: a short silence, never
  plaintext. A removed member cannot derive the new key, and the worker
  evicts it when it is no longer a member.
- A device whose group is not ready yet (not welcomed, epoch behind) cannot
  join: the client says why instead of connecting.

## Joining and leaving

`POST /api/v1/rooms/{id}/voice/join`

```json
{"membership_version":"grant1","data_epoch":"epoch1","ring":true,"e2ee":false}
```

answers a `VoiceGrant`, `Cache-Control: no-store`:

```json
{"room_id":"r1","url":"wss://voice.example.org","token":"eyJ...","expires_at":"2026-10-06T12:05:00Z",
 "can_publish":true,"ring":{"id":"g1","room_id":"r1","caller":{...},"callee":{...},"state":"ringing","expires_in_ms":30000}}
```

- The membership token and the data generation must be current (`409
  membership_replaced`, `409 data_epoch_changed`), like a typing lease.
- The token lives **5 minutes**: enough to connect. LiveKit keeps an
  established connection past the token's expiry; a reconnection after a
  network change asks for a new grant.
- `ring` is honoured in a direct room only, when no ring is already active
  there; elsewhere it is ignored.
- `503 voice_unavailable` when no SFU is configured.

`POST /api/v1/voice/leave` (no body, `204`) removes the account from its
session and cancels a ring it started that nobody answered yet. A client that
dies without leaving is removed when the SFU drops it.

## Who is connected

A server worker reconciles its table of voice sessions with the SFU every
**2 seconds** (`ListRooms`, `ListParticipants`, under an advisory lock so one
process polls). It adopts participants, forgets those gone, reads `muted` from
the microphone track and `deafened` from the attribute, and removes from the SFU
an identity that has no right to be there anymore: membership withdrawn, account
disabled, another room joined, an older data generation. A room switched to
read-only revokes the members' right to publish.

The live snapshot ([LIVE.md](LIVE.md)) carries it, per room:

```json
{"room_id":"r1","membership_version":"grant1","typing":[],
 "voice":[{"user":{"id":"u2","username":"bob","display_name":"Bob"},"muted":false,"deafened":false}]}
```

Who is **speaking** is not in the snapshot: two seconds is too slow. A connected
client reads it from LiveKit (active speakers), so it shows for the session it
is in.

## Camera and screen share

A grant lets a member who may speak publish their **camera** too; it starts
off, each client turns it on. The live snapshot marks `camera: true` on a
participant publishing an unmuted camera.

A room has **one screen share at a time**. The grant does not include the
screen: a connected participant claims it first.

- `POST /api/v1/voice/screen` (no body, `204`) claims the room's share for the
  account's session. The server then widens that participant's LiveKit
  permission to `screen_share` and `screen_share_audio`; the client publishes
  once its permission changed. `409 voice_not_connected` before the SFU reports
  the session.
- **A new share replaces the current one**: claiming while someone else
  shares moves the claim, and the previous holder loses the screen sources at
  once (the SFU unpublishes the screen). Its client stops capturing when its
  screen is unpublished or its permission no longer lists `screen_share`, and
  gives nothing back: a release only ever releases the caller's own claim.
- `DELETE /api/v1/voice/screen` (`204`) releases it; the SFU unpublishes the
  screen. Leaving the session or joining another room releases it too.
- The snapshot marks the holder with `screen: true`. The worker keeps every
  participant's permission in line with these rules on each pass.

## Ringing (direct rooms)

A join with `ring:true` in a direct room creates a ring and the room's
`call_started` system row (`SystemMessage::CallStarted`, its `meeting_id` being
the ring id). Both sides see the ring in the live snapshot's `rings` while it
rings and for **10 seconds** after it resolves:

| State | When |
|---|---|
| `ringing` | for **30 seconds** at most |
| `answered` | the callee accepted |
| `declined` | the callee declined |
| `missed` | nobody answered in time |
| `cancelled` | the caller left first |

- `GET /api/v1/voice/rings/{id}`: the ring, for its caller or callee.
- `POST /api/v1/voice/rings/{id}/accept` with `{"membership_version","data_epoch"}`
  answers a `VoiceGrant` for the room.
- `POST /api/v1/voice/rings/{id}/decline`: `204`.

Each resolution revises the `call_started` message, which then carries
`call: {"state":"missed"}`, or `{"state":"answered","duration_seconds":754}`
once both sides left. An older client keeps showing "call started".

The callee's push devices get a data push `voice_ring` (high priority, TTL
30 s) even when the callee is online, unless their chosen status is busy, and a
`voice_ring_end` when it resolves ([PUSH.md](PUSH.md)). A push carries ids only;
the app reads the ring with `GET /api/v1/voice/rings/{id}`.

## Operator configuration

`RV_LIVEKIT_CONFIG_FILE`: a regular JSON file of at most 16 KiB, not readable by
group or others:

```json
{"url":"wss://voice.example.org","api_url":"http://livekit:7880","api_key":"rv","api_secret":"<at least 32 bytes>"}
```

`url` is what clients connect to; `api_url` is where the server reaches the
LiveKit API (Twirp), usually on the internal network. `docker/compose.rocketvibe.yml`
runs LiveKit under the `voice` profile.

Room flag: `create-room --voice`, `set-room --voice true|false` on the CLI;
`voice` in `CreateRoom` and `UpdateRoom` (optional: absent leaves it unchanged),
exposed by `Room.voice` and `RoomDetails.voice`. A direct room is never a voice
channel.
