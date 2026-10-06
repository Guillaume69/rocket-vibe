# Rocket.Chat import

The J5 import of [RFC 0001 §15](../rfcs/0001-rocketvibe-rust-server.md): an operator
command reads a Rocket.Chat 8.x database (MongoDB, read only) and writes its accounts,
rooms and history into a RocketVibe instance. It runs once, before the instance
receives any native write, and can be resumed after an interruption without
duplicating anything. Encrypted Rocket.Chat rooms are not imported yet (see the end).

```sh
# Server stopped (the object collector would race the file copies).
rv-server import-rocketchat --mongo-url 'mongodb://host:27017/rocketchat?replicaSet=rs0' \
  [--files-dir /path/to/FileSystem/uploads]
```

It prints a JSON report and keeps it in `import_reports`: what was imported, and every
omission with its reason. A run never reports a global success over lost data.

## Order and resumption

- **An empty instance.** The first run refuses an instance that already holds rooms or
  messages: positions must follow time (every listing orders by position), and an
  import after native writes would show old messages as the newest.
- **Phases, each resumable:** custom emojis, users (and avatars), rooms, messages (and
  their files, reactions, stars), memberships and read positions, room publication.
  Each batch commits its rows, their `import_ids` mapping and the phase cursor in one
  transaction; a rerun skips what the mapping holds.
- **Positions.** Messages are read in global `(ts, _id)` order and take consecutive
  positions from `instance.position`. Thread roots precede their replies by time.
- **No replayed journal.** Messages write no journal event: clients of a new instance
  start from snapshots. The last phase publishes each room once, in the order of its
  last message, so the room list sorts by recency; `snapshot_heads` are cleared.

## Mapping

| Rocket.Chat | RocketVibe |
|---|---|
| User `_id` | Kept when it is a native identifier (`[A-Za-z0-9_-]{1,128}`), else a new id |
| `username` | Kept; characters outside `[A-Za-z0-9_-]` become `_`, a clash gets `-2`, `-3`… Renames are reported |
| `name` | `display_name`, trimmed to 256 bytes, the username when empty |
| `services.password.bcrypt` | `users.legacy_password`: the first sign-in checks it (bcrypt of the SHA-256 hex of the password, Meteor's scheme), then stores the native Argon2 hash and drops it |
| No password (SSO, LDAP) | No way in: reported, the operator issues a recovery code |
| 2FA, sessions, push tokens | Not imported (RFC 0001): the user signs in again and re-enrols |
| `roles: admin` | `admin` |
| `active: false`, bots, `rocket.cat` | Disabled accounts, kept as message authors |
| Avatar (GridFS `rocketchat_avatars`) | Re-encoded like an uploaded avatar |
| Custom emoji (GridFS `custom_emoji`) | `custom_emojis::put`; names outside the native format are reported |
| Room `c` / `p` | `public` / `private`; archived → read only; topic, description and announcement cut to their limits (reported) |
| Room `d`, two people | `direct` |
| Room `d`, more people | `private`, named after its members (reported) |
| Room `d` with `rocket.cat`, or one person | Skipped (reported) |
| Room `l` (livechat), `v`, encrypted rooms | Skipped with their messages and files (reported) |
| Discussion (`prid`) | A room of its type, without the link to its parent (reported) |
| Subscription | Member: `owner` / `moderator` / `member` (`leader` → `member`). A room without owner gets its creator, else its first admin, else its first member |
| Subscription `f`, `ls` | Favorite; read up to the last message at or before `ls` |
| Message `msg` | `text` (32 KiB at most, reported when cut). `md` is not read: the server renders `text` |
| Quote permalink prefix `[ ](…?msg=ID)` | `quote_references` when the target was imported, else the text stays |
| `tmid` | `reply_to` when the root is an imported, non-system top-level message, else top level (reported) |
| `editedAt` | `edited_at` |
| `pinned`, `starred` | `pinned`, `message_stars` |
| `reactions` | Canonical emoji or an imported custom emoji; others reported |
| Mentions | Recomputed from the text, as a send does |
| `file` / `files` | A completed upload and its descriptor; bytes from GridFS (`rocketchat_uploads`) or `--files-dir` (FileSystem). Other stores (S3, Google, WebDAV) are reported |
| Other attachments (bot cards, link quotes) | Dropped (counted) |
| System messages | Joined, left, added, removed, topic, description, announcement, renamed, read only, privacy and role changes map to their native kind; others are skipped (counted by type) |
| Deleted messages | Nothing: Rocket.Chat erases them |

## Not imported yet

- **Encrypted rooms** (`encrypted: true`, `t: 'e2e'` messages). Their history needs the
  server to keep Rocket.Chat ciphertext and per-member room keys, and the apps to read
  them on a RocketVibe account. Reported, room by room.
- **Thread read state** (`tunread`): the native read position covers a room's replies
  as a whole.
- **`@here`**: its recipients depended on presence at send time; it counts as none.

## Sources

- apps/server/src/import/
- apps/server/migrations/0049_import.sql
- apps/server/src/auth.rs
- scripts/seed-import.mjs
- docs/rfcs/0001-rocketvibe-rust-server.md
