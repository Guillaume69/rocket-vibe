# RFC 0003: server-delivered web client with GTK visual parity

Status: implemented on `codex/web-client`; qualification and remaining parity tracked in [execution](../WEB_CLIENT_EXECUTION.md). Scope amended by the user on 2026-10-08.

## Accepted scope

Deliver a true browser client directly from the native RocketVibe server, in its own worktree and branch, with GTK as the design reference. The browser signs into only the service that delivers it, with one account. Server/account switching and the GTK rail are intentionally absent. Encrypted rooms are unsupported for now: show locked metadata and prevent content, plaintext sends, file/recording and call actions. Installed GTK/mobile behavior is unchanged.

## Implemented architecture

`apps/web` uses strict TypeScript, native browser DOM controls and Vite. No UI kit or remote GTK process. Production assets are committed and embedded by `apps/server/build.rs`; the standalone binary and Docker image need no Node runtime. The explicit root/room routes never replace missing API/assets with HTML. HTML/worker/manifest are no-store and hashed assets immutable.

The native HTTP API supplies actions and ticketed WebSocket frames supply updates. IndexedDB stores the model, sole session, drafts, operation intents, pending text/files and private media. Revision/position and membership-lifetime checks prevent old operations/content reappearing after withdrawal and rejoin. Web Locks serialize replay/rotation and BroadcastChannel coordinates tabs. Protected media is hash-verified, separate from public worker caches.

Implemented screens cover sign-in, invitation/operator/email recovery, factors, room groups/history, message actions, threads/search, staged files/recording, profiles/room/member management, preferences, device sessions, administration and browser calls. LiveKit's Apache-2.0 SDK handles browser WebRTC only; the project implements the UI. Production dependency and original asset notices are delivered in the Licences screen.

## Visual contract

The build derives theme CSS and decorative stars from GTK source, reuses Nunito/Baloo 2 fonts, original sounds, Adwaita SVG icons and Fedora's Noto emoji font. Layout follows GTK's sidebar, headings, timeline, composer toolbar, cards, popovers and category preferences. The account rail is removed per the accepted scope.

Actual GTK reference builds/captures use the mandatory Fedora build script. The browser's room/settings/narrow screens and fonts/palette are checked with Playwright. Complete comparison of login/factors, long histories, menus, files, threads, search, error and security states is still qualification debt. Pango/browser rasterization differences do not change the same-design target.

## Platform mappings

Browser origin storage replaces native SQLite/keyring; clearing site data removes local pending work. HTTPS room links replace the custom application scheme. Browser capture/media permission dialogs control devices/screens. Foreground browser notifications, title unread count and click-to-room are implemented; closed-tab Web Push and inline notification reply are absent. Browser installation/public asset updates map binary updates, while native tray/autostart remain unavailable.

Only the native serving provider is in scope. Rocket.Chat, cross-origin authentication and CORS account switching are not enabled. No encrypted keys/plaintext are delegated to the server. A future crypto/browser-vault proposal needs its own lifecycle and delivery trust qualification.

## Evidence and remaining work

See the source-backed [inventory](../WEB_CLIENT_EXECUTION.md), [web README](../../apps/web/README.md), [brain architecture](../../brain/architecture/web-client.md) and [parity](../../brain/parity.md). Implementation status and tested scenarios are separate claims. The browser CI rebuilds committed assets and exercises the actual server with isolated PostgreSQL, TLS SMTP and LiveKit fixtures. No public deployment or full visual parity is claimed by this branch.

## Sources

- apps/web/src/app.ts
- apps/web/src/store.ts
- apps/web/src/api.ts
- apps/web/src/session.ts
- apps/web/src/voice.ts
- apps/web/src/security.ts
- apps/web/src/email.ts
- apps/web/scripts/sync-design.mjs
- apps/server/build.rs
- apps/server/src/web.rs
- apps/server/Dockerfile
- apps/desktop/crates/rv-gtk/src/style.rs
- apps/desktop/crates/rv-gtk/src/fonts.rs
- docs/WEB_CLIENT_EXECUTION.md
- .github/workflows/web-client.yml
