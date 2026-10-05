# Encrypted files

Files of private (MLS) rooms on the RocketVibe server are encrypted on the device
before upload, under a key that travels only inside the encrypted message
([E2EE_MESSAGES.md](E2EE_MESSAGES.md)). The server stores and serves an opaque object:
it never learns the name, type, size of the content or the key. The ordinary upload
routes ([FILES.md](FILES.md)) carry the object; the private message confirms it. No
production capability is enabled by this document.

## Object format (`rv-file-v1`)

A fresh random 32-byte key per file. The plaintext is cut into chunks of 65,536
bytes; the last chunk may be shorter, and an empty file is one empty chunk, so a file
of `n` bytes has `c = max(1, ceil(n / 65536))` chunks. The object is:

| Bytes | Content |
|---|---|
| 4 | `RVF1` |
| 19 | random nonce prefix |
| then, per chunk `i` (from 0) | XChaCha20-Poly1305 of the chunk under the key, nonce `prefix ‖ BE32(i) ‖ last` (`last` = 1 for chunk `c-1`, else 0), additional data `rocketvibe-file-v1`, tag of 16 bytes |

Its size is exactly `23 + n + 16c`, and at most 100 MiB like any object, so a
plaintext is at most 104,831,977 bytes. A reader decrypts the chunks in order and
rejects a missing or extra chunk, a misplaced `last` flag, a size or a SHA-256 of the
plaintext that differs from the descriptor. It writes to a private partial file and
publishes it only once everything matched.

## Descriptor (inside the encrypted message)

`SendMessage.files` lists up to 8 `EncryptedFile`:

| Field | Content |
|---|---|
| `id` | the upload id, also the server's file id |
| `key` | the 32-byte key, base64url without padding |
| `filename` | the original name, 1 to 255 characters, no control character, `/` or `\` |
| `media_type` | the declared type, at most 127 printable ASCII characters |
| `bytes` | plaintext size, decimal |
| `sha256` | plaintext SHA-256, lowercase hex |

A chat message may carry files and no text. Edits, deletions and reactions carry no
file. The routing header lists the same ids in the same order in `files`, so the
server can link the objects to the message; a reader rejects a document whose
descriptors and header ids differ.

## Server

- `PrepareUpload` with `encrypted: true` is accepted only in a room with an MLS group,
  with `media_type` `application/octet-stream` and no `filename`; the declared size and
  SHA-256 are those of the object. Cleartext preparations stay refused there
  (`crypto_required`), and encrypted ones are refused in ordinary rooms.
- The bytes go through `PUT /uploads/{id}/bytes` like any object; no type sniffing.
- An encrypted upload is never completed by `POST /uploads/{id}/complete`. The private
  message submission completes it: for each id of `header.files`, the upload must be
  the sender's, of the same room and membership, `ready` and unexpired; it becomes
  `completed`, linked to the private message, in the same transaction. Otherwise the
  submission is refused (`invalid_encrypted_file`). An exact retry returns the same
  receipt.
- `GET /files/{id}` serves a completed encrypted object to current members of the
  room, as `application/octet-stream`, with the same Range, lease and frame checks as
  any file. A private deletion cannot cut the access: the server does not know of it,
  and members already hold the key anyway.

## Clients

Sending seals the file to a private temporary object, prepares and uploads it, then
sends the private message with its descriptor; a failure before the message abandons
the reservation. Receiving downloads the object to a private partial file, opens it
with the descriptor, and keeps the plaintext in the app's private cache like other
protected files. The key, name and type never leave the encrypted payload and the
protected storage.
