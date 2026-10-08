# RFC 0003: server-delivered web client with GTK visual parity

Status: browser-client direction selected, 2026-10-08. Detailed construction plan remains a proposal. No web client or browser parity is implemented by this document.

## Intent

Deliver a browser client from the RocketVibe server itself, with the same product design and user-facing capabilities as the GTK app. Keep its implementation on a dedicated branch and worktree. GTK is the visual reference for this request; the existing Android, GTK and SwiftUI functional parity contract remains applicable.

## Current evidence

- The server's Axum router exposes authentication, room/message operations, files, profiles, commands, voice calls and synchronization. It ends with a missing-resource fallback and currently serves no web application.
- GTK defines its Nuit Etoilee theme in `style.rs`, its layout and behavior in `chat.rs`, `rail.rs`, `rows.rs`, `message_list.rs` and `composer.rs`. Fonts are bundled: Nunito for body text and Baloo 2 for titles.
- GTK has both Rocket.Chat and RocketVibe providers. Feature availability depends on the provider. The native-server parity backlog is a separate contract from the three-app matrix.
- Neither `rv-core` nor `rv-crypto` is currently a browser-ready library. The former uses native Tokio networking, filesystem access and SQLite; the latter also uses durable filesystem storage, SQLite and optional system keychains. Reusing the cryptographic algorithms does not solve the browser storage and device lifecycle.
- Native encrypted-room rollout is still disabled in GTK's crypto settings code. The web client must respect the same qualification boundary.

## Proposed delivery

Use `apps/web/` for a TypeScript browser application with HTML and CSS components reproducing the GTK widgets. Framework/build-tool selection is deferred until implementation. Ship production assets in the server distribution, with no frontend development server or Node runtime required in production.

The RocketVibe server serves the application at `/` and versioned assets under a dedicated path. Retain the existing `/api/v1/` and socket routes, error envelopes, authentication and file behavior. A navigation fallback must never turn unknown API endpoints or missing assets into a successful HTML response.

Use the current HTTP and ticketed WebSocket contracts. Keep sessions and local data scoped by origin, server instance and account. Use a browser store for cached state, drafts and a persisted outbox; drive the UI from that store. Add reconnect catch-up, gap recovery, idempotency and account switching before calling it functional parity. Coordinate simultaneous tabs so they do not independently replay the same pending operation.

The first deployment target is the RocketVibe origin serving the assets. GTK's support for several servers, accounts and Rocket.Chat remains part of the requested inventory: define browser CORS, CSP and authentication requirements for additional origins, then implement a provider adapter or record explicit remaining debt. Do not silently reduce the scope to features common to both servers.

## Visual contract

Reproduce the server rail, room sections, headers, message grouping, cards, replies, threads, menus, composer, preferences, login and security dialogs. Preserve the exact application palette, gradients, radii, spacing, text sizes/weights, avatars, icons, focus states and animations.

Reuse the bundled font assets and their licenses. GTK patches font strikeout thickness at runtime; account for this in the web rendering rather than assuming the raw font files produce an identical result. Inventory Adwaita defaults and GTK layout measurements in addition to the custom CSS: copying colors alone is insufficient. Extract shared design values with a check against GTK to prevent later drift.

Capture the actual GTK app and browser using the same fixtures, viewport/content size, locale, clock, font assets and UI state. Cover login/2FA, room list, empty and populated rooms, long messages, uploads, reactions, threads, search, errors, settings and security dialogs. Compare layout and screenshot differences, then inspect them visually.

Identical design is the acceptance target. Byte-identical screenshots across Pango/GTK, browser text rasterizers and operating systems are not promised; choose a reference environment and document narrowly bounded rendering differences. Browser chrome is outside the application design.

## Functional inventory and browser mappings

Before implementation, enumerate every GTK capability from both provider implementations and the source-backed parity documents. Maintain a web status per row, with acceptance evidence and explicit debt.

| Area | Required outcome |
|---|---|
| Authentication and accounts | Login, applicable factors/recovery, session resume/revocation, account/server switching and logout cleanup. |
| Rooms and timeline | Sections, favorites, presence, unread/mentions, pagination, grouping, markdown, custom emoji, link previews, read state and navigation. |
| Compose and actions | Drafts, mentions, commands, quoting, editing/deleting, reactions, pinned/starred messages, formatting and retries. |
| Threads, search and management | Thread behavior, message/context search, room/member/profile/role controls exposed by GTK and each provider. |
| Files and media | Durable uploads, progress/retry, captions, protected downloads, image/audio/video playback, drag/drop/paste and voice recording. |
| Offline and realtime | Cached reads, persisted pending operations, reconnection and race-safe synchronization. |
| Calls | Existing provider voice/call lifecycle and browser microphone/camera flows with origin controls. |
| Encryption | Provider-specific message/file formats and client-side private state, with full enrollment, recovery, history and revocation qualification. |
| Preferences and accessibility | French/English, keyboard commands, focus management, selection and zoom/size behavior. |
| Notifications and platform integration | Browser permission and notification behavior; closed-tab delivery requires separately implemented Web Push/service worker support. Badge/title and app installation are browser-dependent. |
| Native lifecycle | Tray, start-at-login, external file handlers and desktop binary self-update need explicit browser mappings or documented platform limits. Asset updates replace desktop binary updates. |

The current server push endpoints do not establish Web Push support. Browser notifications while a tab is alive and notifications with the tab closed are separate acceptance cases.

## Encryption and trust

Private keys and decrypted private content stay on the user's device. Do not move GTK's cryptographic session to the server to avoid porting browser storage. First prove a browser build of the shared algorithms with matching protocol vectors; then isolate native persistence and define durable browser vault, locking, backup, recovery and multiple-tab behavior. WASM reuse is a candidate to qualify, not an existing capability.

A web client delivered by the server has a different trust model: a compromised server can change the JavaScript/WASM that a browser receives. State that difference from installed signed clients and define the release/integrity policy. Keep private data out of static/service-worker caches, render messages as untrusted input, constrain resource/call origins, and never log credentials or vault material.

## Implementation batches and evidence

1. Freeze the source-backed GTK feature inventory and reference screenshots. Define design values, assets and browser platform mappings.
2. Add the frontend build and server asset delivery. Prove root/navigation routes, API errors, missing assets, caching and release packaging. Reproduce the full GTK shell and login states.
3. Implement live ordinary messaging, local state/outbox, threads, actions and search. Validate reload, offline send, reconnection, duplicates, account switching and keyboard use against the real test server.
4. Complete files/media/voice, room and profile management, preferences, calls and notification mappings, with visual comparisons for every delivered screen.
5. Qualify provider-specific encrypted lifecycle in the browser. Close all GTK parity rows or name the remaining debt precisely. Add release and deployed-browser verification.

These are construction batches, not independent definitions of completion. A shell or ordinary chat pilot is not the requested finished client.

## Alternative: GTK Broadway

GTK can display applications in a browser with Broadway. This could preserve the GTK widget rendering while the application process runs on the server. It requires separate per-user runtime/storage and browser integration, changes the privacy boundary for encrypted content, and does not establish file, microphone, media or notification parity.

GTK's own documentation calls Broadway experimental and not actively developed. It is not the proposed production browser architecture.

## Documentation and validation

As implementation lands, add the web architecture entry and a web column/status to the functional parity documents in the same branch. Update the affected feature pages and changelogs. This proposal changes no shipped capability, so it does not mark any parity row done.

Run behavior tests for API delivery and client synchronization, real browser flows against the test server, and screenshot comparisons against GTK. All GTK builds/captures use the existing Fedora container workflow.

## Sources

- apps/server/src/http.rs
- apps/server/Cargo.toml
- crates/rv-protocol/src/lib.rs
- crates/rv-client/Cargo.toml
- crates/rv-crypto/Cargo.toml
- crates/rv-crypto/src/installation.rs
- apps/desktop/crates/rv-core/Cargo.toml
- apps/desktop/crates/rv-gtk/src/style.rs
- apps/desktop/crates/rv-gtk/src/fonts.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/rail.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-gtk/src/message_list.rs
- apps/desktop/crates/rv-gtk/src/composer.rs
- apps/desktop/crates/rv-gtk/src/native_crypto.rs
- apps/desktop/crates/rv-gtk/src/sidebar_dialog.rs
- brain/parity.md
- docs/protocol/PARITY.md
- [GTK Broadway](https://docs.gtk.org/gtk4/broadway.html)
- [Tokio browser/WASM limits](https://docs.rs/tokio/latest/tokio/#wasm-support)
- [Browser Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
