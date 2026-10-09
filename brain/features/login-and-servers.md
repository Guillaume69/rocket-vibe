# Login and servers

How a user signs in to a Rocket.Chat server (password, then a second factor when the server asks), how the session is kept and resumed, when it ends, and how several servers or accounts live side by side. Both apps follow the same server contract; they differ in where secrets live and in how many accounts one server may hold.

## The shared flow

0. **Server type.** Under the address, a selector offers Automatic (the default), Rocket.Chat or RocketVibe. Automatic asks `/.well-known/rocketvibe` first and treats only a 2xx naming the product as RocketVibe; any other answer (404, or the 403 of a proxy that forbids `/.well-known/`, as on chat.barrut.me) falls through to the Rocket.Chat probe below. Rocket.Chat skips the native discovery; RocketVibe requires it and never falls back ("no RocketVibe server at this address"). Changing the choice probes again. Core: `ServerKind`, `native::probe_as`, `server::probe_as`, `session::login_as` (`rv-core`); `ServerChoice` over `rv-ffi` (`Client.probe`, `login`, `is_native_server`); mobile `discoverServer(..., kind)` and `NotRocketVibeError` (`lib/serverKind.ts`).
1. **Probe.** Before any credential, the client reads two anonymous routes in parallel: `GET /api/info` (outside `/api/v1/`, it returns the minor version only, `8.5`, and proves the server is a Rocket.Chat) and `GET /api/v1/settings.public?count=0` (`count=0` disables paging). From the settings it learns whether the password form is offered (`Accounts_ShowFormLogin`), whether 2FA and E2EE are on, and which OAuth providers are configured. The server address is normalised first: `https://` is assumed when no scheme is typed, a trailing slash is dropped, and a sub-path (a server behind a proxy at `/chat`) is kept.
2. **Login.** `POST /api/v1/login` with `{user, password}`, sent anonymously. The answer carries `authToken`, `userId` and `me.username`. A body without token or user id is treated as a failure, not a session.
3. **Second factor.** When 2FA is required the server answers with a `totp-required` error whose `details.method` names what it wants: `totp`, `email` or `password`. The client does not guess the method; it reads it. The code is resent with the same login, in the `x-2fa-code` / `x-2fa-method` headers. For `email`, a `codeGenerated: false` flag means no mail left yet, so the client calls `users.2fa.sendEmailCode` first. For `password`, the expected code is the SHA-256 hex of the password, never the clear password.
4. **Resume.** The same `authToken` serves REST and the DDP socket (`method login {resume}`), so a stored session needs no new login at launch.
5. **End.** Only a 401 that is a real Rocket.Chat answer ends a session (see [rocket-chat.md](../architecture/rocket-chat.md) for why 401 is safe to trust and why `/api/v1/login` itself must be excluded). Sign-out sends `POST /logout` best effort: the local state is signed out whatever the server says.

## Mobile

**Screen.** `app/login.tsx` is a three-phase state machine (`Phase`: `server`, then `credentials`, then `twoFactor`). The REST client lives inside the phase variants, so it exists exactly when a server was validated. A ref (`inFlight`) guards re-entry: two events in the same frame (Enter key plus a tap) would otherwise send two logins and burn the same one-time TOTP code twice. The probe (`probeServer` in `lib/server.ts`) goes through `RestClient` with the `outsideApiV1` option, which gives it the maximal timeout; on a bare `fetch` a hanging proxy left the screen dead. When `Accounts_ShowFormLogin` is false the screen warns but does not block, since the API sometimes accepts a direct login anyway. The probe also records `Site_Url`, which the login answer lacks: it is merged into the persisted `Session.siteUrl` and later used to build quote permalinks (`lib/quote.ts`). Errors map to messages: a repeated `totp-required` on the same method or a `totp-invalid` means "code refused", a plain 401 means "credentials refused". The email method gets a "send the code" button, then a "resend" link.

**Default server.** `DEFAULT_SERVER` (`db/migrate.ts`) is `http://localhost:3000` in dev builds and `https://chat.barrut.me` otherwise; the field is pre-filled with the last server used unless the user already typed something.

**Storage.** `lib/sessionStore.ts` keeps everything in `expo-secure-store` (Android Keystore), never AsyncStorage. Key names are derived in `lib/storageKeys.ts`, isolated so tests can prove the isolation rules:

- the session is keyed by **server only**: `session-<first 32 hex of SHA-256(url)>` (Keystore keys accept only `[A-Za-z0-9._-]`). One account per server on mobile;
- the E2EE private key is keyed by **(server, account)** (`e2e-<hash of url|uid>`); an old server-only key is never read, only deleted at startup (`purgeAllLegacyE2EKeys`), because reading it re-imported one account's key for the next;
- `last-server` points at the session to resume, `known-servers` lists every server that ever held a session (the Keystore cannot enumerate its keys), `device-push-token` remembers the FCM token for sign-out and `pending-logouts` queues interrupted sign-outs (each entry's token under `pushToken`);
- these fixed key names are `STORED_KEYS` in `lib/storageKeys.ts`. Before migration 0016 they had French names (`dernier-serveur`, `serveurs-connus`, `jeton-push-appareil`, `deconnexions-en-suspens`); `readMovedKey` moves a value still under its old name on first read, writing the new key before deleting the old, so an upgrade keeps the session pointer, the server list and pending sign-outs. A pending-logout entry written with the old field `jetonPush` is still read;
- on iOS the entries are written `AFTER_FIRST_UNLOCK` so the notification service extension can read them with the phone locked.

`readSession` treats corrupt or foreign entries as absent and migrates old shapes on read (`kind`, formerly `genre` and still read under that name, defaults to `rocketchat`; `siteUrl` to null).

**Lifecycle.** `ui/session.tsx` (`SessionProvider`) exposes `SessionState` (`phase`: `starting`, `disconnected`, `connected`). At launch it resumes **optimistically**: the stored session is declared connected at once and `resumeSession` validates it in the background. An unreachable server keeps the session; only `isTokenRejected` (a 401 with a Rocket.Chat envelope, not a 2FA challenge) signs out, and it also adopts a username changed elsewhere. Every client of the running app is made by `clientFor`, which wires `RestClient.onTokenRejected` so any call that meets a revoked token triggers `revoke`. Two guards protect a fresh session from a late 401: the token in flight is compared with `currentToken`, and the Keystore is re-read before anything is erased. Sign-out unregisters the push token and calls `logout`; if either fails offline, the pair is queued (`addPendingLogout`) and replayed at the next start by `finishPendingLogouts` (`lib/deferredLogout.ts`), because the token is still alive server-side and keeping it is the only way to kill it. `clearTraces` then removes the session, the E2EE key and the legacy key together. The per-account SQLite file is not removed by this path.

**Several servers.** Each server keeps its own session; the local database is per (server, account) (`db/fileName.ts`: `rocket-vibe-<host slug>-<uid>.db`). Settings has a "change server" link to `/login?change=1`, which lists the known servers; tapping one calls `switchServer`, which reads the target session before moving the resume pointer (so a server without a session never strands the user signed out) and validates it in the background. A notification deep link carrying `?host=` for another server lands on an explicit "switch to that server" screen in `app/room/[rid].tsx` (`OtherServer`) rather than switching silently. See [sharing-and-links.md](sharing-and-links.md).

**Server rail.** The home screen draws a column down its left edge (`ui/serverRail.tsx`, in `app/index.tsx`): a tile per known server that still has a session (`listKnownServers` then `readSession`), the open one outlined, then "+" to `/login?change=1`. A tile shows the server's own icon when it has one (`lib/serverIcon.ts`, see Server icon below), else the host's initial. A tap calls `switchServer`. Settings > Accounts can hide the column (`ui/serverRailSetting.ts`, SecureStore `hide-server-rail`, off by default); the page's Change server link then stays the way to switch or add a server, and the other servers' unread dots are not read. Only the open server is connected; while the home screen is focused and the app in the foreground, each other server is read once a minute and at each return to the foreground: `subscriptions.get` for Rocket.Chat, `GET /api/v1/rooms` after `prepareNativeSession` (which renews the token under its lease) for RocketVibe, judged by `lib/accountUnread.ts` (the desktop rule: an open subscription with unread or an alert; a read state with `readBadges(..).alert`). A token refused there never signs anything out. A push for another server that reaches JS (`setNotificationHandler`, so iOS in the foreground) lights the dot at once through `ui/serverDots.ts`; Android message pushes are posted by our Kotlin service and never reach JS, so there the dot waits for the next read.

**Server icon.** Read without signing in for every account of the rail, once per server and app session (each visit would cost an anonymous `settings.public`, rate limited per address), with a 10 s timeout, and again after an administrator changed it here (`forgetServerIcon`): Rocket.Chat's `favicon_192` asset when an administrator set one (`settings.public?_id=Assets_favicon_192`, `value.url`; only `defaultUrl` means the stock logo, which is not the server's own), its URI carrying the time of that read as `?rv=` (ignored by the server) because Rocket.Chat serves it at a fixed URL with no ETag; RocketVibe's instance icon at `/api/v1/instance/icon?v=<icon_revision>` from the discovery document. Mattermost and kChat keep the initial. `serverIconUri` answers a URI, `null` (no icon: the initial) or `undefined` when the read concluded nothing (unreachable, refused), and then the rail keeps the icon it shows. Changing it is administration ([administration](administration.md#server-icon)).

## Desktop

**Core.** `rv-core/src/server.rs` (`probe`, `ServerProfile`) and `rv-core/src/session.rs` (`normalize_server`, `login`, `two_factor_code`, `request_email_code`) implement the same contract. `normalize_server` rejects input without a host. `SessionInfo` holds base URL, user id, username and token. `Session::start` opens the store, starts DDP with the token and spawns `watch_token`, which turns a token refusal from `RestClient::token_rejected` into `SessionEvent::Expired` only when the refused token is the session's own.

**GTK login.** `rv-gtk/src/login.rs` probes 600 ms after the server field stops changing (a generation counter drops stale answers) and shows one line: version, "2FA", "E2EE", or a warning when the password form is off. The code step adapts its caption to the method and masks input for `password`. `window.rs` drives it: `submit_login` keeps a `PendingLogin`, re-sends with the code, and when an email challenge reports no generated code it calls `request_email_code` on its own. There is no explicit resend button in the GTK code step. Errors map by status (0 unreachable, 401 bad code or rejected, 429 too many tries). The default server is `https://chat.barrut.me`, overridden by the `last-server` file.

**Storage.** `rv-gtk/src/secrets.rs` keeps one keychain item per **account** (`account_key` = `<base_url>|<user_id>`): Secret Service via `oo7` on Linux, Credential Manager or Keychain via the `keyring` crate elsewhere, with an index file because those cannot list items. Plain files under the config dir `rocket-vibe-rs/` hold the active account (`active-account`), the known servers (`servers`, most recent first, capped at 8) and `last-server`. Keychain calls time out after 5 s so a silent keyring cannot freeze the splash screen. The E2EE key (JWK) rides in the same item while unlocked. The database is `<host>[_port]-<uid>.sqlite` in the data dir (`database_path`).

**Several accounts.** Because the key includes the user id, desktop can hold two accounts on one server, which mobile cannot. Settings (`settings.rs`, `accounts_group`) lists every keychain account, switches on a click (`switch_to`) and offers "add account" (`add_account`), which keeps the current account as `previous` so the login page can cancel back to it. Sign-out removes the keychain item, sends `logout`, deletes the database files (`stop_session(true)`) and hands over to the next stored account if any. An expired session does the same and shows the login page with an "expired" message. `open_link` switches to the account whose server fits a link.

**Server rail.** `rv-gtk/src/rail.rs` puts a column left of the chat page (`window.rs` wraps the chat widget with it): a tile per keychain account, the open one outlined in pink, "+" (`add_account`), and a yellow dot on an account with unread messages. `refresh_rail` rebuilds it after every session start. A tile shows the server's own icon when it has one (`rv_core::server_icon::fetch`, the same rule as mobile), read on each rebuild and kept between rebuilds so it does not flicker; `rail::reload_icons` reads them again after the administration changed one. A read gives `server_icon::Icon`: `Image` (a PNG or JPEG recognised by its first bytes, whatever the `Content-Type`, at most 2 MiB however long the response), `Absent` (the initial) or `Unknown` (unreachable, refused, too big, not an image), which keeps the shown icon. GTK decodes it at most 88 px wide (`rail::icon_texture`, twice the tile). SwiftUI reads them into `AppModel.serverIcons` with the account list over rv-ffi `Client.serverIcon`, which returns the same three cases (`enum ServerIcon`; `.unknown` keeps the entry). Every 60 s it reads each account that is not open with `rv_core::account_unread` (`subscriptions.get`, or the native rooms' read states after `credentials::Provider::resume`); a failure leaves the dot as it was, an answer about an older account list is dropped (`generation`). SwiftUI repeats it in `ChatView.swift` (`ServerRail`) over `Client.accountUnread` (`rv-ffi/src/native.rs`) and `AppModel.pollAccounts`. Settings > Accounts can hide the rail ("Hide the server bar", off by default): GTK `Rail::set_hidden` and SwiftUI `AppModel.setRailHidden` share the file `hide-server-rail` in the config dir, whose presence hides it; the accounts list of that page still switches and adds. SwiftUI keeps the account refresh and the minute poll in `ChatView`, not in the rail, so that list stays fresh with the rail hidden.

**SwiftUI (macOS).** `LoginView` and `RocketVibeKit/LoginModel.swift` repeat the GTK flow over `rv-ffi` (`Client.probe`, `login`, `requestEmailCode`). `rv-ffi/src/accounts.rs` stores accounts exactly where rv-gtk keeps them on macOS (same Keychain service, same files, same database names), so the two macOS apps share sessions. `AppModel` resumes the first account and falls back to the next on sign-out or expiry.

## Parity

[parity](../parity.md) §1 is done on desktop except email 2FA, which is partial: GTK and SwiftUI request the code automatically and have no resend control. Other differences worth knowing: mobile holds one account per server, desktop several; mobile keeps the database on sign-out, desktop deletes it (GTK the `.sqlite`, `-wal` and `-shm` files, SwiftUI only the `.sqlite`); mobile replays failed sign-outs at next launch, desktop does not (it has no push token to remove).

## Sources

- apps/mobile/app/login.tsx
- apps/mobile/ui/settingsSections.tsx
- apps/mobile/app/room/[rid].tsx
- apps/mobile/lib/auth.ts
- apps/mobile/lib/server.ts
- apps/mobile/lib/rest.ts
- apps/mobile/lib/sessionStore.ts
- apps/mobile/lib/storageKeys.ts
- apps/mobile/lib/deferredLogout.ts
- apps/mobile/ui/session.tsx
- apps/mobile/ui/serverRail.tsx
- apps/mobile/ui/serverDots.ts
- apps/mobile/lib/accountUnread.ts
- apps/mobile/db/fileName.ts
- apps/mobile/db/migrate.ts
- apps/desktop/crates/rv-core/src/server.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/rest.rs
- apps/desktop/crates/rv-gtk/src/login.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-gtk/src/secrets.rs
- apps/desktop/crates/rv-gtk/src/settings.rs
- apps/desktop/crates/rv-gtk/src/rail.rs
- apps/desktop/crates/rv-core/src/account_unread.rs
- apps/desktop/macos/Sources/RocketVibe/ChatView.swift
- apps/desktop/crates/rv-ffi/src/accounts.rs
- apps/desktop/macos/Sources/RocketVibeKit/LoginModel.swift
- apps/desktop/macos/Sources/RocketVibeKit/AppModel.swift
- apps/mobile/lib/serverIcon.ts
- apps/mobile/ui/serverRailSetting.ts
- apps/desktop/crates/rv-core/src/server_icon.rs
- apps/desktop/crates/rv-ffi/src/native.rs
