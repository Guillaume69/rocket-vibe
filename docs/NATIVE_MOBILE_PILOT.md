# Native RocketVibe in the existing mobile app

Branch: `feature/rocketvibe-server`. The sign-in flow recognizes Rocket.Chat or
RocketVibe. Both providers use the same home and room screens, the same message
list, the same composer and the existing settings. The former `/native` route
redirects to home; it is no longer a separate messaging client.

Sessions of both kinds coexist through the existing server selector. Kind,
identity and generation are persisted with the token in the Keystore / Keychain.
Older sessions without a kind stay Rocket.Chat.

## Try it

Accounts with an explicitly installed email factor can request their code from
the existing sign-in form and confirm their identity in the settings. « Reprendre
l’envoi » reads the initial delivery or repeats the same interrupted command;
« Renvoyer le code » is a new explicit request, bounded by the server, with the
same code and the same expiry. The code the user types stays transient. Candidates
are kept in the private SecureStore entries of the challenges, with their other
resumption metadata. Enrolling the factor from the settings remains to be wired;
verifying an address does not activate it.

1. Start the [native server](../apps/server/README.md) and create its accounts with
   `create-user` and `RV_USER_PASSWORD`.
2. Install the mobile app by following its [README](../apps/mobile/README.md).
3. In debug with an ADB device: `adb reverse tcp:3400 tcp:3400`.
4. Enter `http://127.0.0.1:3400`, the username and the password in the usual form.
   A release build requires HTTPS.
5. Existing rooms appear in the usual home screen. New conversation searches the
   native directory and opens a DM. Creating / inviting in a room is for now done
   through the GTK client or the server API.
6. Send in a room, cut the network, send again, then reconnect. The send keeps its
   identifier and the draft is kept per room.

The fresh server has no default account. The Android build requirements, including
`google-services.json`, remain those of the current app; native RocketVibe does not
use Firebase for notifications yet.

## Provider and data

`SynchroProvider` selects the account's provider. Rocket.Chat keeps its DDP
transport and its engines. RocketVibe uses `NativeChat` / `NativeStore`: no
Rocket.Chat DDP initialization, REST presence, E2EE, upload or push leaves on this
branch. The compatibility REST client blocks these endpoints locally and does not
produce a Rocket.Chat avatar URL with the native token.

The engine writes into the SQLite tables that the current screens project.
Snapshot, journal, cursor, echo and outbox are atomic. The shared message query
uses the native decimal positions, even beyond `2^53`, while the displayed dates
remain real. Pagination uses the position and does not depend on timestamp
progression.

Access removals purge room, messages, drafts and outbox before the send is retried.
Another generation is purged before the UI reads the shared tables. Batches,
histories and drafts of an old generation cannot repopulate the new one. Sockets
are suspended in the background and stopped on switch.

The existing components render Markdown, selection, dates and send state. Copying /
sharing text stays local. Features absent from the native server are disabled:
threads, reactions, favorites, unreads, profiles, files / voice messages, message
search, presence, push, E2EE and calls. Rocket.Chat features stay available on a
Rocket.Chat account. The existing actions sheet offers editing and deletion
according to native rights; commands and revisions persist before the HTTP
departure. The text of a refused edit can be recovered by reopening the editor.

## Verification and limits

Renewal is wired to SecureStore: a durable intent before HTTP, resumption by the
successor after a lost response, and serialization of writes per server.
Publishing the new token replaces the active provider while keeping the account's
cache, drafts and outbox. The runner renews at connection time and checks long
connections daily. Callbacks of an old, stopped provider cannot publish a late
renewal. The portable tests and the PostgreSQL bench prove the protocol and the
runner; the Keystore and the native Android lifecycle still require a device.

The shared settings also host native devices: private list, name, activity /
expiry and revocation of another device after a recent sign-in. The actions use
the active runner; a confirmation held across a switch cannot act on the next
provider. The current device keeps the existing sign-out flow. The form is typed,
linted and exported in the Android bundle; the Android rendering and confirmations
remain to be qualified.

From `apps/mobile`:

```sh
npm run typecheck
npm run lint
npm test
npx expo export --platform android --output-dir ../../artifacts/native-mobile-android
```

The provider tests exercise SQLite, outbox / retry, generation, the real query of
the shared screen and its pagination. The [desktop bench](NATIVE_DESKTOP_PILOT.md)
exercises the real mobile facade against PostgreSQL with the GTK desktop.

The export compiles JavaScript / Hermes without installing an APK. Rendering on
Android, real kills and Android / Windows exchanges remain to be exercised. The
directory is limited to 100 accounts; the materialized snapshot allows 1,000 rooms
and 64 MiB, with pages of 1 MiB and a duration of 5 minutes. The engine applies
only the whole validated view; older native servers keep the 100-room / 8 MiB
route. Cursors expire and are pruned; the engine then requests a new snapshot
while keeping the drafts and outbox of the rooms that are still authorized. This
path is tested with real expiry in PostgreSQL and the mobile SQLite engine. `429`
refusals suspend login / ticket / snapshot requests until the retry delay.
The bench `compose.native-email-settings-pilot.yml`, layered over the native,
security and OTP overlays in a fresh project `rocketvibe-email-settings-mobile`,
runs `email-settings-mobile` then `email-settings-check`. Three Node processes
recreate the provider, the SQLite projection and a portable private vault on disk.
Activation / removal receipts survive lost responses; the full recovery-code proof
is resumed without consuming a second code. The verified contact is kept on
removal. The private volume must be deleted with `down -v` after the bench; this
proof does not qualify an installed SecureStore. Cache retention remains to be
defined. J1 stays open in the [tracker](NATIVE_SERVER_EXECUTION.md).
