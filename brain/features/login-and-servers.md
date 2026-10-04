# Login and servers

How a user signs in to a Rocket.Chat server (password, then a second factor when the server asks), how the session is kept and resumed, when it ends, and how several servers or accounts live side by side. Both apps follow the same server contract; they differ in where secrets live and in how many accounts one server may hold.

## The shared flow

1. **Probe.** Before any credential, the client reads two anonymous routes in parallel: `GET /api/info` (outside `/api/v1/`, it returns the minor version only, `8.5`, and proves the server is a Rocket.Chat) and `GET /api/v1/settings.public?count=0` (`count=0` disables paging). From the settings it learns whether the password form is offered (`Accounts_ShowFormLogin`), whether 2FA and E2EE are on, and which OAuth providers are configured. The server address is normalised first: `https://` is assumed when no scheme is typed, a trailing slash is dropped, and a sub-path (a server behind a proxy at `/chat`) is kept.
2. **Login.** `POST /api/v1/login` with `{user, password}`, sent anonymously. The answer carries `authToken`, `userId` and `me.username`. A body without token or user id is treated as a failure, not a session.
3. **Second factor.** When 2FA is required the server answers with a `totp-required` error whose `details.method` names what it wants: `totp`, `email` or `password`. The client does not guess the method; it reads it. The code is resent with the same login, in the `x-2fa-code` / `x-2fa-method` headers. For `email`, a `codeGenerated: false` flag means no mail left yet, so the client calls `users.2fa.sendEmailCode` first. For `password`, the expected code is the SHA-256 hex of the password, never the clear password.
4. **Resume.** The same `authToken` serves REST and the DDP socket (`method login {resume}`), so a stored session needs no new login at launch.
5. **End.** Only a 401 that is a real Rocket.Chat answer ends a session (see [rocket-chat.md](../architecture/rocket-chat.md) for why 401 is safe to trust and why `/api/v1/login` itself must be excluded). Sign-out sends `POST /logout` best effort: the local state is signed out whatever the server says.

## Mobile

**Screen.** `app/connexion.tsx` is a three-phase state machine (`Phase`: `serveur` (server) then `identifiants` (credentials) then `deuxFacteurs` (second factor)). The REST client lives inside the phase variants, so it exists exactly when a server was validated. A ref (`enVol`, in flight) guards re-entry: two events in the same frame (Enter key plus a tap) would otherwise send two logins and burn the same one-time TOTP code twice. The probe (`sonderServeur` in `lib/server.ts`) goes through `ClientRest` with the `horsApiV1` option, which gives it the maximal timeout; on a bare `fetch` a hanging proxy left the screen dead. When `Accounts_ShowFormLogin` is false the screen warns but does not block, since the API sometimes accepts a direct login anyway. The probe also records `Site_Url`, which the login answer lacks: it is merged into the persisted `Session.siteUrl` and later used to build quote permalinks (`lib/citation.ts`). Errors map to messages: a repeated `totp-required` on the same method or a `totp-invalid` means "code refused", a plain 401 means "credentials refused". The email method gets a "send the code" button, then a "resend" link.

**Default server.** `SERVEUR_PAR_DEFAUT` (`db/migrer.ts`) is `http://localhost:3000` in dev builds and `https://chat.barrut.me` otherwise; the field is pre-filled with the last server used unless the user already typed something.

**Storage.** `lib/sessionStore.ts` keeps everything in `expo-secure-store` (Android Keystore), never AsyncStorage. Key names are derived in `lib/clesStockage.ts`, isolated so tests can prove the isolation rules:

- the session is keyed by **server only**: `session-<first 32 hex of SHA-256(url)>` (Keystore keys accept only `[A-Za-z0-9._-]`). One account per server on mobile;
- the E2EE private key is keyed by **(server, account)** (`e2e-<hash of url|uid>`); an old server-only key is never read, only deleted at startup (`purgerToutesClesE2EHeritees`), because reading it re-imported one account's key for the next;
- `dernier-serveur` points at the session to resume, `serveurs-connus` lists every server that ever held a session (the Keystore cannot enumerate its keys);
- on iOS the entries are written `AFTER_FIRST_UNLOCK` so the notification service extension can read them with the phone locked.

`lireSession` treats corrupt or foreign entries as absent and migrates old shapes on read (`genre` defaults to `rocketchat`, `siteUrl` to null).

**Lifecycle.** `ui/session.tsx` (`SessionProvider`) exposes `EtatSession` (`demarrage` (starting), `deconnecte`, `connecte`). At launch it resumes **optimistically**: the stored session is declared connected at once and `reprendreSession` validates it in the background. An unreachable server keeps the session; only `estJetonRefuse` (a 401 with a Rocket.Chat envelope, not a 2FA challenge) signs out, and it also adopts a username changed elsewhere. Every client of the running app is made by `clientPour`, which wires `ClientRest.surJetonRefuse` so any call that meets a revoked token triggers `revoquer`. Two guards protect a fresh session from a late 401: the token in flight is compared with `jetonCourant`, and the Keystore is re-read before anything is erased. Sign-out unregisters the push token and calls `logout`; if either fails offline, the pair is queued (`ajouterDeconnexionEnSuspens`) and replayed at the next start by `terminerDeconnexions` (`lib/deconnexionDifferee.ts`), because the token is still alive server-side and keeping it is the only way to kill it. `effacerTraces` then removes the session, the E2EE key and the legacy key together. The per-account SQLite file is not removed by this path.

**Several servers.** Each server keeps its own session; the local database is per (server, account) (`db/nomFichier.ts`: `rocket-vibe-<host slug>-<uid>.db`). Settings has a "change server" link to `/connexion?changer=1`, which lists the known servers; tapping one calls `changerDeServeur`, which reads the target session before moving the resume pointer (so a server without a session never strands the user signed out) and validates it in the background. A notification deep link carrying `?host=` for another server lands on an explicit "switch to that server" screen in `app/salon/[rid].tsx` (`AutreServeur`) rather than switching silently. See [sharing-and-links.md](sharing-and-links.md).

## Desktop

**Core.** `rv-core/src/server.rs` (`probe`, `ServerProfile`) and `rv-core/src/session.rs` (`normalize_server`, `login`, `two_factor_code`, `request_email_code`) implement the same contract. `normalize_server` rejects input without a host. `SessionInfo` holds base URL, user id, username and token. `Session::start` opens the store, starts DDP with the token and spawns `watch_token`, which turns a token refusal from `RestClient::token_rejected` into `SessionEvent::Expired` only when the refused token is the session's own.

**GTK login.** `rv-gtk/src/login.rs` probes 600 ms after the server field stops changing (a generation counter drops stale answers) and shows one line: version, "2FA", "E2EE", or a warning when the password form is off. The code step adapts its caption to the method and masks input for `password`. `window.rs` drives it: `submit_login` keeps a `PendingLogin`, re-sends with the code, and when an email challenge reports no generated code it calls `request_email_code` on its own. There is no explicit resend button in the GTK code step. Errors map by status (0 unreachable, 401 bad code or rejected, 429 too many tries). The default server is `https://chat.barrut.me`, overridden by the `last-server` file.

**Storage.** `rv-gtk/src/secrets.rs` keeps one keychain item per **account** (`account_key` = `<base_url>|<user_id>`): Secret Service via `oo7` on Linux, Credential Manager or Keychain via the `keyring` crate elsewhere, with an index file because those cannot list items. Plain files under the config dir `rocket-vibe-rs/` hold the active account (`active-account`), the known servers (`servers`, most recent first, capped at 8) and `last-server`. Keychain calls time out after 5 s so a silent keyring cannot freeze the splash screen. The E2EE key (JWK) rides in the same item while unlocked. The database is `<host>[_port]-<uid>.sqlite` in the data dir (`database_path`).

**Several accounts.** Because the key includes the user id, desktop can hold two accounts on one server, which mobile cannot. Settings (`settings.rs`, `accounts_group`) lists every keychain account, switches on a click (`switch_to`) and offers "add account" (`add_account`), which keeps the current account as `previous` so the login page can cancel back to it. Sign-out removes the keychain item, sends `logout`, deletes the database files (`stop_session(true)`) and hands over to the next stored account if any. An expired session does the same and shows the login page with an "expired" message. `open_link` switches to the account whose server fits a link.

**SwiftUI (macOS).** `LoginView` and `RocketVibeKit/LoginModel.swift` repeat the GTK flow over `rv-ffi` (`Client.probe`, `login`, `requestEmailCode`). `rv-ffi/src/accounts.rs` stores accounts exactly where rv-gtk keeps them on macOS (same Keychain service, same files, same database names), so the two macOS apps share sessions. `AppModel` resumes the first account and falls back to the next on sign-out or expiry.

## Parity

[parity](../parity.md) §1 is done on desktop except email 2FA, which is partial: GTK and SwiftUI request the code automatically and have no resend control. Other differences worth knowing: mobile holds one account per server, desktop several; mobile keeps the database on sign-out, desktop deletes it (GTK the `.sqlite`, `-wal` and `-shm` files, SwiftUI only the `.sqlite`); mobile replays failed sign-outs at next launch, desktop does not (it has no push token to remove).

## Sources

- apps/mobile/app/connexion.tsx
- apps/mobile/app/parametres.tsx
- apps/mobile/app/salon/[rid].tsx
- apps/mobile/lib/auth.ts
- apps/mobile/lib/server.ts
- apps/mobile/lib/rest.ts
- apps/mobile/lib/sessionStore.ts
- apps/mobile/lib/clesStockage.ts
- apps/mobile/lib/deconnexionDifferee.ts
- apps/mobile/ui/session.tsx
- apps/mobile/db/nomFichier.ts
- apps/mobile/db/migrer.ts
- apps/desktop/crates/rv-core/src/server.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/rest.rs
- apps/desktop/crates/rv-gtk/src/login.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-gtk/src/secrets.rs
- apps/desktop/crates/rv-gtk/src/settings.rs
- apps/desktop/crates/rv-ffi/src/accounts.rs
- apps/desktop/macos/Sources/RocketVibeKit/LoginModel.swift
- apps/desktop/macos/Sources/RocketVibeKit/AppModel.swift
