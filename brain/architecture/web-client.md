# Web client architecture

The native RocketVibe server embeds the browser application in its binary. Node is a build/test tool, never a production service. The browser uses the serving origin, one signed-in account, and the native HTTP/ticketed WebSocket contract. It does not connect to Rocket.Chat or another origin.

## Delivery and design

`apps/web` uses React 19, strict TypeScript, native browser controls and Vite. `apps/server/build.rs` embeds committed `apps/web/dist` and fails without `dist/index.html`; `src/web.rs` serves exactly `/`, `/room/{room}`, `/sw.js`, `/manifest.webmanifest` and `/assets/*`. Unknown API and asset routes retain 404. HTML, worker and manifest have no-store; hashed assets are immutable for a year. Every response carries a strict CSP (`wasm-unsafe-eval` for the crypto worker, frames limited to YouTube, Vimeo and Dailymotion embeds, `frame-ancestors 'none'`), `nosniff` and a same-origin referrer policy. The public-shell worker never stores API responses.

`scripts/sync-strings.mjs` extracts the desktop's catalog from `rv-core/src/i18n.rs` at build time (crypto, attachments, viewer and player, bots, workflows, voice, commands, settings categories, administration, reports, presence...) and the API refusal mappings of bots, workflows and administration; it refuses a catalog of fewer than 500 entries. `preferences-controls.ts` fences pages and one-time secret dialogs to their account. `bots.ts`, `workflows.ts` and `workflow-forms.ts` use the native server contract; workflow drafts are held in memory, never mixed with the message outbox.

`scripts/sync-design.mjs` translates GTK's theme and extracts its decorative stars. Nunito, Baloo 2, Adwaita SVG icons, Noto emoji and original sounds retain their licences. Browser and GTK rasterizers differ; the GTK Fedora build and captures establish a visual reference, not proof of every screen's pixel parity.

The 2026-10-12 screen audit compares the running native-provider GTK screens, including their provider-specific visibility rules. `shell-parity.css`, `conversation-parity.css`, `settings-parity.css` and `voice-parity.css` supply the corresponding geometry. Room groups have headers only when more than one nonempty group exists. The ordinary header contains marked/search/phone actions; the web thread list is available from the room-heading context menu, and across-room search retains Ctrl+Shift+F. `ui/format.tsx` shares toolbar toggles and shortcuts between room and thread composers. `markdown-text.ts` produces bounded, safe Markdown nodes for room/profile text, rendered by the existing React message renderer. `time-picker.ts` supplies native-style calendar and numeric clock controls.

Public same-origin shell/assets ignore HTTP Vary during cache lookup: crossorigin modules/styles carry an Origin header that precache requests lack. `/api/` and `/.well-known/` remain excluded, and private content never enters this cache. `tests/features.mjs` verifies worker-served JavaScript/CSS and the cached authenticated view through an offline reload.

`sidebar.ts` caches categories within the owning dialog so switching categories preserves draft and scroll state. Explicit mutations invalidate affected cached pages. Crypto controls check the dialog/account lifetime rather than temporary DOM connectivity. The login factor step owns its captured challenge until account activation completes. See [screen inventory](../../docs/WEB_GTK_SCREEN_AUDIT.md).

`room-avatar.ts` persists original image bytes, revision and nonce under account/membership-scoped operation intents, so uncertain delivery resumes the identical command. Room purges retire these intents along with other room-owned work. Private thread composers read a live canSend hook from the controller's view updates, disabling controls during a send without recreating the editor or losing its draft.

`composer.ts` implements a browser DOM text editor using the GTK draft spans: bold/italic/strike, inline/fenced code, headings, quotes and muted markers hidden away from the cursor line. Text and UTF-16 selections survive restyling. It handles native line breaks, plain-text paste, composition, undo/redo and programmatic toolbar edits. Room selection keeps the editor disabled until its draft and staged files are restored; a selection generation excludes late reads from another opening or session.

## Build, run and release

`npm run build` chains `crypto-assets.mjs` (refuses a committed wasm whose source digests no longer match), `sync-design.mjs`, `sync-strings.mjs`, `sync-crypto.mjs` (generates `src/crypto/shared/`, `schema.generated.ts` and `bridge-types.ts` from the mobile RocketVibe provider and `modules/crypto-native/index.ts`), `licenses.mjs`, the type check, `vite build` and `build-shell.mjs` (writes `sw.js`, cache `rv-shell-<hash>`, which skips `/api/` and `/.well-known/`, and `manifest.webmanifest` with the GTK icon). `npm run crypto:build` rebuilds `rv-crypto-web` to wasm in Docker ([shared-crates.md](shared-crates.md)). In development Vite proxies `/api` (with WebSockets) and `/.well-known/rocketvibe` to `RV_WEB_API_URL`, `http://127.0.0.1:3400` by default. The version lives in `package.json`; a `web-vX.Y.Z` tag releases the built frontend through `scripts/package-web.mjs`. CI (`web-client.yml`) runs the unit tests (`npm test`), the browser suites against a real server with PostgreSQL, SMTP and LiveKit on Chromium and Firefox, and rebuilds the wasm to check it matches.

## State and transport

Startup opens ordinary IndexedDB with a ten-second bound. A blocked schema upgrade immediately offers localized instructions to close other RocketVibe tabs and Retry, without deleting accounts, drafts or cache. Failed opens release the cached promise; late requests abort their obsolete upgrade or close the resulting connection. Our live connection closes on `versionchange`, so another tab can complete its upgrade. The React startup view owns retries separately from application disposal. `tests/startup-storage.mjs`, included in `shell-parity.mjs`, holds a real version-5 connection, retries after release, verifies a draft sentinel survives, and proves the current app releases a subsequent version-7 upgrade in English and French.

`api.ts` restricts REST paths to the serving origin, validates snapshot pagination and scopes session rejection to the token that made the request. `store.ts` applies revision/position order and membership lifetimes. IndexedDB (`rocket-vibe-web`, version 6) stores the account, model snapshot, drafts, staged files, text/upload outboxes, operation intents, private media, reminders and, outside the account purge, the tokens of sign-outs the server did not hear (`logouts`, replayed by `logouts.ts`). The model keeps 500 messages per room once per session after the catch-up (`Model.retain`). `diagnostics.ts` keeps a memory ring of recent client-side events for Settings > App > Diagnostics, with no token, message text or name. Web Locks serialize session renewal and queue replay; BroadcastChannel informs other tabs. Rotation saves its successor intent before sending and its receipt before removing the intent.

`room-state.ts` hydrates room creation/join and DM receipts with authenticated personal read state before publishing them. Those receipts omit membership state. The helper preserves newer room/read revisions and checks the owning account and membership lifetime, avoiding a temporary unknown membership that would retire the newly opened profile or private view. The model's room-lifetime counter records removal and known membership replacement, including an initial insertion and withdrawal within one held-response interval; a stale personal-state response cannot resurrect that room.

`ui/state.ts` is the controller's `ViewState` store (`subscribe`, `getSnapshot`); `ui/application.tsx` and `ui/profile.tsx` read it through `useSyncExternalStore`, and `ui/portals.tsx` its secondary views. Keyed conversation components preserve connected media and edit state. Shared portal/dialog/sidebar components own secondary views; account-scoped legacy page builders and bounded editor/SDK hosts are explicit adapters, documented in [React architecture](../../docs/WEB_REACT.md). `app.ts` drives transport and model state, serializes socket frames and catches up before replay. Withdrawn rooms and changed membership lifetimes purge pending work and private media. Protected blobs are verified by SHA-256 and kept in IndexedDB, with a 250 MiB media budget. Object URLs are released on access loss and logout.

`scheduleRead` captures a rendered root-message position and membership once, waits 1.5 seconds and rechecks the account, room opening, membership, visibility and latest scroll position before sending. Arrivals do not postpone the timer or advance its captured target. One read request runs at a time; acknowledgments preserve newer revisions. Browser focus on the body after disabling an action button still counts as the active chat when no modal owns it. Notifications use the same visibility guard and close only after current unread counts reach zero.

## Media and security

`uploads.ts` persists preparation/completion operations; voice recordings and photos are staged before Send. `voice.ts` lazily loads LiveKit's Apache-2.0 browser transport for microphone/camera/screenshare calls; it is a transport dependency, not a UI kit. Browser permissions and HTTPS are required outside loopback. Voice grants are scoped to the initiating account and call lifecycle across each asynchronous step. Serialized teardown completes before a new join, and its server request retains the departing session token.

`voice-output.ts` observes native `setSinkId` promises on each call-owned AudioContext because LiveKit's Web Audio output switch does not await them. The native promise remains available to awaited callers; failures from retired calls cannot create notices or unhandled rejections, and new output requests cannot reach a closed context. The lifecycle browser fixture deliberately releases a delayed native sink change after actual call teardown.

The SFU's WebSocket origin being reachable does not prove its ICE candidates are reachable. Firefox/Chromium connection tests exchange actual audio and inspect RTP statistics, with Firefox's standard ICE loopback policy. An initial SDK disconnection leaves error reporting to the awaiting connect handler; it closes the call/context and allows retry. Established disconnections and user cancellation still invalidate the lifecycle immediately.

`security.ts` and `email.ts` expose native TOTP, recovery codes, verified contact and email factors. Native RocketVibe encrypted rooms use the shared Rust MLS engine through a dedicated WASM worker. `crypto/shared` is generated from mobile orchestration; `crypto/vault.ts` seals the complete private worker snapshot with a non-extractable WebCrypto key in separate IndexedDB, under a cross-tab lock and durable revision check. Private messages/drafts never enter the ordinary model, cache or outbox. Files use the native encrypted-object format; decrypted media URLs stay in the live view. Calls require supported frame encryption and the native MLS voice key. Unsupported or unapproved devices remain locked. Browser storage has no independent OS-keystore anti-rollback anchor: see [browser E2EE](../../docs/WEB_E2EE.md) for the delivery trust model and qualification limits. Notifications require a live tab; closed-tab Web Push is not implemented.

## Sources

- docs/WEB_GTK_SCREEN_AUDIT.md
- apps/web/src/markdown-text.ts
- apps/web/src/time-picker.ts
- apps/web/src/ui/format.tsx
- apps/web/src/sidebar.ts
- apps/web/src/room-avatar.ts
- apps/web/src/room-state.ts
- apps/web/src/ui/thread.tsx
- docs/WEB_REACT.md
- apps/web/src/ui/application.tsx
- apps/web/src/ui/messages.tsx
- apps/web/src/ui/portals.tsx
- docs/WEB_E2EE.md
- crates/rv-crypto-web/src/lib.rs
- apps/web/src/crypto/worker.ts
- apps/web/src/crypto/vault.ts
- apps/web/src/crypto/chat.ts
- apps/web/src/crypto/settings-controls.ts
- apps/web/src/composer.ts
- apps/web/tests/composer.mjs
- apps/web/tests/startup-storage.mjs
- apps/web/tests/shell-parity.mjs
- apps/web/tests/sessions.mjs
- apps/web/tests/reads.mjs
- apps/web/src/api.ts
- apps/web/src/store.ts
- apps/web/src/logouts.ts
- apps/web/src/diagnostics.ts
- apps/web/src/session.ts
- apps/web/src/app.ts
- apps/web/src/media.ts
- apps/web/src/uploads.ts
- apps/web/src/voice.ts
- apps/web/src/voice-output.ts
- apps/web/tests/voice-output.test.ts
- apps/web/tests/voice-lifecycle.mjs
- apps/web/tests/voice.mjs
- apps/web/tests/voice-connection.mjs
- apps/web/src/security.ts
- apps/web/src/email.ts
- apps/web/scripts/sync-design.mjs
- apps/server/build.rs
- apps/server/src/web.rs
- apps/web/package.json
- apps/web/vite.config.js
- apps/web/src/ui/state.ts
- apps/web/src/ui/profile.tsx
- apps/web/src/preferences-controls.ts
- apps/web/src/bots.ts
- apps/web/src/workflows.ts
- apps/web/src/workflow-forms.ts
- apps/web/scripts/sync-strings.mjs
- apps/web/scripts/sync-crypto.mjs
- apps/web/scripts/build-shell.mjs
- apps/web/scripts/crypto-assets.mjs
- apps/web/scripts/build-crypto.mjs
- scripts/package-web.mjs
- .github/workflows/web-client.yml
