# React browser client

The browser UI uses React 19, strict TypeScript and Vite. The native server still embeds the committed production bundle. There is no Node production service, external UI kit or change to the single-origin, single-account contract.

## Ownership

`src/main.ts` mounts one React root. `ui/application.tsx` selects login or the connected shell. `ui/state.ts` exposes the controller's view through `useSyncExternalStore`; a screen replacement has a distinct mount identity, while live updates preserve connected controls.

`ui/login.tsx`, `rooms.tsx`, `messages.tsx`, `thread.tsx`, `profile.tsx`, `sidebar.tsx`, `admin-dashboard.tsx` and `voice.tsx` own their presentation. Stable message/file/provider keys retain editor, audio, video and iframe state through live revisions. Markdown is rendered as React nodes with a depth limit and safe-link checks, never arbitrary HTML. Both ordinary and encrypted threads share a component, with different draft/send adapters.

`app.ts` retains the tested transport, model, session, read acknowledgments, outbox and upload lifecycle. React rendering does not authorize a request: account, room-opening and membership fences still apply before and after asynchronous work. The crypto worker and Rust MLS implementation are unchanged by the UI migration. Private plaintext stays out of ordinary model snapshots, drafts and outboxes.

`ui/portals.tsx` attaches secondary views to the same root and context. It preserves live sidebar subpages across push/pop and releases their components when the owning dialog closes. `ui/dialog.tsx` uses native modal dialogs; `ui/menu.tsx` uses native popovers with React contents. Native dismissal and focus semantics remain browser responsibilities.

## Adapter boundaries

The rich contenteditable editor retains its DOM selection, composition, undo and GTK span adapter. React mounts it and disposes its listeners, rather than controlling its editable children. LiveKit media tracks, image/viewer widgets and the call grid retain bounded DOM hosts. Replacing connected media nodes during a live revision would destroy playback or browsing contexts.

Existing settings, security, bot, workflow and room-management controllers can populate a sidebar page host. Their shared entry/select/switch controls render through React, but the remaining page builders still create native form/list containers. This is an explicit compatibility boundary, not a claim that every former DOM builder has been rewritten. Subsequent component extraction must keep the same account guards and one-time-secret lifetimes.

The GTK CSS, font files, icons, emoji, sound files, strings and decorative-star generator remain the visual source. React adds no design system or new settings. Browser rasterization and OS media consent still differ from GTK. Existing parity debts remain in `WEB_CLIENT_EXECUTION.md` and `brain/parity.md`.

## Validation

Build and format checks, the Node lifecycle/network tests and the complete existing real-server browser gate apply to the React bundle. The gate includes ordinary and encrypted conversations, actual microphone/camera/share RTP, media retention, security/factors, session renewal, offline queues, workflows, unread state, profile actions and GTK-derived visual geometry. The embedded server must be rebuilt after the bundle; Vite development mode does not qualify offline service-worker behavior.

Use isolated fixture accounts and keep profiles, caches and Docker mounts in the test workspace. The GTK interoperability test runs the real desktop application in its Fedora environment against the same local server. Browser suites must finish before source edits, HMR or server restarts.

## Sources

- apps/web/src/main.ts
- apps/web/src/ui/application.tsx
- apps/web/src/ui/portals.tsx
- apps/web/src/composer.ts
- apps/web/src/app.ts
- apps/web/src/crypto/chat.ts
- apps/web/src/voice.ts
- .github/workflows/web-client.yml
