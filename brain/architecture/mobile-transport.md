# Mobile transport

How the mobile app talks to the server: a listen-only DDP client, a defensive REST client, a reconnection driver with backoff, and a connection sequence ("raccordement") that orders the two transports so nothing falls between them. All of it is pure TypeScript with injected sockets, clocks and `fetch`, so it is tested under Node against real HTTP servers rather than mocks.

The server-side contract these modules rely on is in [rocket-chat.md](rocket-chat.md); what the data does once it lands is in [../features/offline-and-sync.md](../features/offline-and-sync.md).

## Who owns what

| Module | Role |
|---|---|
| `apps/mobile/lib/ddp.ts` | `ClientDdp`: WebSocket, DDP handshake, `login`, ref-counted subscriptions, silence watchdog and liveness probe |
| `apps/mobile/lib/rest.ts` | `ClientRest`: timeouts, 429 retries, one network retry, envelope checks, 2FA, token-rejected hook |
| `apps/mobile/lib/reconnexion.ts` | `Reconnecteur` (reconnection driver): exponential backoff with jitter, idempotent trigger, suspend / resume |
| `apps/mobile/lib/raccordement.ts` | `raccorder` (connect): runs the stream and the REST catch-up in the order that leaves no gap |
| `apps/mobile/lib/deconnexionDifferee.ts` | `terminerDeconnexions`: replays a logout the network interrupted |
| `apps/mobile/ui/synchro.tsx` | `SynchroProvider`: wires all of the above to the session, `AppState` and the database |
| `apps/mobile/ui/session.tsx` | session lifecycle, resume validation, revocation on a rejected token |
| `apps/mobile/ui/sondeUpload.ts` | a hook that probes the socket right after an upload ends |

The Rocket.Chat driver (`apps/mobile/fournisseurs/rocketchat/index.ts`) builds the `ClientDdp` on `<baseUrl with ws/wss>/websocket` and declares which streams to subscribe; `ui/synchro.tsx` drives it without naming Rocket.Chat.

## DDP client (`lib/ddp.ts`)

States: `ferme` (closed), `connexion` (negotiating), `connecte` (handshake done, `login` pending), `authentifie` (logged in). `connecter(authToken)` opens the socket, sends `connect` (version `1`), waits for `connected`, then calls `login` with `{resume: authToken}`, the REST token. Every wait (handshake, `login`, `sub`, probe) has a 10 s timeout (`delaiMs`).

**Subscriptions are desired state, not wire state.** `souscrire(name, key)` is synchronous and works in any state: it records the intent in `desirees` (keyed `name|key`) and returns a release function. On every successful authentication the client replays all desired subscriptions, so the first connection and every reconnection use the same path. Entries are reference-counted: two screens observing the same room produce one `sub` on the wire (duplicates would make the server send every event twice). A `sub` in flight is shared (`enVol`); one released while negotiating gets its `unsub` as soon as `ready` arrives. A `nosub` leaves the entry desired, retried at the next login. `reinitialiser()` forgets everything, used only at logout.

**`souscriptionsArmees()`** resolves when every desired subscription has been answered (`ready`, `nosub`, or the socket died). It never rejects. It is the exact signal that the stream now covers: a REST read started after it cannot miss anything.

**Server pings and `error` frames.** The client answers the server's `ping` with `pong` (echoing the `id`), or the server drops the socket. A `msg: 'error'` frame (an out-of-sequence message, such as a `ping` before `connect`) carries `offendingMessage.id`; the client rejects that one wait instead of letting it hang until its timeout. Only `changed` frames become events (`{collection, cleEvenement, args}`); a listener that throws does not stop the others.

**Liveness.** A socket can die without `onclose` ever firing: the server's FIN leaves the OS socket in CLOSE-WAIT and nothing reaches JS. This was reproduced on the emulator after an attachment upload, with four sockets in CLOSE-WAIT and no message received afterwards. Rocket.Chat 8.5 pings every 30 s (first ping 15 s after `connected`), so the watchdog (every 15 s) treats 45 s of silence as a lost ping and sends its own `ping`; only a missing `pong` closes the socket. `verifierVie()` refuses to probe during negotiation (a ping before `connect` gets `Must connect first`, never a pong) but does probe in `connecte`, which pongs.

**Teardown.** `nettoyer()` is idempotent (a socket dying during `login` reaches it twice), detaches the old socket's handlers, rejects every pending wait and the in-flight handshake at once, forgets wire ids but keeps desired subscriptions, and fires `surPerte` (connection lost) only if the close was not voluntary. Each socket's handlers check `this.ws === ws`, because a closed socket's `onclose` often arrives after a new one opened.

## REST client (`lib/rest.ts`)

`ClientRest` imports nothing from React Native. Headers: `X-Auth-Token` / `X-User-Id` unless the call is `anonyme`, plus `x-2fa-code` / `x-2fa-method` when a 2FA code is supplied.

- **Timeout 15 s** for every call, `/api/info` included (`horsApiV1` drops the `api/v1/` prefix without escaping the timeout).
- **429**: up to three retries, sleeping until `x-ratelimit-reset` plus 250 ms (exponential otherwise) plus up to 500 ms jitter, capped at 30 s. The sleep listens to the caller's `AbortSignal`, so cancelling does not wait out the backoff.
- **Network failure** (no HTTP response): `ErreurRest` with `statut: 0`. Only callers that set `rejeuReseau` (idempotent writes: profile, status) get one replay after 400 ms; it covers OkHttp reusing a dead keep-alive connection after idle time. `chat.sendMessage` never sets it, its dedup lives in the outbox.
- **Body**: read as text first, so an HTML page with a 200 is "non-JSON", not "unreachable". An empty 200 body is success (`logout`). 2FA is detected in both forms (`error` or `errorType` = `totp-required`) and raised as `ErreurDeuxFacteurs`.
- **Errors** carry `reponseComprise`, true only when the body has the Rocket.Chat envelope.

**Session death.** `estJetonRefuse(e)` is the only predicate allowed to log the user out: status 401, not a 2FA challenge, envelope understood. When it holds on a non-anonymous call, `ClientRest` calls `surJetonRefuse(tokenSent)` with the token captured before the request left. `ui/session.tsx` (`revoquer`) ignores it if that token is no longer current, re-reads the stored session in case a new login wrote a fresh token under the same key, then erases the session traces and returns to the login screen, without calling `logout` (the token is already dead). This covers every call in the app (catch-up, `chat.syncMessages`, sends, presence) without touching call sites; before it, a token revoked elsewhere left the app looking like it had a network problem forever. Session resume at startup (`reprendreSession`) is anonymous because the token travels in the body, so it applies `estJetonRefuse` itself; any other failure keeps the session.

## Reconnection driver (`lib/reconnexion.ts`)

`Reconnecteur` wraps one `connecter` function (the whole raccordement). Delays: 0 for the first attempt, then 1 s, 2 s, 4 s... capped at 30 s, with "equal jitter" (half fixed, half random) so clients cut by the same incident do not retry together.

- `declencher()` (trigger) is idempotent: a no-op if an attempt is scheduled; if one is in flight, the request is remembered and replayed when it ends. Without that, a socket lost during an otherwise successful attempt would be swallowed.
- A failed attempt increments the backoff and re-triggers; a success resets it.
- `suspendre()` (background) disarms the scheduled timer and blocks any re-trigger; `reprendre()` (foreground) lifts the block and resets the backoff, so the user's return costs no wait. `arreter()` (logout, unmount) is final.

## Raccordement (`lib/raccordement.ts`)

The order of the two transports decides what can be lost. A REST read evaluated before the subscriptions are armed can miss what the server publishes in between, and it has already advanced the cursors, so nothing asks again. `raccorder` therefore does two reads:

1. **Immediately**, without waiting for the socket: what the user sees. Sequencing it behind DDP once cost 17 s (up to two minutes) between returning to the app and seeing an already-posted message.
2. **After `souscriptionsArmees()`**: the read that guarantees. It waits for the server's `ready`, never for a delay.

The second read is skipped when the stream was already authenticated at the start (the first read then started after arming). The `ensuite` callback (outbox flush, presence, one-per-session work) runs once after the first read. A stream failure is surfaced only at the end, so the backoff still applies but the user got their messages first. `estAbandonne` stops everything once the session is gone.

In `ui/synchro.tsx`, `ouvrirStream` connects only if the socket is `ferme`: after a REST-only failure the socket is still authenticated and `connecter` would throw "already connected".

## Lifecycle wiring (`ui/synchro.tsx`)

- Startup: database opened and migrated, then state `pret` (ready) so the UI shows SQLite at once, even offline. The initial streams are declared before any connection; the first raccordement goes through the same `Reconnecteur`, so an offline launch retries on its own.
- `surPerte` invalidates presence (it lives only on the stream) and triggers the driver.
- **Background**: `suspendre()` then `ddp.fermer()` (voluntary, so no reconnection), presence invalidated. Android would kill the socket anyway under Doze, and each reconnection in background would cost a rate-limited catch-up. Desired subscriptions survive.
- **Foreground**: `reprendre()`, a liveness probe if the socket still claims to be open, then `declencher()`.
- **After any upload** (attachment or avatar, same transport `ui/transportUpload.ts`), `signalerFinUpload()` probes the socket at once instead of waiting 45 s for the watchdog.
- Each successful raccordement bumps `generation`, which screens use as "the connection held since then" (see [../features/offline-and-sync.md](../features/offline-and-sync.md)).
- Unmount (logout, server switch): stop the driver first, then close and reset DDP, release hot rooms, purge every module-level store.

## Interrupted logout (`lib/deconnexionDifferee.ts`)

Logging out is two server calls: `DELETE push.token` then `POST logout`, in that order since `logout` kills the token the delete needs. Offline, both fail silently and the server keeps pushing to a device with no account. `ui/session.tsx` queues the entry (base URL, uid, auth token, FCM token) in secure storage (`ajouterDeconnexionEnSuspens` in `lib/sessionStore.ts`), and `terminerDeconnexions` replays it at the next start. The entry is removed when both calls succeed, or when the server rejects the token (nothing left to kill); a network failure keeps it. A 404 on `push.token` counts as done. Keeping a live auth token is deliberate: it is the only way to kill it.

## Footguns

- Do not call `ddp.connecter` on a non-closed client; check `etat === 'ferme'`.
- Do not hand-roll a delay to "wait for the stream": use `souscriptionsArmees()`.
- Do not test `statut === 401` to log out; use `estJetonRefuse`, and never on an anonymous call.
- Do not keep a subscription's wire id across a reconnection; hold the release function from `souscrire`.
- `fermer()` alone does not stop the driver; suspend or stop it first.

## Sources

- apps/mobile/lib/ddp.ts
- apps/mobile/lib/rest.ts
- apps/mobile/lib/reconnexion.ts
- apps/mobile/lib/raccordement.ts
- apps/mobile/lib/deconnexionDifferee.ts
- apps/mobile/lib/auth.ts
- apps/mobile/lib/sessionStore.ts
- apps/mobile/lib/pushToken.ts
- apps/mobile/lib/presence.ts
- apps/mobile/fournisseurs/rocketchat/index.ts
- apps/mobile/ui/synchro.tsx
- apps/mobile/ui/session.tsx
- apps/mobile/ui/sondeUpload.ts
- apps/mobile/ui/transportUpload.ts
- CLAUDE.md
