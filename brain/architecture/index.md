# Architecture index

How the two apps are built. Start with [overview.md](overview.md), then go to the
shared docs or to the app you are working on. Back to [../BRAIN.md](../BRAIN.md).

## Shared

| Doc | What's here |
|---|---|
| [overview.md](overview.md) | Monorepo shape, the local-first "REST to act, DDP to listen" layering both apps follow, the mobile layers and desktop crates, the shared server, the main footguns. |
| [rocket-chat.md](rocket-chat.md) | The Rocket.Chat 8.5 contract as both clients use it: streams subscribed, endpoints by purpose with their mobile and desktop call sites, 401 and envelope rules, rate limit, cursors and `_updatedAt`, two-step uploads. Links `CLAUDE.md` as the canonical record. |
| [testing.md](testing.md) | Mobile `node --test` (type stripping, real-SQLite tests, fake-store traps), the Maestro suite, desktop unit and integration tests over fake HTTP/DDP servers, live tests gated by `RV_TEST_SERVER`, smoke and e2e scripts, coverage, CI package smoke runs. |
| [e2ee.md](e2ee.md) | The E2EE key chain in both apps: private-key envelopes, room keys unwrapped with RSA-OAEP, message and file formats, quick-crypto aliasing, key rotation, per-account key storage. |
| [i18n.md](i18n.md) | French and English: mobile `ui/messages.ts` and `ui/i18n.ts` plus the native push strings, desktop `rv-core` `i18n.rs` shared by GTK and SwiftUI. |
| [web-client.md](web-client.md) | Embedded browser distribution, GTK design synchronization, one origin/account, indexed storage and browser media. |

## Developing provider contracts

| Doc | What is here |
|---|---|
| [teams.md](teams.md) | Private Teams read preview, developer browser acquisition, public-key handoff, conservative dynamic routing and live qualification boundary. |
| [slack-session.md](slack-session.md) | Slack Session mode research: measured token/cookie RTM behaviour, protocol handoff, provider parity limits and pending qualification. First hidden read-only preview; persistent accounts and the full driver remain pending. |

## Mobile (`apps/mobile`)

| Doc | What's here |
|---|---|
| [mobile-app.md](mobile-app.md) | Layering (`app/` routes, `ui/`, Node-pure `lib/`, `db/`, the `providers/` facade), root providers, session and sync state, module stores and their purge rule, live queries, theme and kit, the native-components rule. |
| [mobile-data.md](mobile-data.md) | One SQLite file per (server, account), every table, the per-connection write queue, drizzle-kit migrations, upsert rules, stores, reconciliation, 500-messages-per-room retention. |
| [mobile-transport.md](mobile-transport.md) | The listen-only DDP client (ref-counted replayable subscriptions, silence watchdog, ping probe), the REST client (timeouts, 429, token-rejected hook), backoff, connection setup, background handling, deferred logout. |
| [mobile-native.md](mobile-native.md) | CNG (`android/` and `ios/` gitignored), every config plugin, the four local Expo modules, the patches, Metro's `crypto`/`buffer` aliasing, when a dev-client rebuild is needed, iOS status. |

## Desktop (`apps/desktop`)

| Doc | What's here |
|---|---|
| [desktop-app.md](desktop-app.md) | The workspace: rv-core, rocket-vibe-gtk, rv-native, rv-ffi, the SwiftUI package, their dependencies, the Fedora build container and `scripts/build.sh`, assets, runtime state. |
| [desktop-core.md](desktop-core.md) | rv-core module by module: tokio actors and broadcast channels, session wiring and catch-up order, REST, the DDP actor, the store's `_updatedAt` arbitration, sync cursors, outbox, uploads. |
| [desktop-gtk.md](desktop-gtk.md) | rv-gtk structure (AppWindow, ChatPage, MessageList), how core events reach the main thread, rv-native on Windows and macOS, video through GTK media or GStreamer, packaging. |
| [desktop-macos.md](desktop-macos.md) | The SwiftUI macOS app over rv-ffi: one tokio runtime, one Listener, RocketVibeKit view models, accounts shared with GTK, build and CI, status. |
