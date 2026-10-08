# Mobile app structure

How `apps/mobile` is layered: expo-router screens in `app/`, React glue and screen helpers in `ui/`, platform-free logic in `lib/`, SQLite in `db/`, and the server-specific driver behind the `providers/` facade. Also covers the two root providers (session, sync), the module-level stores, the theme and the native-components rule.

## The layers

```
app/            expo-router routes (screens and native sheets)
  |  read state from useSession() / useSync(), never name an endpoint
ui/             React components, hooks, module-level stores, screen logic
  |
providers/      createProvider(session) -> Provider (the facade)
  rocketchat/     the Rocket.Chat driver: translator, actions, history
  rocketvibe/     the RocketVibe server's driver (its own store and runner)
  mattermost/     the Mattermost and kChat driver
lib/            pure TypeScript: transport (rest, ddp), sync engine, outboxes,
                markdown, permissions, e2e... loadable and tested under Node
db/             schema, connection, write queue, SQL upserts, stores
```

- **`lib/` and `db/` must stay loadable by plain Node**, which strips types but cannot compile them. `eslint.config.js` forbids TypeScript parameter properties and `enum` there (`no-restricted-syntax`), because either emits code and Node then refuses the file, which kills the test suite. The only platform-bound module in the transport layer is `lib/sessionStore.ts` (expo-secure-store); `db/client.ts`, `db/store.ts` and `db/migrate.ts` import expo-sqlite but the SQL they run lives in `db/upserts.ts`, which tests execute on `node:sqlite` (see [mobile-data.md](mobile-data.md)).
- **`ui/` is where platform code meets logic.** Many `ui/*.ts` files are pure and have tests (`homeSections`, `messageGrouping`, `unreadBar`, `hotRooms`...); `.tsx` files are components. Pure helpers that need a platform hook take it by injection (for example `lib/profilePreload.ts` receives its navigator from `app/_layout.tsx` through `setProfileNavigator`, and its REST client from `SessionProvider` through `setProfileClient`).
- **Screens never name a Rocket.Chat endpoint or stream for loading or subscribing.** They go through `sync.provider` (history, threads, per-room subscriptions), `sync.actions` (react, edit, delete, pin...) and `sync.capabilities` (feature flags such as `typing`, `e2ee`, `videoCall`, `search`, used to hide what a server cannot do). A few screens still call `RestClient` directly for one-off reads (`rooms.info`, `users.info`, `spotlight`, `chat.search`).

## The provider facade (`providers/`)

`lib/provider.ts` defines the neutral contract (`Provider`, `Listener`, `Translator`, `ProviderActions`, `Capabilities`, `SyncChange`). The sync core (`lib/sync.ts`, `SyncEngine`) only applies neutral `SyncChange` values; each driver translates its own wire format into them. `providers/index.ts#createProvider` switches exhaustively on `session.kind` (type `ProviderKind`: `rocketchat`, `rocketvibe`, `mattermost`, `kchat`), so adding a member without a driver breaks compilation. `providers/rocketchat/index.ts` assembles the Rocket.Chat driver from the DDP client (the `Listener`), `translator.ts` (stream events and REST documents to neutral rows), `actions.ts` (message actions over `RestClient`) and `history.ts` (`loadHistory`, `loadThread`). Two optional members carry the server administration and reports (`Provider.admin`, a `ProviderAdmin`, and `Provider.reports`, a `ProviderReports`, both from `lib/admin.ts`), offered with `capabilities.administration` and `capabilities.reports`: `providers/rocketchat/admin.ts` and `providers/rocketvibe/admin.ts` map each server to the neutral model, so the `app/admin/` screens never name an endpoint ([../features/administration.md](../features/administration.md)). `providers/mattermost/` serves both `mattermost` and `kchat` through the same generic path as Rocket.Chat (`SyncEngine`, outbox, upload queue), with its own WebSocket or Pusher listener; RocketVibe has its own branch in `ui/sync.tsx`. The non-Rocket.Chat kinds get a `RestClient` answering 501 (`lib/sessionTransport.ts`) and the server-specific extras in `ui/sync.tsx` (push token, presence load, custom emoji, E2EE resume) are gated by `capabilities` or a provider hook (`loadPresence`, `listCustomEmojis`). See [mattermost-and-kchat](../features/mattermost-and-kchat.md). Sessions stored before `kind` existed are read back as `rocketchat` by `normalizeProviderKind`.

## Routes (`app/`)

expo-router file routes, `experiments.typedRoutes: true` in `app.json`. The root `Stack` is react-native-screens' native stack, so transitions and back gesture are the system's.

| Route | Role |
|---|---|
| `index.tsx` | Gatekeeper and room list. `starting` shows a splash, `disconnected` redirects to `/login`, otherwise renders the list from live queries. |
| `login.tsx` | Login in three steps: server, credentials, second factor (`totp`, `email`, or `password` sent as SHA-256). |
| `room/[rid].tsx` | A room: inverted FlashList over SQLite, composer, uploads. |
| `thread/[id].tsx` | A thread, `id` = root message `_id`; loaded whole by `chat.getThreadMessages`, no pagination. |
| `call/[callId].tsx` | Jitsi call in a WebView, the single allowed WebView. |
| `message-actions.tsx`, `attach.tsx`, `unlock-e2e.tsx`, `room-info.tsx`, `profile.tsx` | Native bottom sheets (`presentation: 'formSheet'`, `sheetAllowedDetents: 'fitToContents'`). |
| `share.tsx` | Incoming share target (Android `ACTION_SEND`), presented as a modal. |
| `settings/index.tsx`, `settings/[category].tsx`, `my-profile.tsx` | Settings: the list of categories, one full page per category, and own-profile editing (full pages, since they need a keyboard). See [../features/settings.md](../features/settings.md). |
| `admin/index.tsx`, `admin/moderation.tsx`, `admin/rooms.tsx`, `admin/users.tsx` | Server administration for an administrator: Dashboard, then Moderation, Rooms and Users (full pages). |
| `search.tsx` | Start a conversation via `spotlight` (DM or join a channel). |
| `message-search.tsx`, `marked-messages.tsx` | Message search in one room, pinned and starred lists. Both are ephemeral: rendered from the REST response, never written to SQLite. |
| `+native-intent.tsx` | Not a screen: swallows the iOS share extension's `rocketvibe://dataUrl=...` URL so expo-router does not show "page not found", and rewrites an old `rocketvibe://salon/<rid>` room link to `room/` (`lib/roomLink.ts#withEnglishRoomPath`). |

Footgun: a sheet's `presentation` must be known when the native screen is created, so every `formSheet` is declared in `app/_layout.tsx` with `<Stack.Screen options>`, not from inside the screen (a later `setOptions` can be ignored). Screens guard themselves with `<Redirect href="/login" />` when the session is gone.

## The root tree (`app/_layout.tsx`)

Provider order, outermost first: `GestureHandlerRootView` > `SafeAreaProvider` > `ShareIntentProvider` (must wrap the rest: its native module reads the intent on first render; `resetOnBackground: false` so leaving the app does not drop a pending share) > `KeyboardProvider` > `SessionProvider` > `SyncProvider` > `ImageViewerProvider` (one shared image-viewer Modal above the whole stack) > `Stack`. Siblings of the stack that render nothing or overlays: `NotificationHandler`, `IdentityTracker`, `ProfileOpeningIndicator`, `ToastHost`, `ShareGuard` (pushes `/share` once per incoming share intent). No database migration runs here: each database is migrated by whoever opens it, so an unrelated corrupt file cannot brick the app.

## Session state (`ui/session.tsx`)

`useSession()` exposes `state`, a union on `phase`: `starting | disconnected | connected { session, client }`, plus `connect`, `logOut`, `switchServer`, `updateSessionProfile`.

- **Optimistic resume.** On launch the stored session for the last server (`readLastServer`) is declared connected immediately; `resumeSession` validates in the background. Only a real token refusal (`isTokenRejected`, not a bare 401, because a proxy's HTML 401 must not sign anyone out) clears it. An unreachable server keeps the session.
- **One client factory.** `clientFor` is the single place a `RestClient` is built, so token revocation (`onTokenRejected` -> `revoke`) is wired once for every call in the app.
- **Stale 401 guard.** `revoke` compares against `currentToken` and re-reads the stored session before erasing, because storage is keyed by server: a late 401 for a replaced token must not wipe a fresh login on the same server.
- **Sign-out** unregisters the push token (read back from the Keystore, not re-requested), calls logout, queues whatever the network refused in `pending-logouts` for replay at next launch (`lib/deferredLogout.ts`), then `clearTraces` erases session and E2EE private key together.
- Sessions are stored per server in the Keystore (`lib/sessionStore.ts`); see [../features/login-and-servers.md](../features/login-and-servers.md).

## Sync state (`ui/sync.tsx`)

`useSync()` is a union on `phase`: `idle | preparing | ready {...} | error`. When the session becomes `connected`, `SyncProvider` opens the per-(server, account) database, migrates it, builds `E2EEngine`, `SyncEngine`, the text outbox (`outbox`), the file outbox (`files`), presence and activity engines, restores custom emoji from SQLite, then switches to `ready` before any network work so the UI shows the cache offline. Network attachment (`lib/connectionSetup.ts`, driven by `Reconnector`) follows fire-and-forget. Only a broken local database yields `error`. Once per session after attachment it registers the push token, syncs custom emoji, reconciles rooms and applies retention.

`ready` carries `generation`, bumped on each successful attachment; screens that failed their first load offline put it in effect dependencies to retry. E2EE transitions refresh the context by object identity only, never by bumping `generation`, which would invalidate room caches and re-trigger expensive history loads. `declareOpenRoom` keeps a stack (`ui/openRooms.ts`) of mounted room screens; only the top one is caught up. Transport details are in [mobile-transport.md](mobile-transport.md), sync behaviour in [../features/offline-and-sync.md](../features/offline-and-sync.md).

## Module-level stores and the purge rule

Cross-cutting state lives in module-level stores read with `useSyncExternalStore`, not in providers, because toggling a provider when the database becomes ready would remount the whole navigation tree. Examples: `ui/identityStore.ts` (`uid -> current username`, and avatar etags by uid and username; fed by `IdentityTracker` from the `users` table, see [../features/avatars.md](../features/avatars.md)), `ui/i18n.ts` (language), `ui/loadedRooms.ts`, `ui/loadedThreads.ts`, `ui/hotRooms.ts`, `ui/notificationState.ts`, `ui/reply.ts`, `ui/emojiUsage.ts` (the account's emoji usage store for quick reactions, a plain slot because memoised rows count a use too), `ui/adminAccess.ts` (the administrator verdict, kept per provider object and session generation in a `WeakMap`, so an account switch never shows another account the admin screens).

Rule, enforced in the `SyncProvider` cleanup: **every module store is purged at session end** (`forgetLoadedRooms`, `forgetLoadedThreads`, `releaseHotRooms`, `forgetReplies`, `forgetIdentities`, `forgetCallAvailability`, `forgetNotificationState`, `forgetProfileCards`, and the release returned by `mountEmojiUsage`), otherwise one account's data leaks into the next. A stale avatar etag is the worst case: the URL does not change, so Android's image cache keeps serving the old photo. Purges also call `invalidateSessionToken` (`ui/sessionToken.ts`): screen cleanups run after the provider's, and a captured token lets them see their session is dead instead of repopulating a just-purged cache. Stores purged by `sync` must be leaf modules (not import `sync`), to avoid an import cycle whose resolution would depend on bundler order; that is why `identityStore.ts` is split from `identities.tsx`.

## Live queries

Screens read SQLite through `ui/liveQuery.ts#useCoalescedLiveQuery`, a drop-in for drizzle's `useLiveQuery` that debounces (48 ms trailing window, capped by a maximum wait) and filters by table and database file. Reason: expo-sqlite's change listener fires once per row, so a 50-row batch re-rendered a list 50 times and, measured on a Pixel, stretched one transaction to about 8 s. Some comments still say `useLiveQuery`; they mean this wrapper.

## Theme (`ui/theme.ts`) and kit (`ui/kit.tsx`)

- Theme "Nuit Etoilee". Two full palettes, `darkColors` and `lightColors`, share the `Colors` interface. `useColors()` always returns the dark one; `app.json` forces `userInterfaceStyle: "dark"` and `_layout.tsx` hard-codes `darkColors` for the navigation shell. Turning on system light/dark takes those three edits. Contract: no hard-coded colour in a component, every colour comes from a token.
- `FONTS`: Baloo 2 for titles, Nunito for body, loaded by the `expo-font` config plugin; names differ per platform (file name on Android, PostScript name on iOS).
- Shared constants: `LIST_PRESS_DELAY` (120 ms press delay on list rows so a scroll cancels the highlight), `availableBodyWidth`, `avatarGradient` (stable gradient per name).
- `ui/kit.tsx` holds the shared visual bricks built only on theme tokens and RN primitives: `PrimaryButton`, `Brand`, `AvatarTile`, `RoomAvatar`, `SyncBar`, `TypingIndicator`, `UnreadBadge`, `DaySeparator`, `PillField`. It is the project's own kit, not a UI library.

## The native-components rule

From `ROADMAP.md` §4.2 and `CLAUDE.md`: RN primitives first; level-1 native bindings (react-native-screens, safe-area-context, gesture-handler, expo-haptics) are allowed; named exceptions are `@shopify/flash-list`, `react-native-keyboard-controller`, `@rocket.chat/message-parser` and `react-native-webview` (only in `app/call/[callId].tsx`). Forbidden: any UI kit (NativeBase, Tamagui, gluestack, RN Paper), any other WebView, `react-native-markdown-display`, `@gorhom/bottom-sheet`. Bottom sheets are react-native-screens `formSheet`; markdown is rendered in nested `<Text>` by `ui/markdown.tsx` from the server's `md` AST, with a local `@rocket.chat/message-parser` parse as fallback when `md` is missing (`lib/markdown.ts`). Any new UI dependency must be justified against §4.2 in its commit. Native dialogs follow the click-outside rule: every `Alert.alert` takes `dismissible()` (`ui/alerts.ts`: `cancelable`, the dismissal running what Cancel runs), and sheets close on a tap outside; an action that finishes after its sheet closed must not navigate back again. Rationale: [../decisions.md](../decisions.md).

## Sources

- apps/mobile/app/_layout.tsx
- apps/mobile/app/index.tsx
- apps/mobile/app/+native-intent.tsx
- apps/mobile/lib/roomLink.ts
- apps/mobile/app/room/[rid].tsx
- apps/mobile/app/call/[callId].tsx
- apps/mobile/app.json
- apps/mobile/eslint.config.js
- apps/mobile/providers/index.ts
- apps/mobile/providers/rocketchat/index.ts
- apps/mobile/providers/rocketchat/translator.ts
- apps/mobile/providers/rocketchat/admin.ts
- apps/mobile/providers/rocketvibe/admin.ts
- apps/mobile/lib/admin.ts
- apps/mobile/app/settings/index.tsx
- apps/mobile/app/admin/index.tsx
- apps/mobile/lib/provider.ts
- apps/mobile/lib/sessionStore.ts
- apps/mobile/ui/session.tsx
- apps/mobile/ui/sync.tsx
- apps/mobile/ui/identities.tsx
- apps/mobile/ui/identityStore.ts
- apps/mobile/ui/sessionToken.ts
- apps/mobile/ui/emojiUsage.ts
- apps/mobile/ui/adminAccess.ts
- apps/mobile/ui/liveQuery.ts
- apps/mobile/ui/openRooms.ts
- apps/mobile/ui/theme.ts
- apps/mobile/ui/kit.tsx
- ROADMAP.md
- apps/mobile/ui/alerts.ts
