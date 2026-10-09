# BRAIN - rocket-vibe knowledge base

The map of the codebase, written so a developer or AI can understand both apps
**without reading the source**. Start here, follow the links, stop when you have
the answer. Every leaf doc cites the real source files if you need to go deeper.

> Product: **rocket-vibe** - third-party Rocket.Chat clients, faster and more
> reliable than the official ones, for self-hosted servers on Rocket.Chat 8 or
> later. Installed clients in `apps/mobile` (Expo / React Native, Android
> first) and `apps/desktop` (Rust core, GTK 4 + libadwaita UI, plus a SwiftUI app
> for macOS), plus `apps/web`, a browser client delivered by the native RocketVibe server.
> Each has its own version: `apps/mobile/app.json`, `apps/desktop/Cargo.toml` and
> `apps/web/package.json`. Stack snapshot in [stack.md](stack.md).

## How to use this

1. Know the topic? Jump straight to its file via the indexes below.
2. Have a question, not a topic? Scan **Find by question** first.
3. Met a project term (`hotRooms`, connection setup, `writeQueue`) or a legacy
   French stored name? See [glossary.md](glossary.md).
4. Want the "why" behind a design? See [decisions.md](decisions.md).
5. Need what the Rocket.Chat server really does? The verified facts live in the
   repo's `CLAUDE.md`; [architecture/rocket-chat.md](architecture/rocket-chat.md)
   explains how each client uses them.

The brain is a tree: this file -> two folder indexes
([architecture/index.md](architecture/index.md),
[features/index.md](features/index.md)) -> leaf docs. Don't grep the whole tree;
use the indexes.

## Top-level docs

| Doc | What's here |
|---|---|
| [stack.md](stack.md) | Exact technologies and versions for both apps, the toolchains per OS, the Docker images, the CI runners. |
| [operations.md](operations.md) | Environment, the test server and its seed, build and run per app, CI, versions, the tag release flow, secrets. |
| [glossary.md](glossary.md) | Rocket.Chat terms, the project's own terms, the legacy French names still read for upgrades, desktop crate names. |
| [decisions.md](decisions.md) | The non-obvious decisions and their rationale. |
| [parity.md](parity.md) | What each app (Android, GTK, SwiftUI, Web) can do, row by row, and the debt each owes the others. |

## Architecture (the how) - [architecture/index.md](architecture/index.md)

| Doc | What's here |
|---|---|
| [overview.md](architecture/overview.md) | Monorepo shape, the shared local-first "REST to act, DDP to listen" design, each app's layers. Read first. |
| [rocket-chat.md](architecture/rocket-chat.md) | The server contract both clients rely on: endpoints, streams, 401 and envelopes, rate limit, cursors, uploads. |
| [testing.md](architecture/testing.md) | Unit tests per app, the Maestro suite, desktop fake servers, live tests, smoke and e2e runs, what CI gates. |
| [e2ee.md](architecture/e2ee.md) | The E2EE key chain and message/file formats in both apps. |
| [i18n.md](architecture/i18n.md) | French and English in both apps, and how to add a string in each. |
| [mobile-app.md](architecture/mobile-app.md) | Mobile layering (`app/`, `ui/`, `lib/`, `db/`, `providers/`), providers, stores, live queries, theme. |
| [mobile-data.md](architecture/mobile-data.md) | One SQLite file per (server, account), its tables, the write queue, migrations, retention. |
| [mobile-transport.md](architecture/mobile-transport.md) | The listen-only DDP client, the REST client, liveness, backoff, session revocation. |
| [mobile-native.md](architecture/mobile-native.md) | CNG, the config plugins, the local Expo modules, quick-crypto, when to rebuild the dev-client, iOS. |
| [desktop-app.md](architecture/desktop-app.md) | The desktop workspace: four crates, the SwiftUI package, the build container, runtime state. |
| [desktop-core.md](architecture/desktop-core.md) | rv-core module by module: async model, session, REST, DDP, store, sync, outbox, uploads. |
| [desktop-gtk.md](architecture/desktop-gtk.md) | rv-gtk structure, core events to the main thread, rv-native per platform, video, packaging. |
| [desktop-macos.md](architecture/desktop-macos.md) | The SwiftUI macOS app over rv-ffi (UniFFI), its view models, status. |
| [web-client.md](architecture/web-client.md) | Server-embedded browser application, origin/session rules, IndexedDB and browser transports. |

## Features (the what) - [features/index.md](features/index.md)

Each feature doc covers mobile and desktop, and says where they differ.

| Doc | What's here |
|---|---|
| [login-and-servers.md](features/login-and-servers.md) | Server probe, login, 2FA, session resume and revocation, multi-server and multi-account. |
| [mattermost-and-kchat.md](features/mattermost-and-kchat.md) | Mattermost and kChat servers on the three apps: login, real time, sync, sending, media. |
| [offline-and-sync.md](features/offline-and-sync.md) | Local-first sync: catch-up layers, hot rooms, write queue and outbox, retention, reconnection. |
| [room-list.md](features/room-list.md) | Unread / Favourites / Channels / DMs sections, ordering, previews, badges, presence. |
| [room-view.md](features/room-view.md) | History paging, live messages, grouping, markdown, system messages, cards, jumps, unread bar. |
| [composer.md](features/composer.md) | Where a send goes, drafts, quote replies, mentions, editing, formatting, staged attachments. |
| [bots.md](features/bots.md) | RocketVibe server: bots owned by a person, API keys and scopes, the API reference, the BOT badge, the administrators' switch. |
| [workflows.md](features/workflows.md) | RocketVibe server: automations acting through a bot, their triggers and steps, the run engine, forms in messages. |
| [slash-commands.md](features/slash-commands.md) | `commands.list` / `commands.run`, the RocketVibe server's commands, the command panel, the server's private answers. |
| [uploads.md](features/uploads.md) | The two-step upload behind a persisted queue, local dedup, retries, progress, protected downloads. |
| [voice-messages.md](features/voice-messages.md) | Recording and playback, and why the formats differ per app. |
| [message-actions.md](features/message-actions.md) | Which actions show, the endpoints, the menus, pinned and starred lists. |
| [threads.md](features/threads.md) | Thread loading and paging, live replies, the thread composer and its limits. |
| [search.md](features/search.md) | `spotlight` to find people and channels, `chat.search` inside a room. |
| [media-playback.md](features/media-playback.md) | Protected media URLs, image viewers, audio/video players, video-site cards. |
| [avatars.md](features/avatars.md) | Avatar URLs, etag cache busting and its sources, the no-photo marker, own photo. |
| [emoji.md](features/emoji.md) | The shortcode table, custom emoji, rendering order, completion, pickers, quick reactions. |
| [room-info-and-profiles.md](features/room-info-and-profiles.md) | Room info, user profiles, editing my own profile. |
| [settings.md](features/settings.md) | What each setting is and where it is stored, the categories and their layout per app. |
| [administration.md](features/administration.md) | Server administration and reports: the model per provider, the Rocket.Chat mapping, the RocketVibe contract, deleted accounts. |
| [notifications.md](features/notifications.md) | Mobile FCM push with hidden content, the native service, desktop notifier and badge. |
| [e2ee.md](features/e2ee.md) | Encrypted rooms as the user sees them: lock, unlock, sends, media, notifications. |
| [e2ee-history.md](features/e2ee-history.md) | RocketVibe server: a new device recovers encrypted history from another device of the account. |
| [e2ee-delegation.md](features/e2ee-delegation.md) | RocketVibe server: control of the account (its root) handed to another device with a history share. |
| [e2ee-storage-keys.md](features/e2ee-storage-keys.md) | RocketVibe server: the vault's storage key renewed every 30 days, old keys destroyed. |
| [e2ee-private-files.md](features/e2ee-private-files.md) | RocketVibe server: files of private rooms sealed on the device, opaque to the server. |
| [e2ee-private-actions.md](features/e2ee-private-actions.md) | RocketVibe server: encrypted edits, deletions and reactions of private messages, and private search on the device. |
| [voice.md](features/voice.md) | RocketVibe server: voice channels, calls in every room and ringing DMs over LiveKit. |
| [calls.md](features/calls.md) | Rocket.Chat servers: Jitsi calls, the mobile WebView exception, desktop call windows. |
| [sharing-and-links.md](features/sharing-and-links.md) | `rocketvibe://` deep links, the incoming share screen, outgoing-link guard, drag and paste. |
| [desktop-updates.md](features/desktop-updates.md) | The desktop self-update from GitHub releases, per platform. |
| [web-client.md](features/web-client.md) | Server-delivered web client, one origin/account, GTK design and browser limits. |

## Find by question

| If you're asking... | Go to |
|---|---|
| Where does a new piece of mobile code go? | [architecture/mobile-app.md](architecture/mobile-app.md) |
| How does a message reach the screen, and why never straight from the network? | [architecture/overview.md](architecture/overview.md), [features/offline-and-sync.md](features/offline-and-sync.md) |
| Which endpoint or stream does X, and what does the server answer? | [architecture/rocket-chat.md](architecture/rocket-chat.md) |
| When does a 401 sign the user out? | [architecture/mobile-transport.md](architecture/mobile-transport.md), [features/login-and-servers.md](features/login-and-servers.md) |
| What happens after a reconnection, and why not resync every room? | [features/offline-and-sync.md](features/offline-and-sync.md) |
| Why can't an upload be confirmed twice, and how is the duplicate avoided? | [features/uploads.md](features/uploads.md) |
| How do I add a table or a column on mobile? | [architecture/mobile-data.md](architecture/mobile-data.md) |
| Does this change need a dev-client rebuild? | [architecture/mobile-native.md](architecture/mobile-native.md) |
| How do I add a user-facing string? | [architecture/i18n.md](architecture/i18n.md) |
| How does a push turn into a notification when the push carries no content? | [features/notifications.md](features/notifications.md) |
| How is an encrypted room read and written? | [architecture/e2ee.md](architecture/e2ee.md), [features/e2ee.md](features/e2ee.md) |
| Why is there a WebView in the mobile app at all? | [features/calls.md](features/calls.md), [decisions.md](decisions.md) |
| How does voice reach the server and who sees who is speaking? | [features/voice.md](features/voice.md) |
| Why doesn't a changed avatar show up? | [features/avatars.md](features/avatars.md) |
| Where do core events reach the GTK main thread? | [architecture/desktop-gtk.md](architecture/desktop-gtk.md) |
| How does the SwiftUI app talk to the Rust core? | [architecture/desktop-macos.md](architecture/desktop-macos.md) |
| Does desktop do X yet, and how does it differ from mobile? | [parity.md](parity.md), then the feature doc's Mobile and Desktop sections |
| How do I start the test server and seed it? | [operations.md](operations.md) |
| What does CI check, and what only runs on a tag? | [operations.md](operations.md), [architecture/testing.md](architecture/testing.md) |
| How do I cut a release? | [operations.md](operations.md) (and the `release` skill) |
| What does `hotRooms` / connection setup / `writeQueue` mean? | [glossary.md](glossary.md) |
| Who sees the server administration, and what can an admin read? | [features/administration.md](features/administration.md), [decisions.md](decisions.md) |
| Why are these the quick reactions, and where are they counted? | [features/emoji.md](features/emoji.md) |

## Maintaining the brain

This brain is **load-bearing documentation**: it must stay true to the code.
When a change makes a brain doc wrong, fix the doc in the same branch. When you
discover the brain disagrees with reality, the code wins: correct the brain and
note it. The rule lives in the repo's `CLAUDE.md` ("The brain"), the procedure in
the `brain` skill. New feature -> new `features/<name>.md` + a row in
[features/index.md](features/index.md) + a row here + its rows in
[parity.md](parity.md), one status per app ("Parity" in `CLAUDE.md`).

The brain does not replace the docs that have their own job: the changelogs,
`apps/mobile/WORKSTREAMS.md` (the debt to fix next), `ROADMAP.md` (product
decisions) and `CLAUDE.md` (the probed server facts). It links them.
