# Room and message links (P21)

The existing GTK, SwiftUI and Android clients use the same contract:

```text
rocketvibe://room/<rid>?host=<full URL>&instanceId=<instance>&dataEpoch=<epoch>&msg=<message>&tmid=<root>
```

`msg` and `tmid` are optional. `host` keeps the protocol, port and path of the
reverse proxy. The host name and the default HTTP port are normalized; distinct
paths are never merged. A URL with credentials, query or
fragment is not a service address. Another canonical URL requires an explicit
reconnection, even if it designates the same physical server.

A native permalink identifies instance and epoch; it contains neither bearer,
content, nor the author's account. Another authorized member can open it with their
own account. The server's access control remains necessary.

A notification additionally carries the recipient via `userId` or the existing
JSON `nativeScope` `{instanceId,dataEpoch,userId}`. Both forms, if present,
must match. A partial identity, a repeated parameter, an invalid root
or a malformed scope causes a refusal, with no fallback to the active
session. Identifiers: 1 to 128 ASCII alphanumeric characters, `_` or `-`;
URL at most 8 KiB. No link supplies a token to the transport.

Old links `rocketvibe://salon/…` and `rocketvibe://room/…` without native
identity remain Rocket.Chat (`salon/` still parses; the apps now generate
`room/`). Their explicit service also follows the comparison
of the full URL. Without a service, only a Rocket.Chat account fits. Links
received by the system are marked in Expo Router so that they are not
confused with the internal routes to a room of the active account.

## Account and resolution

The desktop keeps the account already chosen if it matches. Otherwise, a single registered
session must match the service, the provider and the
scope exactly. Several compatible accounts require the existing selector:
never the first of the list. The link waits for the rooms and the connection;
a late result of an old link or account opens nothing.

Android keeps the "other server" screen and its explicit gesture. The
SecureStore session must match **before** changing the resume pointer. The
Kotlin plugin now adds message and root to the notification link.

The native providers reread the message with the authenticated transport,
verify its room and its deletion, then take its real thread root.
A supplied root that contradicts the message is refused. Discovery,
the origin membership and the projection generation are verified around
the read, before the SQLite ingestion. No journal cursor is acknowledged
by this targeted read. A replaced membership, a restoration or a
closed session cancel the result.

The existing menus add "Copy message link" for confirmed native
messages. Shared text and files keep their usual path.
A native jump counts decimal positions, without floats or timestamps; replies
open the existing thread and reveal the message there.

## Qualification and remaining work

Rust core tests: parsing / accounts, real HTTP protocol, room
change, deletion, forged root, re-membership and restoration during the
fetch; SQLite orders positions beyond `2^53` despite inverted dates.
Mobile tests: same barriers with the real SQLite projection, runner
stop, receiver URLs and system routing. The Swift bindings and models
compile; their tests call the Rust parser via UniFFI.

The cold click on a **permalink** is wired; the installed journeys of the
three platforms remain to be exercised. The registry of **desktop notification
actions** is now persisted in the account's SQLite; account selection,
waiting for connection, private validation and idempotent reply go through the
existing models. GNOME registers the action at startup, Windows uses the app
protocol for the click, SwiftUI waits for the recipient account. The Windows
reply has its native COM activator and a test between real processes.
Replies are kept before the network in the outbox, with captured
destination, private validation and proof of a send whose confirmation is lost.
Clicks received offline also keep their destination and membership before
the account resumes, with private validation after restart and acknowledgement bound
to the last click. An explicit navigation cancels the old wait.
The XDG Notification v2 portal also wires the cold reply to the exported
GTK action, when the service announces the capability and GLib ≥ 2.86. The
installed Windows journey with the process stopped and the installed portals / Plasma remain
to be qualified; the old freedesktop reply requires an active process: [details](PUSH.md).
Old Rocket.Chat HTTP permalinks that are imported
await the correspondence table and the J5 resolver.
P21 and J3 are not declared complete.
