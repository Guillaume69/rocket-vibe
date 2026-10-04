# Mobile app structure

How `apps/mobile` is layered: expo-router screens in `app/`, React glue and screen helpers in `ui/`, platform-free logic in `lib/`, SQLite in `db/`, and the server-specific driver behind the `fournisseurs/` facade. Also covers the two root providers (session, sync), the module-level stores, the theme and the native-components rule.

## The layers

```
app/            expo-router routes (screens and native sheets)
  |  read state from useSession() / useSynchro(), never name an endpoint
ui/             React components, hooks, module-level stores, screen logic
  |
fournisseurs/   creerFournisseur(session) -> Fournisseur (the facade)
  rocketchat/     the Rocket.Chat driver: traducteur, actions, historique
lib/            pure TypeScript: transport (rest, ddp), sync engine, outboxes,
                markdown, permissions, e2e... loadable and tested under Node
db/             schema, connection, write queue, SQL upserts, depots
```

- **`lib/` and `db/` must stay loadable by plain Node**, which strips types but cannot compile them. `eslint.config.js` forbids TypeScript parameter properties and `enum` there (`no-restricted-syntax`), because either emits code and Node then refuses the file, which kills the test suite. The only platform-bound module in the transport layer is `lib/sessionStore.ts` (expo-secure-store); `db/client.ts`, `db/depot.ts` and `db/migrer.ts` import expo-sqlite but the SQL they run lives in `db/upserts.ts`, which tests execute on `node:sqlite` (see [mobile-data.md](mobile-data.md)).
- **`ui/` is where platform code meets logic.** Many `ui/*.ts` files are pure and have tests (`sectionsAccueil`, `groupeMessages`, `barreNonLus`, `salonChaud`...); `.tsx` files are components. Pure helpers that need a platform hook take it by injection (for example `lib/profilPreload.ts` receives its navigator from `app/_layout.tsx` through `definirNavigateurProfil`, and its REST client from `SessionProvider` through `definirClientProfil`).
- **Screens never name a Rocket.Chat endpoint or stream for loading or subscribing.** They go through `synchro.fournisseur` (history, threads, per-room subscriptions), `synchro.actions` (react, edit, delete, pin...) and `synchro.capacites` (feature flags such as `typing`, `e2ee`, `appelVideo`, `recherche`, used to hide what a server cannot do). A few screens still call `ClientRest` directly for one-off reads (`rooms.info`, `users.info`, `spotlight`, `chat.search`).

## The provider facade (`fournisseurs/`)

`lib/fournisseur.ts` defines the neutral contract (`Fournisseur`, `Listener`, `Traducteur`, `ActionsFournisseur`, `Capacites`, `ChangementSync`). The sync core (`lib/sync.ts`, `MoteurSynchro`) only applies neutral `ChangementSync` values; each driver translates its own wire format into them. `fournisseurs/index.ts#creerFournisseur` switches exhaustively on `session.genre` (type `Genre`, today only `'rocketchat'`), so adding a member without a driver breaks compilation. `fournisseurs/rocketchat/index.ts` assembles the Rocket.Chat driver from the DDP client (the `Listener`), `traducteur.ts` (stream events and REST documents to neutral rows), `actions.ts` (message actions over `ClientRest`) and `historique.ts` (`chargerHistorique`, `chargerFil`). The design anticipates a Mattermost (kChat) driver; none exists. Sessions stored before `genre` existed are read back as `rocketchat` by `normaliserGenre`.

## Routes (`app/`)

expo-router file routes, `experiments.typedRoutes: true` in `app.json`. The root `Stack` is react-native-screens' native stack, so transitions and back gesture are the system's.

| Route | Role |
|---|---|
| `index.tsx` | Gatekeeper and room list. `demarrage` shows a splash, `deconnecte` redirects to `/connexion`, otherwise renders the list from live queries. |
| `connexion.tsx` | Login in three steps: server, credentials, second factor (`totp`, `email`, or `password` sent as SHA-256). |
| `salon/[rid].tsx` | A room: inverted FlashList over SQLite, composer, uploads. |
| `fil/[id].tsx` | A thread, `id` = root message `_id`; loaded whole by `chat.getThreadMessages`, no pagination. |
| `appel/[callId].tsx` | Jitsi call in a WebView, the single allowed WebView. |
| `actions-message.tsx`, `joindre.tsx`, `deverrouiller-e2e.tsx`, `salon-info.tsx`, `profil.tsx` | Native bottom sheets (`presentation: 'formSheet'`, `sheetAllowedDetents: 'fitToContents'`). |
| `partager.tsx` | Incoming share target (Android `ACTION_SEND`), presented as a modal. |
| `parametres.tsx`, `mon-profil.tsx` | Settings and own-profile editing (full pages, since they need a keyboard). |
| `recherche.tsx` | Start a conversation via `spotlight` (DM or join a channel). |
| `recherche-messages.tsx`, `messages-marques.tsx` | Message search in one room, pinned and starred lists. Both are ephemeral: rendered from the REST response, never written to SQLite. |
| `+native-intent.tsx` | Not a screen: swallows the iOS share extension's `rocketvibe://dataUrl=...` URL so expo-router does not show "page not found". |

Footgun: a sheet's `presentation` must be known when the native screen is created, so every `formSheet` is declared in `app/_layout.tsx` with `<Stack.Screen options>`, not from inside the screen (a later `setOptions` can be ignored). Screens guard themselves with `<Redirect href="/connexion" />` when the session is gone.

## The root tree (`app/_layout.tsx`)

Provider order, outermost first: `GestureHandlerRootView` > `SafeAreaProvider` > `ShareIntentProvider` (must wrap the rest: its native module reads the intent on first render; `resetOnBackground: false` so leaving the app does not drop a pending share) > `KeyboardProvider` > `SessionProvider` > `SynchroProvider` > `VisionneuseImageProvider` (one shared image-viewer Modal above the whole stack) > `Stack`. Siblings of the stack that render nothing or overlays: `GestionNotifications`, `SuiviIdentites`, `IndicateurOuvertureProfil`, `HoteToast`, `GardePartage` (pushes `/partager` once per incoming share intent). No database migration runs here: each database is migrated by whoever opens it, so an unrelated corrupt file cannot brick the app.

## Session state (`ui/session.tsx`)

`useSession()` exposes `etat`, a union `demarrage | deconnecte | connecte { session, client }`, plus `connecter`, `deconnecter`, `changerDeServeur`, `majProfilSession`.

- **Optimistic resume.** On launch the stored session for the last server (`lireDernierServeur`) is declared connected immediately; `reprendreSession` validates in the background. Only a real token refusal (`estJetonRefuse`, not a bare 401, because a proxy's HTML 401 must not sign anyone out) clears it. An unreachable server keeps the session.
- **One client factory.** `clientPour` is the single place a `ClientRest` is built, so token revocation (`surJetonRefuse` -> `revoquer`) is wired once for every call in the app.
- **Stale 401 guard.** `revoquer` compares against `jetonCourant` and re-reads the stored session before erasing, because storage is keyed by server: a late 401 for a replaced token must not wipe a fresh login on the same server.
- **Sign-out** unregisters the push token (read back from the Keystore, not re-requested), calls logout, queues whatever the network refused in `deconnexions-en-suspens` for replay at next launch (`lib/deconnexionDifferee.ts`), then `effacerTraces` erases session and E2EE private key together.
- Sessions are stored per server in the Keystore (`lib/sessionStore.ts`); see [../features/login-and-servers.md](../features/login-and-servers.md).

## Sync state (`ui/synchro.tsx`)

`useSynchro()` is `inactif | preparation | pret {...} | erreur`. When the session becomes `connecte`, `SynchroProvider` opens the per-(server, account) database, migrates it, builds `MoteurE2E`, `MoteurSynchro`, the text outbox (`envoi`), the file outbox (`fichiers`), presence and activity engines, restores custom emoji from SQLite, then switches to `pret` before any network work so the UI shows the cache offline. Network attachment (`lib/raccordement.ts`, driven by `Reconnecteur`) follows fire-and-forget. Only a broken local database yields `erreur`. Once per session after attachment it registers the push token, syncs custom emoji, reconciles rooms and applies retention.

`pret` carries `generation`, bumped on each successful attachment; screens that failed their first load offline put it in effect dependencies to retry. E2EE transitions refresh the context by object identity only, never by bumping `generation`, which would invalidate room caches and re-trigger expensive history loads. `declarerSalonOuvert` keeps a stack (`ui/salonsOuverts.ts`) of mounted room screens; only the top one is caught up. Transport details are in [mobile-transport.md](mobile-transport.md), sync behaviour in [../features/offline-and-sync.md](../features/offline-and-sync.md).

## Module-level stores and the purge rule

Cross-cutting state lives in module-level stores read with `useSyncExternalStore`, not in providers, because toggling a provider when the database becomes ready would remount the whole navigation tree. Examples: `ui/storeIdentites.ts` (`uid -> current username`, and avatar etags by uid and username; fed by `SuiviIdentites` from the `utilisateurs` table, see [../features/avatars.md](../features/avatars.md)), `ui/i18n.ts` (language), `ui/salonsCharges.ts`, `ui/filsCharges.ts`, `ui/salonChaud.ts`, `ui/etatNotifications.ts`, `ui/reponse.ts`.

Rule, enforced in the `SynchroProvider` cleanup: **every module store is purged at session end** (`oublierSalonsCharges`, `oublierFilsCharges`, `libererSalonsChauds`, `oublierReponses`, `oublierIdentites`, `oublierDisponibiliteAppel`, `oublierEtatNotifications`, `oublierFichesProfil`), otherwise one account's data leaks into the next. A stale avatar etag is the worst case: the URL does not change, so Android's image cache keeps serving the old photo. Purges also call `invaliderJetonSession` (`ui/jetonSession.ts`): screen cleanups run after the provider's, and a captured token lets them see their session is dead instead of repopulating a just-purged cache. Stores purged by `synchro` must be leaf modules (not import `synchro`), to avoid an import cycle whose resolution would depend on bundler order; that is why `storeIdentites.ts` is split from `identites.tsx`.

## Live queries

Screens read SQLite through `ui/requeteVive.ts#useRequeteVive`, a drop-in for drizzle's `useLiveQuery` that debounces (48 ms trailing window, capped by a maximum wait) and filters by table and database file. Reason: expo-sqlite's change listener fires once per row, so a 50-row batch re-rendered a list 50 times and, measured on a Pixel, stretched one transaction to about 8 s. Some comments still say `useLiveQuery`; they mean this wrapper.

## Theme (`ui/theme.ts`) and kit (`ui/kit.tsx`)

- Theme "Nuit Etoilee". Two full palettes, `couleursSombres` and `couleursClaires`, share the `Couleurs` interface. `useCouleurs()` always returns the dark one; `app.json` forces `userInterfaceStyle: "dark"` and `_layout.tsx` hard-codes `couleursSombres` for the navigation shell. Turning on system light/dark takes those three edits. Contract: no hard-coded colour in a component, every colour comes from a token.
- `POLICES`: Baloo 2 for titles, Nunito for body, loaded by the `expo-font` config plugin; names differ per platform (file name on Android, PostScript name on iOS).
- Shared constants: `DELAI_PRESSION_LISTE` (120 ms press delay on list rows so a scroll cancels the highlight), `largeurDispoCorps`, `degradeAvatar` (stable gradient per name).
- `ui/kit.tsx` holds the shared visual bricks built only on theme tokens and RN primitives: `BoutonPrincipal`, `Marque`, `TuileAvatar`, `AvatarSalon`, `BarreSynchro`, `IndicateurSaisie`, `BadgeNonLus`, `SeparateurJour`, `ChampPilule`. It is the project's own kit, not a UI library.

## The native-components rule

From `ROADMAP.md` §4.2 and `CLAUDE.md`: RN primitives first; level-1 native bindings (react-native-screens, safe-area-context, gesture-handler, expo-haptics) are allowed; named exceptions are `@shopify/flash-list`, `react-native-keyboard-controller`, `@rocket.chat/message-parser` and `react-native-webview` (only in `app/appel/[callId].tsx`). Forbidden: any UI kit (NativeBase, Tamagui, gluestack, RN Paper), any other WebView, `react-native-markdown-display`, `@gorhom/bottom-sheet`. Bottom sheets are react-native-screens `formSheet`; markdown is rendered in nested `<Text>` by `ui/markdown.tsx` from the server's `md` AST, with a local `@rocket.chat/message-parser` parse as fallback when `md` is missing (`lib/markdown.ts`). Any new UI dependency must be justified against §4.2 in its commit. Rationale: [../decisions.md](../decisions.md).

## Sources

- apps/mobile/app/_layout.tsx
- apps/mobile/app/index.tsx
- apps/mobile/app/+native-intent.tsx
- apps/mobile/app/salon/[rid].tsx
- apps/mobile/app/appel/[callId].tsx
- apps/mobile/app.json
- apps/mobile/eslint.config.js
- apps/mobile/fournisseurs/index.ts
- apps/mobile/fournisseurs/rocketchat/index.ts
- apps/mobile/fournisseurs/rocketchat/traducteur.ts
- apps/mobile/lib/fournisseur.ts
- apps/mobile/lib/sessionStore.ts
- apps/mobile/ui/session.tsx
- apps/mobile/ui/synchro.tsx
- apps/mobile/ui/identites.tsx
- apps/mobile/ui/storeIdentites.ts
- apps/mobile/ui/jetonSession.ts
- apps/mobile/ui/requeteVive.ts
- apps/mobile/ui/salonsOuverts.ts
- apps/mobile/ui/theme.ts
- apps/mobile/ui/kit.tsx
- ROADMAP.md
