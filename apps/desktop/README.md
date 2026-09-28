# rocket-vibe desktop

Desktop Rocket.Chat client in Rust: GTK 4 + libadwaita on top of a UI-free
protocol core. It ports the mobile app's `lib/` (`../mobile`), whose tests are
the spec. Commands below run from `apps/desktop/`; the Rocket.Chat test server
is the repository's `docker/`, seeded by its `scripts/seed.mjs`.

## Build

Everything builds in a Fedora 44 container (cargo registry cached in the
`rv-cargo` volume), so the host needs no Rust or GTK headers:

```sh
scripts/build.sh                  # fmt check, clippy -D warnings, tests, build
PROFILE=release scripts/build.sh
```

The container ships the same GTK 4.22 and libadwaita 1.9 as a Fedora 44 host,
so the binary runs natively:

```sh
./target/debug/rocket-vibe-gtk
```

The session token lives in the Secret Service (KWallet or GNOME Keyring),
never on disk.

What the Android app does and where this one stands: `docs/PARITY.md`.

## Desktop integration

On Windows, the installer from CI (`rocket-vibe-desktop-<version>-windows-x86_64-setup.exe`,
built from `data/windows/rocket-vibe.iss`) installs for the current user, adds a Start
menu entry and registers `rocketvibe://` links. On Windows the app is not
single-instance (that goes through D-Bus), so a link opens a second window;
text goes through fontconfig, which avoids a cairo abort and keeps the bundled
fonts; warnings go to `%LOCALAPPDATA%\rocket-vibe-rs\rocket-vibe.log` when the
app has no console, the previous run's in `rocket-vibe.previous.log` beside it. On every
system a panic is appended to `crash.log` in the same cache folder, with its backtrace;
Settings, About shows the folder and opens it.

On macOS, the DMG from CI holds `rocket-vibe.app` (Apple Silicon, macOS 15 or later),
built by `scripts/package-macos.sh`: GTK, libadwaita, GStreamer and their libraries
inside, `rocketvibe://` declared. The binary itself points GTK, GStreamer and
fontconfig at the bundle (`crates/rv-gtk/src/macos.rs`): under the hardened runtime,
permissions such as the microphone belong to the signed executable. Text goes through
fontconfig, which loads the bundled fonts, and drawing through GTK's software
renderer, which draws emoji where its OpenGL renderer did not (`GSK_RENDERER=gl` to
compare). With `MACOS_SIGN_IDENTITY` the script signs with that Developer ID
(hardened runtime, `data/macos/entitlements.plist`); CI then has Apple notarize the DMG
and staples the ticket, so it opens without any prompt. Without an identity it signs
ad-hoc, and the app needs one "Open Anyway" in Privacy & Security the first time.

On Linux:

```sh
PROFILE=release scripts/build.sh
scripts/install-desktop.sh        # launcher entry, rocketvibe:// links
```

Voice messages record through GStreamer: the host needs its Opus, Ogg and
PulseAudio or PipeWire plugins (Fedora ships them with a desktop install).

## Headless smoke run

Logs in, opens a room, optionally sends a message, saves a screenshot and
quits, under Xvfb in the build image:

```sh
scripts/smoke.sh http://localhost:3000 alice alice-dev-2026 test-public /tmp/shot.png "hello"
```

## Tests

| Level | What | Command |
|---|---|---|
| Unit | Pure logic: normalisation, store SQL, diff, media URLs, avatar hash | `scripts/build.sh` |
| Integration | REST, DDP and the outbox against fake HTTP and WebSocket servers | `scripts/build.sh` |
| End-to-end | The real app, headless, against the seeded bench: sends, receives live, sees a deletion; checks the server stored the send once | `scripts/e2e.sh` |

Coverage (cargo-llvm-cov, in the build image):

```sh
scripts/coverage.sh          # unit + integration (~43% of lines: the UI is out of their reach)
scripts/coverage.sh --e2e    # plus an instrumented end-to-end run (~88%)
HTML=1 scripts/coverage.sh --e2e
```

## Layout

| Crate / module | Role |
|---|---|
| `rv-core::normalize` | Rocket.Chat documents to local rows |
| `rv-core::rest` | REST: 401 discrimination, 2FA, 429 back-off, timeouts |
| `rv-core::ddp` | Listen-only DDP actor: login resume, ref-counted subs, silence watchdog |
| `rv-core::store` | SQLite (rusqlite): `_updatedAt`-arbitrated upserts, cursors, outbox, change broadcast |
| `rv-core::sync`, `outbox` | Stream and REST into SQLite; optimistic send with delivery check |
| `rv-core::session` | Login, wiring, reconnection with back-off |
| `rv-core::diff` | List refresh as splices, so views keep their scroll position |
| `rv-gtk` | libadwaita UI; tokio runs the core, GLib owns the main thread |

## Status

Password + TOTP login, session resume, rooms and subscriptions via cursors,
history paging, live messages and edits for every room through
`__my_messages__`, live deletions in the open room, optimistic send with
retry, read marking, reconnection with back-off, photo avatars and inline
images (click to enlarge).

Not yet: live avatar changes (`updateAvatar`; a changed photo shows after a
restart), markdown, non-image files beyond their name, threads view,
reactions, typing indicator, notifications, E2EE.
