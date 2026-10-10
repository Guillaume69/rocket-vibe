# Web client architecture

The native RocketVibe server embeds the browser application in its binary. Node is a build/test tool, never a production service. The browser uses the serving origin, one signed-in account, and the native HTTP/ticketed WebSocket contract. It does not connect to Rocket.Chat or another origin.

## Delivery and design

`apps/web` uses strict TypeScript, browser DOM controls and Vite. `apps/server/build.rs` embeds committed `apps/web/dist`; `src/web.rs` serves explicit root/room navigation and hashed assets. Unknown API and asset routes retain 404. HTML, worker and manifest have no-store; hashed assets are immutable. The public-shell worker never stores API responses.

`scripts/sync-strings.mjs` extracts the bot/workflow labels and API refusal mappings from rv-core at build time. `preferences-controls.ts` fences pages and one-time secret dialogs to their account. `bots.ts`, `workflows.ts` and `workflow-forms.ts` use the native server contract; workflow drafts are held in memory, never mixed with the message outbox.

`scripts/sync-design.mjs` translates GTK's theme and extracts its decorative stars. Nunito, Baloo 2, Adwaita SVG icons, Noto emoji and original sounds retain their licences. Browser and GTK rasterizers differ; the GTK Fedora build and captures establish a visual reference, not proof of every screen's pixel parity.

`composer.ts` implements a browser DOM text editor using the GTK draft spans: bold/italic/strike, inline/fenced code, headings, quotes and muted markers hidden away from the cursor line. Text and UTF-16 selections survive restyling. It handles native line breaks, plain-text paste, composition, undo/redo and programmatic toolbar edits. Room selection keeps the editor disabled until its draft and staged files are restored; a selection generation excludes late reads from another opening or session.

## State and transport

`api.ts` restricts REST paths to the serving origin, validates snapshot pagination and scopes session rejection to the token that made the request. `store.ts` applies revision/position order and membership lifetimes. IndexedDB stores the account, model snapshot, drafts, staged files, text/upload outboxes, operation intents and private media. Web Locks serialize session renewal and queue replay; BroadcastChannel informs other tabs. Rotation saves its successor intent before sending and its receipt before removing the intent.

`app.ts` drives the screens from the model, serializes socket frames and catches up before replay. Withdrawn rooms and changed membership lifetimes purge pending work and private media. Protected blobs are verified by SHA-256 and kept in IndexedDB, with a 250 MiB media budget. Object URLs are released on access loss and logout.

`scheduleRead` captures a rendered root-message position and membership once, waits 1.5 seconds and rechecks the account, room opening, membership, visibility and latest scroll position before sending. Arrivals do not postpone the timer or advance its captured target. One read request runs at a time; acknowledgments preserve newer revisions. Browser focus on the body after disabling an action button still counts as the active chat when no modal owns it. Notifications use the same visibility guard and close only after current unread counts reach zero.

## Media and security

`uploads.ts` persists preparation/completion operations; voice recordings and photos are staged before Send. `voice.ts` lazily loads LiveKit's Apache-2.0 browser transport for microphone/camera/screenshare calls; it is a transport dependency, not a UI kit. Browser permissions and HTTPS are required outside loopback. Voice grants are scoped to the initiating account and call lifecycle across each asynchronous step. Serialized teardown completes before a new join, and its server request retains the departing session token.

The SFU's WebSocket origin being reachable does not prove its ICE candidates are reachable. Firefox/Chromium connection tests exchange actual audio and inspect RTP statistics, with Firefox's standard ICE loopback policy. An initial SDK disconnection leaves error reporting to the awaiting connect handler; it closes the call/context and allows retry. Established disconnections and user cancellation still invalidate the lifecycle immediately.

`security.ts` and `email.ts` expose native TOTP, recovery codes, verified contact and email factors. Native RocketVibe encrypted rooms use the shared Rust MLS engine through a dedicated WASM worker. `crypto/shared` is generated from mobile orchestration; `crypto/vault.ts` seals the complete private worker snapshot with a non-extractable WebCrypto key in separate IndexedDB, under a cross-tab lock and durable revision check. Private messages/drafts never enter the ordinary model, cache or outbox. Files use the native encrypted-object format; decrypted media URLs stay in the live view. Calls require supported frame encryption and the native MLS voice key. Unsupported or unapproved devices remain locked. Browser storage has no independent OS-keystore anti-rollback anchor: see [browser E2EE](../../docs/WEB_E2EE.md) for the delivery trust model and qualification limits. Notifications require a live tab; closed-tab Web Push is not implemented.

## Sources

- docs/WEB_E2EE.md
- crates/rv-crypto-web/src/lib.rs
- apps/web/src/crypto/worker.ts
- apps/web/src/crypto/vault.ts
- apps/web/src/crypto/chat.ts
- apps/web/src/crypto/settings-controls.ts

- apps/web/src/composer.ts
- apps/web/tests/composer.mjs
- apps/web/tests/sessions.mjs
- apps/web/tests/reads.mjs
- apps/web/src/api.ts
- apps/web/src/store.ts
- apps/web/src/session.ts
- apps/web/src/app.ts
- apps/web/src/media.ts
- apps/web/src/uploads.ts
- apps/web/src/voice.ts
- apps/web/tests/voice.mjs
- apps/web/tests/voice-connection.mjs
- apps/web/src/security.ts
- apps/web/src/email.ts
- apps/web/scripts/sync-design.mjs
- apps/server/build.rs
- apps/server/src/web.rs
