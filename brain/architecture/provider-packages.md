# Provider packages (`packages/`)

The mobile app's provider code that does not need the app lives in npm packages beside it, the TypeScript counterpart of the desktop's provider crates ([shared-crates.md](shared-crates.md)). Back to [index.md](index.md).

## Layout

`packages/` is a root npm workspace (`package.json` at the repository root, `workspaces: ["packages/*"]`, its own `package-lock.json`). `apps/mobile` is NOT a member: it keeps its own `package-lock.json` and `node_modules`, and reaches the packages through the root `node_modules/@rocket-vibe/*` links, so a fresh clone runs `npm install` at the root as well as in `apps/mobile`.

| Package | What is in it |
|---|---|
| `@rocket-vibe/provider-api` | What a mobile provider codes against. Moved whole: the provider contract (`provider.ts`: `Provider`, `Listener`, `Translator`, `ProviderActions`, `Capabilities`, `SyncChange`, `ProviderKind`, `UploadHooks`, `ProfileParams`), the sync engine and its `Store` (`sync.ts`), `origin.ts`, `mediaAuth.ts`, `downloadResolver.ts`, the emoji table (`emojis.ts`, `emojis.generated.ts`). Types only, taken out of app modules that keep their runtime: the local rows (`rows.ts`: `LocalMessage`, `LocalRoom`, `LocalSubscription`), `ddp.ts` (`DdpEvent`, `DdpState`, `WebSocketLike`), `outbox.ts`, `uploads.ts` (with `ValidationError`, the refusal the app's file checks recognise), `crypto.ts`, `session.ts` (`Session`, `TokenRejection`), `calls.ts`, `presence.ts` and `typing.ts` (with their stream constants), `cards.ts`, `displayNames.ts`. `testing.ts` holds the in-memory `Store` provider tests ingest into. |
| `@rocket-vibe/provider-slack` | The Slack provider, formerly `apps/mobile/providers/slack/`, with its emoji names (`emojis.generated.ts`) and the photo cache it fills (`avatars.ts`). |
| `@rocket-vibe/provider-teams` | The Teams provider, formerly `apps/mobile/providers/teams/`. |
| `@rocket-vibe/provider-whatsapp` | The WhatsApp provider, formerly `apps/mobile/providers/whatsapp/`: frames, the projection into the store, file sending, the media and photo paths (`paths.ts`, formerly `lib/whatsappFiles.ts`) and the engine module's type (`native.ts`). |

Each package is TypeScript source, `"type": "module"`, exported by subpath (`"./*": "./src/*.ts"`, so `@rocket-vibe/provider-api/sync` is `src/sync.ts`; the provider packages also export their `index.ts` as `.`). Nothing is compiled: Metro, `tsc` and Node read the `.ts` files directly, through the symlink's real path (Node refuses to strip types under `node_modules`, and the real path is not there).

## The line

A package imports only `@rocket-vibe/provider-api`, its own files and Node or web built-ins (Slack uses `crypto` and `buffer`, aliased to quick-crypto in the app bundle like the app's own, [mobile-native.md](mobile-native.md)). The app keeps its old paths: `lib/sync.ts`, `lib/origin.ts`, `lib/mediaAuth.ts`, `lib/downloadResolver.ts` and `lib/emojis.ts` re-export the package modules, and the modules that lost types (`lib/normalize.ts`, `lib/ddp.ts`, `lib/outbox.ts`, `lib/uploadQueue.ts`, `lib/upload.ts`, `lib/auth.ts`, `lib/call.ts`, `lib/callRing.ts`, `lib/presence.ts`, `lib/typing.ts`, `lib/customEmojis.ts`, `lib/displayNames.ts`, `lib/integrationCards.ts`, `lib/e2e/crypto.ts`, `lib/profilePreload.ts`, `lib/whatsappFiles.ts`, `modules/whatsapp/index.ts`) re-export them. Module state (media leases, the download resolver, Slack photos) has one instance because every path resolves to the same real file.

`apps/mobile/lib/provider.ts` re-exports the contract and extends `Provider` with what only the app's own servers offer: the Vibez native runner (`native`), administration and reports (`admin`, `reports`), scheduled messages, Vibez's quote selections on `Outbox.send` (the contract types them `unknown`) and the Vibez file IO in `createUploadQueue`'s hooks. A package provider is assignable to it, those members being optional.

The providers take the session's token refusal as a `TokenRejection` (`{onTokenRejected}`), which the Rocket.Chat `RestClient` the app passes satisfies.

**WhatsApp** (`@rocket-vibe/provider-whatsapp`) drives the engine through `WhatsAppNative`, the local Expo module's interface, whose type lives in the package (`native.ts`) while the module itself (`apps/mobile/modules/whatsapp`) stays in the app and is handed to `createWhatsAppProvider`, with the app's error describer (`lib/providerError.ts`, which reads Vibez's transport errors). Unlinking drives the module, so it is app glue (`lib/whatsappUnlink.ts`); the test that the composer's quotes give the reply target back stays in the app with the quote format (`lib/whatsappReply.test.ts`). Rocket.Chat, Mattermost/kChat and Vibez stay in `apps/mobile/providers/`: they are the app's own drivers, tied to its REST client, DDP client, E2EE and database.

## Tooling

- **Metro** watches `packages/` and the root `node_modules` and also resolves from the root `node_modules` (`apps/mobile/metro.config.js`). `app.json` turns Expo's on-demand filesystem off (`experiments.onDemandFilesystem: false`): when exporting (`expo export`, the release build's `export:embed`) it drops every watch folder outside the app and reads only files under the server root, `apps/mobile`, so the packages were "not found". A checkout whose `node_modules` is a link to another one escapes that scope and hides the failure; a clean clone shows it.
- **`tsc`**: `apps/mobile/tsconfig.json` includes `../../packages/*/src/**/*.ts`, so `npx tsc --noEmit` in `apps/mobile` checks the packages and their tests.
- **Tests**: each package's `npm test` runs `node --test "src/**/*.test.ts"`; `npm test` at the root runs them all. The app's `npm test` no longer covers them.
- **Lint**: ESLint runs from `apps/mobile` and does not reach `packages/`. Node's type stripping still refuses an `enum` or a parameter property, which fails the package's tests.
- **CI**: `mobile.yml` triggers on `packages/**` and the root `package.json` / `package-lock.json`, runs `npm ci` at the root before the app's, and the root `npm test` after the app's checks; the APK job installs the root workspace before `expo prebuild`.
- **Generators**: `apps/mobile/scripts/generate-emojis.mjs` writes `packages/provider-api/src/emojis.generated.ts`, `scripts/generate-slack-emojis.mjs` writes `packages/provider-slack/src/emojis.generated.ts` (and the desktop's `crates/rv-slack/data/slack-emojis.tsv`).
- **Rocket.Chat inventory**: `scripts/inventory-rocketchat.mjs` and the pre-commit hook scan `packages/provider-api` (the sync engine's stream names); the Slack and Teams packages stay out, as `providers/slack` and `providers/teams` did, since Slack's method names look like Rocket.Chat's.

## Sources

- package.json
- packages/provider-api/package.json
- packages/provider-api/src/provider.ts
- packages/provider-api/src/sync.ts
- packages/provider-api/src/session.ts
- packages/provider-api/src/testing.ts
- packages/provider-slack/package.json
- packages/provider-slack/src/index.ts
- packages/provider-teams/src/index.ts
- apps/mobile/lib/provider.ts
- apps/mobile/metro.config.js
- apps/mobile/tsconfig.json
- apps/mobile/providers/index.ts
- packages/provider-whatsapp/src/index.ts
- packages/provider-whatsapp/src/native.ts
- apps/mobile/lib/whatsappUnlink.ts
- apps/mobile/modules/whatsapp/index.ts
- .github/workflows/mobile.yml
- scripts/inventory-rocketchat.mjs
