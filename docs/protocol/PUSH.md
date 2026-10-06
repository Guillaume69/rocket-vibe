# Native notifications (P17 / J3)

RocketVibe reuses the existing client's Android FCM service, `MessagingStyle`
notifications, room links and `RemoteInput`. The Rocket.Chat provider keeps its
`push.token` / `push.get` / `chat.sendMessage` flow. RocketVibe Android push is
advertised on the client side only when its native receiver is wired up; native iOS
remains outside the scope of this RFC.

## Operator configuration

`RV_FCM_CONFIG_FILE` (or `--fcm-config-file`) names the Firebase service account JSON,
kept out of Git and readable only by the server process.
Its `project_id` names the Firebase project used to build the Android app.
The operator enables the Firebase Cloud Messaging API and authorises this account to
send messages. The server uses OAuth with the scope
`https://www.googleapis.com/auth/firebase.messaging`, with token renewal handled by
`gcp_auth`, then Google's HTTP v1 API. No OAuth token goes to the clients.
Without configuration, discovery advertises `push:false` and the worker stays idle.
The registry and the rights remain accessible so that a registration can be removed.

In a container, mount the file read-only and set
`RV_FCM_CONFIG_FILE=/run/secrets/firebase-service-account.json`; this file must
never be copied into the image. The dummy Android build configuration used locally
does not authorise any real Firebase send.

Primary references: [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api),
[data messages](https://firebase.google.com/docs/cloud-messaging/customize-messages/set-message-type),
[FCM error codes](https://firebase.google.com/docs/cloud-messaging/error-codes).

## API and identity

- `PUT /api/v1/me/push`, native bearer, strict body `{token}`: registers the Android
  FCM token on the family of the current session. Answers
  `{device_id,instance_id,data_epoch}`. The client confirms discovery, then
  keeps `nativePushDeviceId` in the SecureStore session that is still active.
- `DELETE /api/v1/me/push`: idempotent unregistration of this family, `204`.
  Logout, device revocation and effective expiry of the family also remove
  its registration and its notifications. Bearer rotation keeps it.
- `GET /api/v1/push/notifications/{id}`: private read exclusively by the recipient
  family. Returns `{notification_id,device_id,instance_id,data_epoch,
  room,message}` with the normal read rules for quotes / files.
  Another device of the same user cannot read this notification.

Personal reads and the HTTP / WebSocket batches of `Message` add `personal_mention`, an
optional boolean computed from the recipients captured at send time. The shared journal
never keeps it. An edit adds no recipient; desktop readers therefore do not
infer a mention from a changed username or `@here`.

FCM receives only `product`, `instanceId`, `dataEpoch`, `userId`, `deviceId`,
`notificationId`, `rid`, `messageId`, and optionally `tmid`. No `notification`
block, content, password, bearer or server URL is sent.
Android picks the URL from the local session that matches all these
identities. It refuses HTTP redirects; the release build requires HTTPS, the debug build
allows HTTP for the local bench. Discovery is verified before each read
or reply. An already persisted successor of an interrupted rotation can be
used without starting a second rotation from the receiver.

A ringing direct call sends the callee's devices a data push `type:
voice_ring` (then `voice_ring_end` when it resolves) with `product`,
`instanceId`, `dataEpoch`, `userId`, `deviceId`, `ringId` and `rid`, high
priority, TTL 30 s, from a separate fenced queue (`voice_pushes`): three quick
attempts, retired as soon as the ring is no longer ringing. An online callee
gets it too; a callee whose chosen status is busy gets none. The app reads the
ring with `GET /api/v1/voice/rings/{id}` ([VOICE.md](VOICE.md)).

## Queue and delivery

Migration `0036_push_notifications.sql` adds the registry, the token generation
and the tasks. Sending a message, including a file confirmation
or a thread reply, captures its recipients in **the same transaction**.
A replayed send does not create a second notification. Edits, previews and system
activities do not create a new push event.

Eligibility: other author, active account, current membership, push enabled, chosen
status other than "busy", no active "online / busy" lease. The
"mentions only" setting keeps DMs and the mentions captured at send time.
Room and thread reads use the original position of the message.
`@here` keeps the recipients frozen by the mention capture.

Workers take at most four tasks with leases of 60 seconds,
`SKIP LOCKED` and a distinct lease identifier. They recheck eligibility,
the epoch, the token generation, account activation and the duration of the membership.
OAuth and HTTP happen after the commit, with no SQL transaction open.
Six attempts at most, exponential delay with jitter, `Retry-After` and a maximum
duration of 24 hours. Expired tasks are purged by maintenance.
An explicit FCM `UNREGISTERED` error removes only the generation concerned;
a generic `INVALID_ARGUMENT` does not delete a potentially valid token.
Late results from a lease or a replaced token do not modify the successor.

The read response holds locks on rights, session, notification,
generation, message and read state until the HTTP body is submitted.
A revocation, re-join, deletion or new revision invalidates a prepared
response. A push that has already left contains only identifiers.

## Existing Android

The service displays generic text and entrusts the private fetch to WorkManager.
`onNewToken` keeps the latest FCM token in private storage, then schedules
its registration for the native families already registered, even without a JS
runtime. Tasks are serialised per family and re-read the current token and the
SecureStore session; no bearer is persisted in WorkManager.
Catch-up has at most eight attempts and requires the network. Permanent refusals and
a changed server identity remove the generic notification.
The full notification keeps the current conversation component, grouped
by instance / epoch / account / room. A durable marker deduplicates
deliveries, including after a server crash between the FCM send and the acknowledgement.
Unread counts at zero and the removal of a room clear the conversation notification.
The link keeps the server, its proxy path, the message / thread and the account identity; another
account or a restored epoch cannot open the room in its place.

The "Reply" action saves an operation identifier in WorkManager, together with
the exact entry and the scope, before acknowledging. Each attempt uses
`POST /api/v1/rooms/{rid}/messages` with the same `operation_id` and the same thread
root, with no bearer in the queue. The text is limited to 4 KiB in this action
to respect Android's 10 KiB `Data` limit; an overflow shows the failure in
the notification. The send screens keep their usual limit.
The family, the epoch and the user are rechecked on every resumption.

## Existing desktop

Only batches received on the connected WebSocket produce candidates, inside
the SQLite transaction that applies their cursor. Snapshot, HTTP catch-up,
already loaded history, current author, edits, deletions and system
activities stay silent. A creation requires `position == revision` and an
already known membership. After projection, room / thread reads, deletion and
the duration of the membership are rechecked before any alert.

Desktop preferences are loaded at connection, refreshed by the local
settings and re-read every 60 seconds. An initial preference that is unavailable
keeps notifications silent; it does not cut off messaging.
`all`, `nothing` and DMs / mentions reuse the existing client's rule.
A room already visible in the active window produces no notification.

GTK reuses D-Bus for the KDE inline reply, GApplication for native notifications
without inline reply, and Windows toasts; SwiftUI keeps
`UNUserNotificationCenter`. OS references carry a key computed from
server / account / instance / epoch / room, with no credential. A click or a
reply verifies the original membership and the presence of the message. The reply takes
the usual persistent send path, with the thread root if needed.
Reads, removal from the room and a disabled preference remove the notifications.

Action references are capped at 256 and persisted before being handed to the OS
in the account's SQLite: message, room, root, membership, position and eligibility.
The registry duplicates no text, name, credential or notification body.
A preference still unknown at startup does not erase it. A new epoch
purges it with the projection; a replaced membership invalidates its callbacks.

The GTK / SwiftUI models find the single account that matches the OS key.
A click waits for connection and rooms, then re-reads the message and root over private HTTP,
with guards on account, request, generation and late responses.

A reply enters the outbox before the account resumes or any HTTP call: text,
send ID, receipt by notification / text fingerprint and captured destination
are recorded together. Cold captures use a SQLite `IMMEDIATE` transaction
to serialise independent connections; two concurrent or replayed callbacks
find the same ID. The text uses the normal storage of pending
messages, with no new copy and no bearer. At most 256 unresolved replies
are accepted; overflow is refused, with no silent eviction.

Ordinary replay excludes these replies, including after "Retry". The engine
catches up the journal, verifies the original epoch and membership, then re-reads the message
and the real root with the current credentials before sending. A root not yet
in the cache does not prevent offline capture. A permanent refusal keeps the
text in the existing failed message; retry / abandon keep their flow.
A read or a preference removes the toast without losing a reply already captured;
removal / re-join, logout with purge and a new epoch erase its data
along with the rest of the projection.

Before the HTTP submission, an attempt marker is persisted. After the
confirmation is lost, the private read of the send ID can confirm the message of the same
account / room / thread without replying again to a notification deleted in the meantime.
The projection and membership guards remain applied around this fetch. GTK and SwiftUI delegate this resumption to the same core and to the current screens.

GNOME has the `(key, message)` action from the GApplication startup. Linux
installs also create the D-Bus service of the same ID and the desktop entry
advertises `DBusActivatable` / `X-GNOME-UsesNotifications`, following the
[GNotification contract](https://docs.gtk.org/gio/class.Notification.html).
The Windows click
uses `rocketvibe://notification?key=…&msg=…`, with no text or bearer,
through the protocol already registered by the installer; the parser refuses duplicates,
malformed identifiers and unexpected parameters. SwiftUI handles the
`UNUserNotificationCenter` callback in the model, even before the account resumes.
The Windows inline reply now goes through a local COM server
`INotificationActivationCallback`, registered per user with the same stable CLSID
in the installer, the shortcuts and the process. Windows launches the binary
with `-ToastActivated`; GTK strips this switch before parsing, then the callback
passes arguments and text to its existing handler. An already running process
uses the same callback, with no second WinRT handler that would double the send.
The AUMID, the shape of the arguments and the bounded UTF-16 inputs are verified;
the private account / membership / epoch validation stays in the native core.
Registration follows the [Microsoft reference COM server](https://github.com/CommunityToolkit/WindowsCommunityToolkit/blob/main/Microsoft.Toolkit.Uwp.Notifications/Toasts/Compat/ToastNotificationManagerCompat.cs)
and the [callback ABI](https://learn.microsoft.com/en-us/windows/win32/api/notificationactivationcallback/nf-notificationactivationcallback-inotificationactivationcallback-activate);
the shortcuts use the [CLSID provided by Inno Setup](https://jrsoftware.org/ishelp/topic_iconssection.htm).
The legacy KDE / freedesktop signal `NotificationReplied` is addressed to the
process that sent `Notify`; once that process has exited, its old D-Bus address
cannot be recovered. Cold delivery now goes through the
[XDG Notification v2 portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Notification.html)
when `SupportedOptions.button-purpose` advertises `im.reply-with-text`, with
GLib ≥ 2.86 for the marshalling of several arguments. The exported actions
`app.open-message` and `app.reply-native-notification` are registered at
startup. The portal keeps the `(key, message)` target and passes the typed text
as the second argument of `org.freedesktop.Application.ActivateAction`; GTK
receives the tuple `((ss)s)` and follows the same durable capture / private validation.
No reply text goes through the URL or the command line.

The capability is probed before choosing this path, only for the native
provider. Environments that do not advertise it keep their existing notifications;
freedesktop inline reply there still requires a running process.
The [Plasma backend consulted](https://github.com/KDE/plasma-workspace/blob/a82e8a200a37328ff6cd5cbac68ebd609fed306a/libnotificationmanager/portal_p.cpp)
exposes a v1 portal: its presence is therefore not enough to enable this v2 flow.
An application installed on a system that advertises v2 remains to be qualified.
Portal displays / removals are serialised per scope: a removal
during an `AddNotification` ends with `RemoveNotification`, a replacement
ends with the most recent message. Removing a notification does not activate an absent
portal. The settings diagnostic shows the selected backend.
A click navigation received offline is now kept in
`notification-navigation.sqlite`, in the desktop configuration shared by GTK
and SwiftUI. Only one explicit destination is kept, with no text, author or
bearer: scope key, message / room / root, original membership and position.
A reservation is written before waiting for the keyring; a late capture
can modify only itself. On restart, the exact account is selected
before the default account. Removal of the toast or a bounded snapshot window
does not lose a click already captured. The message and the root are re-read privately,
with the membership / epoch / projection guards; only temporary errors
keep the destination for resumption. Opening in the existing screens
acknowledges the exact ID, without erasing a more recent click. A new link, an
explicit change of room / thread / account or logout cancels the pending navigation.
The installed system flows remain to be qualified on Linux,
Windows and macOS; P21 stays open for these paths and for the old imported links.
Native permalinks and their startup routing use the [P21 contract](ROOM_LINKS.md).

## Evidence and qualification still open

PostgreSQL / HTTP tests: atomic capture, replay, concurrency, lease recovery,
last attempt in flight, backoff, bearer / FCM rotation, token purge,
logout, mentions / DMs / presence / preferences, thread reads, removal then
re-join, restored epoch, wrong family, deletion and reply locks.
A simulated FCM HTTP server exercises the payloads and the responses, with real HTTP calls.
TypeScript tests: pinned registration, refusal of late or foreign receipts,
private API, navigation and notification identifiers per account.

The pass through real Firebase and the flow on a **physical Android with the app stopped**
remain open: reception, WorkManager wake-up, language, tap, reply after loss
of confirmation, permission refusal and revocation. A build or a simulated
HTTP bench does not close this criterion. The desktop benches verify creations on
a real WebSocket, replay, the transaction / rollback, reads, preferences,
thread replies, deletion and re-join. An on-disk database is
closed then reopened: authenticated HTTP resolution, account / epoch, root,
identical reply and restore purge are exercised. A real GTK binary is
started on demand by D-Bus in a throwaway XDG, with description and dispatch
of the action before normal activation; it uses a foreign scope with no
account, and therefore proves neither a click on a real toast nor private navigation.
They do not prove the
interactions with installed system notifications. P17 / J3 are not
declared complete.

Offline replies are exercised on a closed then reopened on-disk SQLite and
real HTTP exchanges: zero requests at capture, root absent from the cache,
two concurrent connections, removal from the OS registry after capture, guarded retry,
deleted target / root, replaced membership, restored epoch and HTTP reply
lost after commit. The private confirmation at restart produces a single POST,
even if the original target was deleted. The tests also verify the purge
of removed intents and the retention of the text of permanent refusals.
Offline clicks also go through on-disk SQLite and real HTTP: capture with no
network, root outside the cache, OS registry removed, restart after a 503, refusal of
deleted targets / roots, replaced membership and restored epoch. Reservation,
slow capture, cancellation and late acknowledgement cannot overwrite a new
click; malformed / oversized metadata is refused.
The Swift models compile with their regenerated bindings; installed OS
notifications remain a qualification distinct from these tests.

The Windows bridge passes nine tests, including a COM callback actually invoked from
a second process with the typed text; the bench class is temporary and
writes no user registry entry. The helper is executed by this test, not
silently skipped. Foreign / repeated / malformed inputs are
refused. The seven portable tests and Windows / Linux Clippy pass. This bench
proves COM dispatch across processes, but not yet launch by the notification
center of an installed, stopped application.

The v2 portal has two capability / payload tests and a real throwaway D-Bus
server that delays `AddNotification` to exercise replacement and in-flight
removal. This test is marked conditional on a session bus and run explicitly
by the qualification script, with no false success at zero tests. The same script
closes the first GTK, verifies that the D-Bus name has disappeared, then reactivates a
second real process through `ActivateAction` with a Unicode target and reply; malformed
parameters are refused. This foreign target has no credentials:
it proves the ABI and the startup, not a private send nor a real Plasma portal.
