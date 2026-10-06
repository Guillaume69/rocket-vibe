# Native RocketVibe in the existing desktop client

Branch: `feature/rocketvibe-server`. The sign-in form recognizes Rocket.Chat or
RocketVibe before authentication. Both providers feed the same GTK `ChatPage`: room
list, headers, Markdown, message list, composer and navigation. There is no longer
a parallel native chat page.

Accounts of both kinds coexist in secure storage. The account tile opens the usual
settings, with account adding and switching. Older accounts without a kind stay
Rocket.Chat. A switch closes the previous transport; late events are not applied
to the newly displayed account.

## Usage

Start the [local server](../apps/server/README.md) and create its accounts through
the CLI. Build the desktop app in Fedora with `apps/desktop/scripts/build.sh`.
Signing in to `http://127.0.0.1:3400` opens the same interface as for a Rocket.Chat
server.

The new conversation button allows a DM or the creation of a private/public room.
A room header opens the invitation by username; the server reserves this right for
the owner. The existing search lets users discover and join public rooms.

Text, history, the draft and offline sends are available. Retry / abandon use the
menu of a refused send. The unsupported native features (files, voice messages,
threads, reactions, unreads, search, push, E2EE and calls) stay disabled.
Rocket.Chat keeps its current features. The existing menus and editors also allow
editing and deletion, with server rights, a revision captured on opening and a
SQLite intent. A refused edit keeps its text for the next time the editor is
opened.

## Cache and resumption

- Tokens in the existing keyring; kind and `instance_id` / `data_epoch` persisted.
- Separate native cache `native-<sha256 full URL + user>.sqlite`.
- Projection, cursor and echo acknowledgement in a fallible SQLite transaction.
- Message order by exact decimal position; display of real dates.
- Journal replay and removal of accesses before the outbox is emitted.
- Authoritative snapshot, purge of absent rooms and rejection of late histories.
- Identity re-verified after a snapshot is read; another generation does not replay
  the old intents.
- Frames consumed serially, bounded GTK invalidations, 45-second watchdog.

`NativeSession.shutdown()` is called on account switch and on close. Sign-out
revokes the token online, then removes the local account.

## SwiftUI / UniFFI

`Client.native_login` and `native_resume` expose the engine through `NativeChat`:
status, messages, rooms, drafts, history, outbox, DMs and room management. The
legacy API refuses to send native credentials to Rocket.Chat routes.
`ChatProvider` connects both transports to the `AppModel` and `RoomModel` models:
the SwiftUI views for sign-in, rooms, messages, people search, DMs, composer and
accounts stay shared. Markdown rendering, author groups and day separators use the
same UniFFI objects as Rocket.Chat, keeping the order of the native journal. Native
avatars remain initials. The features absent from the server are disabled in these
views.

The Swift bench uses the real PostgreSQL server and an unlocked Secret Service,
with a throwaway account. After generation and compilation by
`apps/desktop/macos/scripts/check-linux.sh`, start only the services
`postgres bootstrap server` of the pilot Compose file, then run
`docker compose -f docker/compose.native-pilot.yml run --rm --no-deps swift`.
It exercises the Swift models and the real Rust bindings; the complete AppKit /
SwiftUI display is built and launched separately by the macOS CI.

## Reproducible bench

From the root, in Bash with Docker:

```sh
docker build -t rocket-vibe-rs-build apps/desktop/docker
docker build -t rocketvibe-native-server -f apps/server/Dockerfile .
docker build -t rocketvibe-native-check -f apps/server/docker/Dockerfile.check .
docker run --rm -v "$PWD:/workspace" -v rv-cargo:/cargo \
  -w /workspace/apps/desktop rocket-vibe-rs-build bash -ec '
    cargo fmt --all -- --check
    cargo clippy --locked --workspace --all-targets -- -D warnings
    cargo test --locked --workspace
    cargo build --locked -p rv-core --example native-smoke
    cargo build --locked -p rocket-vibe-gtk
  '
docker compose -f docker/compose.native-pilot.yml up -d postgres bootstrap server mobile factor-seed factor-proxy
docker compose -f docker/compose.native-pilot.yml run --rm --no-deps desktop
docker compose -f docker/compose.native-pilot.yml run --rm --no-deps factor-check
docker compose -f docker/compose.native-pilot.yml run --rm --no-deps session-check
docker compose -f docker/compose.native-pilot.yml logs --no-color
docker compose -f docker/compose.native-pilot.yml down -v
```

Run `desktop` immediately after `mobile`: the peer has a bounded wait.
The throwaway bench uses PostgreSQL in tmpfs, with no host port and no development
volume. It uses the real mobile facade, its SQLite migrations and the real GTK
binary. It verifies exchange, resumption after the file is reopened, draft, DM
uniqueness, creation / invitation, private removal, revocation and the displayed
widgets, at full width and at 435 pixels. Screenshots: `artifacts/native-desktop*.png`.

GTK and the Swift models use a real Secret Service in this Linux bench.
The throwaway SQL policy shortens the first token to one day, which triggers its
renewal in the existing clients. `session-check` requires a rotation for both
accounts, even if the sessions were signed out afterwards; its counters contain no
secret. The mobile peer exercises the real SQLite facade and portable resumption,
with an in-memory backup specific to the bench. The qualification of Android
SecureStore, the Windows / macOS keyring and tests on devices remain open in the
[tracker](NATIVE_SERVER_EXECUTION.md).

The GTK path also opens the settings and then the device list, expands the current
device and applies a name through the real Adwaita field. It verifies the server
value and that the field fits in the window. The Swift models rename the current
device, revoke a second session and verify its HTTP 401 refusal; the controls held
over from the previous account stay inactive.

The throwaway bootstrap issues invitations in a private volume, mounted read-only
by the clients. GTK uses the invitation field of its sign-in page, creates an
account, clears the form secrets, then resumes that account from the Secret Service
after a restart. The Swift model exercises the same path and the logout. The mobile
peer registers an account, resumes the response, then connects its SQLite provider.
The invitation volume is deleted with `down -v`; no code reaches the logs or the
artifacts. These tests do not replace the qualification of physical devices.

The bench also issues operator codes tied to three recovery accounts. GTK goes
through its « Mot de passe oublié » variant, then resumes the new session after a
restart. Swift additionally verifies the HTTP 401 rejection of the old bearer. The
mobile peer keeps the UID and a conversation actually written before the reset,
re-verifies its content in SQLite and replays the confirmation without revoking its
recent session. Invitation and recovery codes share the private throwaway volume,
never the artifacts.

The bootstrap also generates a private random operator key for the factors,
readable only by the server, then provisions two test accounts with TOTP and ten
recovery codes. A private proxy discards each successful validation response. GTK
uses its form and the Secret Service: wrong recovery code refused, account still
inactive after a lost response, candidate recovered without a new code, session
written, then the proof erased. A restart under a new D-Bus / keyring daemon
resumes that account. `factor-check` requires a single device family and exactly
one recovery code consumed for `gtk-factor`. The secrets of this bench stay in the
private volume deleted by `down -v`; they are neither logged nor added to the
screenshots. This Linux path does not qualify the macOS / Windows keyring or a
physical Android device.

The `swift` service receives a distinct account and the same lost-response proxy.
Its models keep the previous account during the challenge; a private proof stays
absent from the session index. The model and the client are recreated before
confirmation, a request is abandoned mid-flight, then the session is recovered
without a code and resumed from the real keyring. This is a recreation of the
models, not a killed macOS process. A `swift-replay` account also covers the replay
of an opaque handle after the forced rotation of its first bearer.

The Swift job starts `factor-seed` / `factor-proxy`, runs `swift`, then verifies
its own counters with:

```sh
docker compose -f docker/compose.native-pilot.yml run --rm --no-deps \
  -e 'PGOPTIONS=-c rocketvibe.pilot_factor_user=swift-factor' factor-check
```

## Security settings and email address

The overlay `docker/compose.native-security-pilot.yml` verifies the existing
settings in two GTK or Swift processes, with the real Linux Secret Service.
It adds a local TLS SMTP relay in the server's network namespace; its localhost
certificate is a synthetic fixture that is explicitly public. The private SMTP
configuration and the received codes stay in the throwaway invitation volume, with
no host port and no external address. The proxy loses one successful response per
endpoint. The pending address survives the restart, its confirmation resumes
without a new code and a refused address can be closed without erasing the contact.
The SQL verification requires one family, one proof, one admitted and confirmed
mail, then the erasure of the encrypted delivery payload.

After building the images and binaries above, run a fresh project:

```sh
docker compose -p rocketvibe-email-gtk-pilot -f docker/compose.native-pilot.yml \
  -f docker/compose.native-security-pilot.yml up -d factor-proxy
docker compose -p rocketvibe-email-gtk-pilot -f docker/compose.native-pilot.yml \
  -f docker/compose.native-security-pilot.yml run --rm --no-deps security-desktop
docker compose -p rocketvibe-email-gtk-pilot -f docker/compose.native-pilot.yml \
  -f docker/compose.native-security-pilot.yml run --rm --no-deps security-check
docker compose -p rocketvibe-email-gtk-pilot -f docker/compose.native-pilot.yml \
  -f docker/compose.native-security-pilot.yml down -v
```

For the Swift models, generate the bindings and tests with
`apps/desktop/macos/scripts/check-linux.sh`, then use another fresh project
with `security-swift` and `security-swift-check`. The CI runs both paths.
These Linux tests do not close the qualification of the Windows / macOS keyrings,
of an installed Android SecureStore or of the SwiftUI rendering on macOS.

## Explicit email factor enrolment

After building the images / binaries, the enrolment overlay verifies three
processes per client, with losses of the profile and proof responses. It resumes
the original ten recovery codes and keeps the contact after the last profile is
removed. A fresh project per client is mandatory: the proxy loses one response per
route.

```sh
files='-f docker/compose.native-pilot.yml -f docker/compose.native-security-pilot.yml -f docker/compose.native-email-otp-pilot.yml -f docker/compose.native-email-settings-pilot.yml'
docker compose -p rocketvibe-email-settings-gtk $files up -d factor-proxy
docker compose -p rocketvibe-email-settings-gtk $files run --rm --no-deps email-settings-desktop
docker compose -p rocketvibe-email-settings-gtk $files run --rm --no-deps email-settings-check
docker compose -p rocketvibe-email-settings-gtk $files down -v
```

For Swift, add `-f docker/compose.native-swift-email-otp-pilot.yml` before the
enrolment overlay and use the project `rocketvibe-email-settings-swift`
with `email-settings-swift`. The `email-settings-check` control receives
`-e 'PGOPTIONS=-c rocketvibe.pilot_email_settings_user=swift-email'`.
The CI runs these paths and their cleanup. The bench relay stays local.
