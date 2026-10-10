# Architecture overview

rocket-vibe is a monorepo of chat clients and one chat server. Three client apps (Android in `apps/mobile`, GTK and SwiftUI in `apps/desktop`, a browser app in `apps/web`) speak to three kinds of server: Rocket.Chat 8, Mattermost or kChat, and the project's own RocketVibe server in `apps/server`. The native apps share one design: the network writes into a local SQLite database and the UI only observes that database. Read this first, then follow the links to the per-subsystem docs.

## The repository

```
apps/mobile/     Expo / React Native app, Android first (TypeScript)
apps/desktop/    Rust workspace (rv-core, rv-gtk, rv-native, rv-ffi, rv-voice-protocol),
                 the voice sidecar workspace in voice/, the SwiftUI app in macos/
apps/web/        React browser client for the RocketVibe server, embedded in its binary
apps/server/     The RocketVibe server: Rust, Axum, PostgreSQL
crates/          Shared Rust: rv-protocol, rv-client, rv-crypto, rv-crypto-public,
                 rv-crypto-mobile, rv-crypto-web, rv-voice-mobile
Cargo.toml       Root workspace: the server, rv-protocol, rv-client, rv-crypto-public
docker/          Rocket.Chat 8.5.1 bench (compose.yml), RocketVibe server and PostgreSQL
                 (compose.rocketvibe.yml), LiveKit (compose.voice.yml), Mattermost,
                 native pilot benches
scripts/         seed.mjs, version.mjs, changelog.mjs, cargo-locks.mjs, protocol and
                 emoji generators, the Rocket.Chat inventory
docs/            DEV.md, PUSH.md, MATTERMOST.md, DEPLOY-SERVER.md, protocol/ (the native
                 contract), rfcs/ (the RocketVibe server and its E2EE), execution logs
.github/         one workflow per app, plus the server, crypto and lock checks
```

Each app has its own version, changelog, CI workflow and release tag (`mobile-vX.Y.Z`, `desktop-vX.Y.Z`, `web-vX.Y.Z`, `server-vX.Y.Z`). They share:

- **Server contracts.** Rocket.Chat's ([rocket-chat.md](rocket-chat.md)), Mattermost's ([../features/mattermost-and-kchat.md](../features/mattermost-and-kchat.md)) and the RocketVibe server's, written once in `crates/rv-protocol` ([server.md](server.md)).
- **Rust code.** The desktop builds on `rv-client`, `rv-protocol` and `rv-crypto`; the mobile app links `rv-crypto-mobile` and `rv-voice-mobile`; the web app runs `rv-crypto-web` as wasm; the server uses `rv-protocol` and `rv-crypto-public` ([shared-crates.md](shared-crates.md)).
- **Behaviour.** The desktop core is a port of the mobile `lib/`, whose tests are its spec (`apps/desktop/crates/rv-core/src/lib.rs` says so); the web client follows the GTK design and the desktop's strings; [parity.md](../parity.md) tracks what each app owes the others.
- **Test benches** in `docker/`.

Technologies and versions are in [../stack.md](../stack.md); how to build and release is in [../operations.md](../operations.md).

## The shared principle: local-first, REST to act, DDP to listen

The mobile and desktop apps follow the same layering, chosen against the official Rocket.Chat app's documented failures (stacked subscriptions, duplicate messages, stuck sends; see [../decisions.md](../decisions.md)). The diagram is the Rocket.Chat provider's; Mattermost listens on its own WebSocket (kChat on Pusher), and the RocketVibe provider follows the server's ordered journal through a ticketed WebSocket, arbitrated by positions and revisions rather than `_updatedAt` ([server.md](server.md)):

```
UI                    observes the database, never holds the live feed in memory
  |  reactive queries (mobile: Drizzle useLiveQuery; desktop: Store change broadcast)
SQLite                the source of truth, one database per (server, account)
  |  idempotent upserts, arbitrated by the server's _updatedAt
REST  -> to ACT       DDP over WebSocket -> to LISTEN (connect, login resume, sub, unsub)
```

- Every write from either transport is an upsert, so the same document arriving twice (REST catch-up overlapping a stream event) is harmless.
- Sends are optimistic: a row is written locally with a client `_id`, then delivered; delivery is confirmed against the server when the response is ambiguous ([../features/offline-and-sync.md](../features/offline-and-sync.md)).
- DDP method calls are deprecated on Rocket.Chat 8 and never used by either client; the only exception is the mobile e2e test harness that toggles 2FA.
- A 401 means "not authenticated" and signs the user out, except on anonymous calls such as login, which map every failure to 401 ([rocket-chat.md](rocket-chat.md)).

## Mobile (`apps/mobile`)

An Expo SDK 57 app on React Native 0.86 (New Architecture), Android first, iOS prepared but never compiled. Layers, from the screen down:

| Directory | Role |
|---|---|
| `app/` | expo-router routes: `index.tsx` (room list), `login.tsx`, `room/[rid].tsx`, `thread/[id].tsx`, `call/[callId].tsx` (Jitsi call, the one WebView), search, settings, profiles, share target. |
| `ui/` | Components, theme, i18n catalog (`messages.ts`), and the React glue that owns the session and the sync engine (`session.tsx`, `sync.tsx`). |
| `providers/` | "Providers": `createProvider` picks the chat backend by `session.kind`: `rocketchat/`, `mattermost/` (Mattermost and kChat) and `rocketvibe/` (the RocketVibe server, with its generated protocol types and the crypto bridge). Each translates its server's wire format into neutral sync changes (`SyncChange`). The contract is `lib/provider.ts`. |
| `lib/` | Platform-free core: DDP client (`ddp.ts`), REST client (`rest.ts`), auth, sync engine (`sync.ts`, `SyncEngine`), catch-up (`catchUp.ts`), reconnection, send queue (`outbox.ts`), uploads, markdown, E2EE (`lib/e2e/`). Loadable by plain Node, which is how it is tested. |
| `db/` | SQLite schema (Drizzle), the SQL of every upsert (`upserts.ts`), the `Store` implementation (`store.ts`) and its serialised write queue (`writeQueue.ts`), migrations. |
| `plugins/`, `modules/` | Config plugins that shape the generated `android/`/`ios/` projects, and local Expo native modules. |

Dependencies point downward: `app/` and `ui/` use `lib/` and `db/`; `lib/` defines interfaces such as `Store` and never imports React Native, so its modules run under `node --test`. Details: [mobile-app.md](mobile-app.md), [mobile-data.md](mobile-data.md), [mobile-transport.md](mobile-transport.md), [mobile-native.md](mobile-native.md).

Push notifications arrive through FCM directly (our Firebase project, no Expo Push), with content hidden: the app fetches the message by `push.get` on receipt ([../features/notifications.md](../features/notifications.md)).

## Desktop (`apps/desktop`)

A Rust workspace with a UI-free core and two user interfaces over it. The core speaks Rocket.Chat, Mattermost and kChat, and the RocketVibe server (`rv-core/src/mattermost/`, `rv-core/src/native/`).

| Part | Role |
|---|---|
| `crates/rv-core` | Protocol and data, no UI: `rest`, `ddp` (listen-only actor), `store` (rusqlite; one transaction per write, one change broadcast after commit), `sync`, `outbox`, `uploads`, `session` (login, wiring, reconnection), `e2e`, plus display rules both UIs share (`timeline`, `markdown`, `rooms`, `i18n`, `emoji`). |
| `crates/rv-gtk` | The GTK 4 + libadwaita app (binary `rocket-vibe-gtk`) for Linux, Windows and macOS. tokio runs the core; GTK owns the main thread, and UI code hops over with `on_tokio(..).await` from `glib::spawn_future_local` futures. |
| `crates/rv-native` | Windows and macOS shims with no GTK: system notifications and badges, tray and single instance, start at login, the WebView2 / WKWebView call window and inline player. No-ops on Linux. |
| `crates/rv-ffi` | A UniFFI facade over `Session` for Swift, with its own tokio runtime and one listener callback for store changes and session events. |
| `crates/rv-voice-protocol` | The JSON-lines contract with the voice sidecar. |
| `voice/` | The voice sidecar `rv-voice`, its own workspace: it links libwebrtc ([../features/voice.md](../features/voice.md)). |
| `macos/` | SwiftPM package: the SwiftUI app `RocketVibe` over rv-ffi, view models in `RocketVibeKit` (build on Linux too), and the `rv-rooms` CLI. |

Dependency graph: `rv-gtk -> rv-core, rv-native`; `rv-ffi -> rv-core`; Swift `RocketVibeKit -> RocketVibeCore (generated) -> rv_ffi static library`. Everything Rust builds inside the Fedora 44 container (`scripts/build.sh`), never on the host directly. Details: [desktop-app.md](desktop-app.md), [desktop-core.md](desktop-core.md), [desktop-gtk.md](desktop-gtk.md), [desktop-macos.md](desktop-macos.md).

The desktop app has no push: it stays connected (optionally in the background or tray) and raises native notifications itself, and it updates itself from the repository's GitHub releases ([../features/desktop-updates.md](../features/desktop-updates.md)).

## Web (`apps/web`)

A React 19 single-page app built with Vite, for the RocketVibe server only, which compiles the built `dist/` into its binary and serves it from its own origin (one origin, one account). It keeps its data in IndexedDB, runs the MLS engine as wasm (`rv-crypto-web`) in a worker, reuses the GTK app's design and the desktop's strings through generated files, and joins voice with `livekit-client`. Details: [web-client.md](web-client.md), [../features/web-client.md](../features/web-client.md).

## Server (`apps/server`)

The RocketVibe server: one Rust binary (Axum, tokio, PostgreSQL through SQLx) that is also its operator CLI. An ordered journal of changes feeds clients through cursors and a ticketed WebSocket; files go to a local objects directory; push, email, link previews, workflows and voice reconciliation run as background loops over leased database queues; native E2EE is relayed and verified, never decrypted. Details: [server.md](server.md); the shared Rust it builds on: [shared-crates.md](shared-crates.md).

## The shared test server

`docker/compose.yml` runs Rocket.Chat 8.5.1, the production target's version, on a one-node MongoDB 8.0 replica set. Its bundle is replaced by a push-patched copy generated by `docker/patch-push.mjs`. `scripts/seed.mjs` creates `alice` and `bob`, `test-public`, `test-prive`, a DM, custom emoji and seeded messages; the native apps' end-to-end tests log in as those users ([testing.md](testing.md)).

`docker/compose.rocketvibe.yml` runs the RocketVibe server on PostgreSQL 18 (accounts come from `rv-server create-user`), `docker/compose.voice.yml` adds LiveKit, `docker/compose.mattermost.yml` a Mattermost bench, and the `compose.native-*-pilot.yml` files the CI pilots that drive the mobile, GTK and Swift providers against a real server ([server.md](server.md)).

## Footguns worth knowing before touching anything

- **The mobile `lib/` and `db/` must stay loadable by Node**: no `enum`, no constructor parameter properties (ESLint rule in `apps/mobile/eslint.config.js`), imports with `.ts` extensions. Break it and the unit tests stop running.
- **Calling a queued `Store` method inside a mobile transaction deadlocks** the write queue; transactions receive a direct writer. `lib/testStore.ts` makes the test fakes enforce this.
- **`android/` and `ios/` are regenerated** by every `expo prebuild`; hand edits vanish. Native changes go through `plugins/`, and a native module change needs a rebuild, not a Metro reload.
- **The desktop binary built in the container runs only on a host with matching GTK/libadwaita** (Fedora 44); elsewhere use the AppImage.
- **One version per app, checked by CI**: a mobile bump touches `app.json` (including `versionCode`) and `package.json`; a desktop bump touches `Cargo.toml` and `Cargo.lock`; a web bump `package.json` and `package-lock.json`; a server bump `apps/server/Cargo.toml` and the root `Cargo.lock` (`scripts/version.mjs`).
- **The server embeds the web client**: it does not compile without `apps/web/dist`, and serves the web build it was compiled with. A crypto change reaches the web only after `npm run crypto:build` (Docker) regenerates the committed wasm.
- **A protocol change touches the Rust type, `docs/protocol/v1.schema.json` and the generated TypeScript**; `apps/server/scripts/check.sh` fails until they agree ([shared-crates.md](shared-crates.md)).
- **Seven Rust workspaces, seven `Cargo.lock`**: after a `cargo update` anywhere, `node scripts/cargo-locks.mjs --sync`.
- **Rocket.Chat quirks** (upload in two steps with non-idempotent confirm, rate limit of 10 REST calls per minute, slow `chat.syncMessages` on big rooms, `__my_messages__` without deletions) shape most of the sync code; read [rocket-chat.md](rocket-chat.md) before changing it.

## Sources

- `README.md`
- `ROADMAP.md`
- `CLAUDE.md`
- `apps/mobile/app`
- `apps/mobile/ui/sync.tsx`
- `apps/mobile/ui/session.tsx`
- `apps/mobile/providers/index.ts`
- `apps/mobile/lib/provider.ts`
- `apps/mobile/lib/sync.ts`
- `apps/mobile/lib/testStore.ts`
- `apps/mobile/db/store.ts`
- `apps/mobile/eslint.config.js`
- `apps/desktop/Cargo.toml`
- `apps/desktop/crates/rv-core/src/lib.rs`
- `apps/desktop/crates/rv-core/src/session.rs`
- `apps/desktop/crates/rv-core/src/store.rs`
- `apps/desktop/crates/rv-gtk/src/main.rs`
- `apps/desktop/crates/rv-native/src/lib.rs`
- `apps/desktop/crates/rv-ffi/src/lib.rs`
- `apps/desktop/macos/Package.swift`
- `apps/desktop/docs/MACOS-SWIFTUI.md`
- `docker/compose.yml`
- `docker/compose.rocketvibe.yml`
- `Cargo.toml`
- `apps/mobile/providers/index.ts`
- `apps/web/package.json`
- `apps/server/build.rs`
- `scripts/version.mjs`
- `scripts/seed.mjs`
