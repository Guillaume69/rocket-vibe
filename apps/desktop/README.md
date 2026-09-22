# rocket-vibe-rs

Desktop Rocket.Chat client in Rust: GTK 4 + libadwaita on top of a UI-free
protocol core. A comparison experiment next to the Qt/C++ port
(`../rocket-vibe-desktop`); both port the Android app's `lib/` (`../rocket-vibe`),
whose tests are the spec.

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

## Headless smoke run

Logs in, opens a room, optionally sends a message, saves a screenshot and
quits, under Xvfb in the build image:

```sh
scripts/smoke.sh http://localhost:3000 alice alice-dev-2026 test-public /tmp/shot.png "hello"
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

Same scope as the Qt port's first milestone: password + TOTP login, session
resume, rooms and subscriptions via cursors, history paging, live messages and
edits for every room through `__my_messages__`, live deletions in the open
room, optimistic send with retry, read marking, reconnection with back-off.
