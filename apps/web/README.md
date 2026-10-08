# rocket-vibe web

The native RocketVibe server serves this actual browser client at `/`. It uses that origin and one account. Encrypted conversations are currently unsupported and shown locked.

The interface reuses the GTK theme, Nunito/Baloo 2 fonts, Adwaita icons, Noto emoji and project sounds. Chat, threads, actions, search, drafts, offline queues, uploads, recording, profiles, room management, administration, security settings and LiveKit calls are implemented. See [execution and remaining parity](../../docs/WEB_CLIENT_EXECUTION.md).

## Build

Use Node 24. Run from `apps/web`:

```sh
npm ci
npm run format:check
npm run check
npm test
npm run build
```

The build synchronizes GTK design values and generates dependency licence notices before compiling. Commit `dist` and the generated design/licence files alongside source changes. Cargo embeds these committed files, so a fresh server checkout or Docker build needs no Node runtime. Rebuild the server after changing the web bundle:

```sh
cargo build --locked -p rv-server
```

For development, `RV_WEB_API_URL=http://127.0.0.1:3400 npm run dev` proxies the native API and WebSocket. Production requires HTTPS for browser media, Web Crypto, Web Locks and the worker; loopback is an allowed development exception. The existing server deployment serves the application automatically.

## Verification

The Node tests cover model ordering/access withdrawal and authenticated error handling. Playwright tests use real disposable accounts `webalice` (administrator) and `webbob`, password `web-client-disposable-password`, on loopback only. Never point fixtures at a real deployment.

```sh
npx playwright install chromium
RV_WEB_TEST_URL=http://127.0.0.1:3417 npm run test:browser
RV_WEB_TEST_URL=http://127.0.0.1:3417 npm run test:features
RV_WEB_TEST_URL=http://127.0.0.1:3417 npm run test:voice
RV_WEB_TEST_URL=http://127.0.0.1:3417 npm run test:sessions
RV_WEB_TEST_URL=http://127.0.0.1:3417 npm run test:locked
RV_WEB_TEST_URL=http://127.0.0.1:3417 npm run test:composer
RV_WEB_SECURITY_USER=websecurity npm run test:security
```

Voice requires the server's isolated LiveKit configuration. Security requires the TLS SMTP fixture (`node apps/web/tests/smtp.mjs` from repository root), the server's SMTP configuration pointing to localhost:14653 and its fixture certificate, plus a fresh `websec*` account. The editor suite uses `RV_WEB_COMPOSER_USER` when set and creates its own room; CI seeds a separate `webcomposer` account to keep combined login scenarios within the native ten-per-minute account budget. Fixture captures are in ignored `.cache/smtp-mails.json`; screenshots in `.cache/web-shots`.

## Browser mappings and limits

One origin/account intentionally replaces the GTK server rail. Browser storage replaces the native keyring/SQLite; clearing site data removes drafts and pending work. Private blobs stay out of worker caches and are removed on logout/access withdrawal. Notifications work while a tab lives; closed-tab Web Push is absent. Audio/video/share permissions and capture choices belong to the browser.

Encrypted rooms, browser crypto enrolment/recovery and Rocket.Chat provider support are outside the accepted scope. Complete GTK visual parity remains under qualification; the DOM editor follows GTK's draft styling, selection and marker visibility.

## Licences

LiveKit browser transport is Apache-2.0. Original fonts and Adwaita assets include their licence files. The in-app Licences page also ships generated production dependency notices.
