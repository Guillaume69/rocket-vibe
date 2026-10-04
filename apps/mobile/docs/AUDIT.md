# AUDIT: state of the codebase

*Survey of July 25, 2026, on `b7a73f1`. 141 files, 27,300 lines.*

Produced by a fan-out audit: 14 reviewers (10 per subsystem, 4 cross-cutting), each high or critical finding then put before an adversarial refuter instructed to demolish it. **122 raw findings, 7 refuted, 115 kept.**

The rule that governed the ranking is *zero regression*: a workstream with high gain and no risk comes before one with medium gain and high risk.

State of reference at the survey date: `tsc` exits 0, 460 tests pass, `eslint` reports 24 errors, analysed and dismissed (see "Do not touch").

---

## The overall state

The codebase is in good health, and that is a judgement, not a courtesy: tsc exits 0, 460 tests pass, all the SQL lives in a single file and runs as is on a migrated `node:sqlite`, the in-house DDP client correctly handles reference counting, the survival of wanted subscriptions across a drop and the ordering of the connection setup on a signal rather than a delay, and the comments almost always explain the WHY of a counter-intuitive choice, often backed by a measurement (the 3-4 s of `chat.syncMessages?type=UPDATED` on the target server, the absence of ETag on `/avatar`, the view-tree NPE when launching a picker). I found no write corruption, no unparameterised query, no committed secret, and practically no `setTimeout` used as a synchronisation crutch. The defects are therefore not in the algorithms: they are at the JOINTS and in the LIFECYCLES. Three patterns recur everywhere. (1) What is created with the session is not destroyed: the decrypted E2EE private key survives logout and is not even keyed per account, the SQLite database with the E2E plaintexts stays on disk, five module-level stores are never purged, the catch-up cursors outlive the messages they describe, and the room purge knows only three tables out of eight. (2) The same invariant is guarded in one place and not in the other: the anti-stacking guard of the catch-up lives in the provider but the screen calls the same function directly, the URL scheme guard exists in the markdown but not in the link cards, the write queue protects three stores but not the drafts, the 401 is handled on cold start and nowhere else. (3) The FILE path received none of the three scars the TEXT path acquired (no client identifier, no confirmation after failure, no optimistic object), hence both a risk of duplicates and a silent disappearance. Only one finding is critical, and it is verified: the `rc_token` goes into Chrome's address bar as soon as you tap a "file" attachment. Finally, EXECUTION.md, designated source of truth, is 110 commits behind.

---

## The workstreams, in the recommended order of attack

| # | Workstream | Max severity | Fix risk | Effort | Findings |
|---|---|---|---|---|---|
| 1 | The one-line batch: local, verified fixes with near-zero regression | 🟠 high | low | hours | 9 |
| 2 | One write queue per SQLite CONNECTION (with the drafts in it) | 🟡 medium | low | hours | 3 |
| 3 | Zero secrets outside the process | 🔴 critical | medium | day | 4 |
| 4 | What enters the database must be right: normalisation, previews, E2EE keys | 🟡 medium | low | day | 6 |
| 5 | Room catch-up: one per room, caches that do not lie | 🟡 medium | medium | day | 5 |
| 6 | Lifecycle of local data: purge, cursors, retention | 🟡 medium | medium | day | 4 |
| 7 | Upload queue: no duplicate, no silent disappearance | 🟠 high | medium | several days | 7 |
| 8 | DDP and REST transport: do not kill a healthy socket, do not sleep without listening | 🟡 medium | medium | day | 6 |
| 9 | Dead session and end of session: back to login, and take everything when leaving | 🟠 high | HIGH | day | 5 |
| 10 | Native push: duplicates, multi-server deep link, service hygiene | 🟠 high | medium | several days | 8 |
| 11 | Screens: unbounded loops, fixed waits, needless native costs | 🟡 medium | low | day | 9 |
| 12 | A test net where the code cannot be reached | 🟡 medium | none | day | 5 |
| 13 | A single source per concept: i18n, colours, formats, MIME tables | 🟡 medium | low | day | 6 |
| 14 | Structural duplication and splitting the room screen | 🟡 medium | medium | several days | 7 |
| 15 | The Provider facade: whatever names Rocket.Chat must go through it | 🟡 medium | medium | day | 4 |
| 16 | Bring the documentation back in line with the code | 🟡 medium | none | hours | 2 |

### 1. The one-line batch: local, verified fixes with near-zero regression

**Max severity** 🟠 high · **fix risk** low · **effort** hours

Seven defects, two of them high severity, are each fixed in three lines or fewer, in a single file, without touching a shared path. Today they cost: no notifications at all for the session when Play Services answer badly at the first connection setup, a full history reload on every E2EE toggle, user text destroyed, photos posted twice, an empty action sheet across a whole encrypted room. Given the watchword (zero regression), this batch comes before everything else: immediate gain, tiny surface, and two of them (the E2E generation, the upload guard) unblock later workstreams.

#### 🟠 high: A failure to obtain the FCM token still arms the flag: no notifications at all for the whole session

`ui/sync.tsx:333` · ✅ verified · fix risk: low

Verified in the code: `registeredPushToken = true` is set BEFORE the call, and `getFcmToken()` (lib/push.ts:22-45) NEVER rejects: its internal catch returns `{ok:false, reason:'failed'}`. The `.then((r) => (r.ok ? registerToken(...) : undefined))` therefore goes through without a rejection, the `.catch` that disarms the flag never fires, and the token is never posted again for the session. Yet the comment just above promises "a failure will be retried at the next connection setup".

**Fix.** Handle the RESULT and not only the rejection: `if (!r.ok) { if (r.reason === 'failed') registeredPushToken = false; return; }`. Do NOT disarm on `permission-denied`: that would replay the system prompt at every connection setup.

#### 🟡 medium: `generation` is bumped by E2EE transitions, which restarts history and catch-up without any connection having been lost

`ui/sync.tsx:211` · ✅ verified · fix risk: low

Verified: `refreshE2E` does `{...s, generation: s.generation + 1}` only to force a re-render, whereas `generation` is the validity criterion of `ui/loadedRooms.ts` and `ui/hotRooms.ts` ("did the connection hold?") and a dependency of the opening effects of app/room/[rid].tsx:495 and app/thread/[id].tsx:197. On startup on an account whose key is in the Keystore, `e2e.resume()` is enough to trigger a full `channels.history?count=50` plus a `chat.syncMessages` (3-4 s for zero documents on a large room), for zero new data.

**Fix.** One line: `setSync((s) => (s.phase === 'ready' ? { ...s } : s))`. The re-render comes from the change of IDENTITY of the context value (`useContext` compares with `Object.is`), not from the counter's value. A named variant if a future memoisation is feared: a separate `revisionE2E` field.

#### 🟡 medium: Text typed DURING an upload is erased at the end of the send: an 8.7 fix was lost

`app/room/[rid].tsx:813` · ✅ verified · fix risk: low

The `.then` of the attachment branch does `setDraft('')` + `clearDraft()` + `cancelReply(rid)` unconditionally, whereas the TextInput stays editable throughout the upload (only 📎/➤/🎤 are greyed out). Commit 781bc19 had fixed precisely this with a functional update ("what was typed during the send is neither the caption that went out, nor to be thrown away", recorded in EXECUTION.md §8.7); commit 30e1c85 replaced it with a blunt clear. `clearDraft()` also destroys the persisted row: the text cannot be recovered on returning to the room.

**Fix.** Keep a `draftRef` up to date in an effect and only settle if `draftRef.current === draft` (the text captured at the tap). Group `cancelReply(rid)` under the same guard. Bring EXECUTION.md:324 back in line with the code.

#### 🟡 medium: Share screen: a validation refusal mid-loop resends the attachments already sent

`app/share.tsx:217` · ✅ verified · fix risk: low

`shareTo` loops `for … await files.send(...)`; a `ValidationError` (size/type refused) exits the loop, the catch shows the error and releases the locks, but `attachments` is never trimmed of what already went out. The user removes the faulty attachment, taps the room again: the first two photos are posted a second time.

**Fix.** Remove the attachment from the state on each successful iteration (`setAttachments(prev => prev.filter(x => x.key !== p.key))`, and clear the caption once it has gone). The loop iterates the captured array, so removing from the state does not disturb it. Side benefit: visible progress.

#### 🟡 medium: The action sheet opens EMPTY on every message of an encrypted room and on every system message

`lib/messageActions.ts:46` · ✅ verified · fix risk: low

`possibleActions` returns an empty array as soon as `systemType !== null`. Yet an encrypted message keeps `systemType = 'e2e'` even AFTER decryption (db/upserts.ts:29 only fills `text`), and ui/messageRow.tsx:229 nonetheless renders it like an ordinary message. On `p:laprivitude` (the only encrypted room on the target) and on all system rows (`uj`, `ul`, `rm`), the long press vibrates, the sheet rises and shows a 30 px strip without a word.

**Fix.** (1) An explicit fallback in app/message-actions.tsx when `actions.length === 0` (key `messageActions.noActions` in BOTH catalogues: ui/messages.test.ts checks parity). (2) Reopen `react`/`delete`/`pin` for a DECRYPTED encrypted message (`systemType === 'e2e' && text !== null`), excluding `edit` (chat.update posts plaintext) and `reply`. (3) Replace the dead test at lib/messageActions.test.ts:76-80 with the three real cases.

#### ⚪ low: The search error message survives clearing the field

`app/search.tsx:84` · ✅ verified · fix risk: none

Verified: the `clean === ''` branch does `setResults({}); return;` without touching `message`. The red banner "Recherche impossible." ("Search failed.") stays displayed above an empty list. The twin branch in app/message-search.tsx:77-81 does do `setMessage(null)`: the two screens, written on the same idiom, have diverged.

**Fix.** Add `setMessage(null);` in the empty branch.

#### 🟡 medium: The share screen shows room avatars without their `avatarETag`: photo frozen for life by the Fresco cache

`app/share.tsx:361` · not put to the refuter · fix risk: low

`RoomAvatar` declares `avatarEtag` OPTIONAL (ui/kit.tsx:212). app/index.tsx:242 and app/room/[rid].tsx:1247 pass it, app/share.tsx does not (nor `encryptedUnlocked`). `avatarUrl` then adds no `?etag=`, and CLAUDE.md describes exactly this trap: `/avatar/room/<rid>` answers `max-age=3600` without an HTTP `ETag`, Fresco freezes the URI for life.

**Fix.** Pass `avatarEtag={room.avatarEtag}` and `encryptedUnlocked`. Then make `avatarEtag` REQUIRED (`string | null`) in `RoomAvatar`'s props so that tsc flags any future omission.

#### 🟡 medium: From a DM's card, "Message" stacks a SECOND copy of the room already open

`app/profile.tsx:196` · not put to the refuter · fix risk: medium

The stack is `[index, room/A, profile]`; `im.create` being idempotent, the button returns the same rid then does `router.replace`, which always creates a new route key. Two instances of the room screen then live on the same rid: two `markRead` timers (hence two `subscriptions.read` on a route limited to 10/min), two `signalerSalonActif`, two typing listeners, two FlashLists. And a back press seems to do nothing.

**Fix.** `router.navigate({ pathname: '/room/[rid]', params: { rid } })`: react-navigation pops back to the existing screen carrying the same params.

#### 🟡 medium: `openProfileCard` has no reentrancy guard: a double tap stacks two cards

`lib/profilePreload.ts:104` · not put to the refuter · fix risk: low

The function waits up to 2 s (`CAP_MS`) plus 400 ms of anti-flash before `router.push('/profile')`, and nothing is locked meanwhile: `ProfileOpeningIndicator` is mounted with `pointerEvents="none"`. Two taps → two `push` → two sheets to close. `setBusy` being a global boolean, the `finally` of the first run turns off the indicator while the second is still in flight. The rest of the repo uses an `inFlight` ref for this pattern (app/message-actions.tsx:175, app/search.tsx:70, app/profile.tsx:123).

**Fix.** A module lock `ouvertureEnCours` tested at the top and released in the `finally`, or a counter of runs in flight that also drives `setBusy`. A state guard, no added delay.

---

### 2. One write queue per SQLite CONNECTION (with the drafts in it)

**Max severity** 🟡 medium · **fix risk** low · **effort** hours

This is the most dangerous race in the repo (two concurrent `BEGIN`s on the same connection, which db/store.ts:64-76 documents as fatal: "cannot rollback - no transaction is active", batch silently cancelled), and its fix fits in two lines in db/client.ts, verified, with no behaviour change on the nominal path. Unbeatable gain/risk ratio: do it right away, all the more so since it makes harmless the rebuild of the sync engine on a mere rename, which can then be left as is.

#### 🟡 medium: A username change rebuilds the whole sync and creates a SECOND write queue on the same SQLite connection

`ui/sync.tsx:424` · ✅ verified · fix risk: low

The effect of `SyncProvider` depends on the `state` OBJECT (l.424); `updateSessionProfile` (ui/session.tsx:190-200, called after a rename) and the resume on startup produce a new object for the same server, the same account, the same token. The effect therefore replays in full and creates a `createWriteQueue()` (l.159), whereas `openDatabase` memoises the connection per file (db/client.ts:23-42) and `closeDatabase` is never called. Two independent queues then serialise on a single connection, while the in-flight writes of the old engine (history, outbox, uploads) come back from the network.

**Fix.** Make the CONNECTION carry the queue: `const pair = { raw, base: drizzle(...), writeQueue: createWriteQueue() }` in the `open` Map of db/client.ts, and `const { base, raw, writeQueue } = openDatabase(...)` in ui/sync.tsx (remove the local call, the only caller of `createWriteQueue`). A strict no-op in the nominal case; in case of overlap, the two engines serialise instead of interleaving.

#### 🟡 medium: Drafts write outside the queue, hence inside the sync transactions

`ui/drafts.ts:60` · not put to the refuter · fix risk: low

`useDraft.write` builds a Drizzle `insert().onConflictDoUpdate()` / `delete()` and runs it directly on the shared connection, outside the `WriteQueue`: the only write path in the repo that does so, and the only SQL that does not live in db/upserts.ts (so no test runs it). expo-sqlite's `withTransactionAsync` is NOT exclusive (node_modules/expo-sqlite/build/SQLiteDatabase.js:99): the 400 ms debounce that fires during the ingestion of a 50-message page makes the INSERT enter the batch's `BEGIN`, and a failure of the batch cancels the draft without anyone knowing. Both outcomes of the promise are swallowed on top of that (l.70).

**Fix.** `createDraftStore(raw, serially)` in db/store.ts with `UPSERT_DRAFT` / `DELETE_DRAFT` in db/upserts.ts (hence covered by db/upserts.test.ts), supplied to `useDraft` in place of the raw `LocalDatabase`.

#### ⚪ low: `useCoalescedLiveQuery` does not filter events by database, and the connections of visited accounts are never closed

`ui/liveQuery.ts:79` · not put to the refuter · fix risk: low

expo-sqlite's `addDatabaseChangeListener` is global to all open databases, but the listener only compares `tableName` and ignores `databaseName`. The filtering is correct only thanks to the invariant, written nowhere, that a single database is alive, an invariant that `closeDatabase` (db/client.ts:45, no caller) precisely does not guarantee: each (server, account) pair visited leaves a connection open with its change listener active.

**Fix.** Add the `databaseName` test to the listener, and document explicitly in db/client.ts that connections are kept for the life of the process (do NOT call `closeDatabase` in a cleanup, see "Do not touch").

---

### 3. Zero secrets outside the process

**Max severity** 🔴 critical · **fix risk** medium · **effort** day

A Rocket.Chat `rc_token` is worth the whole account (reading every room, sending, changing the profile), and today it goes into Chrome's address bar (hence into its history, synced to the Google account) as soon as you tap a "file" attachment. It is the only critical finding of the whole audit, and it is verified. The three other leaks of the workstream (unguarded URL scheme, call WebView without an origin lock, unvalidated push host) share the same invariant: what leaves the process must be chosen by us, not by the content received. Local fixes, no touching of the sync or the database.

#### 🔴 critical: The authentication token is handed to the system browser when a "file" attachment is opened

`ui/messageRow.tsx:561` · ✅ verified · fix risk: medium

Verified in the code: the `title_link` branch does `protectedFileUrl(client, attachment.title_link)` (which sticks `rc_uid` and `rc_token` in the query, lib/upload.ts:136-141) then `Linking.openURL(url)`, a VIEW intent. The full URL, token included, lands in Chrome, its history and its sync, and is offered to any application that declares it handles https. Yet ui/imageViewer.tsx states the opposite invariant at the top of the file, and both the image and the video respect it by keeping the URL in memory. Only this branch leaves the process; nothing in ROADMAP.md justifies the exception.

**Fix.** Download with `expo-file-system/legacy` (already a dependency) then open the LOCAL file through `expo-sharing` (the module sets up its own FileProvider, no config plugin). Sanitise the destination name (`[A-Za-z0-9._-]`, refuse `..` and `/`: it comes from someone else). Do NOT switch to `X-Auth-Token` headers: the protected-files middleware authenticates by query/cookie, so that would be a 403 disguised as a fix. An acceptable stopgap if expo-sharing is not to be shipped right away: disable opening when `client.auth !== null`. Lock it down with a test: no string containing `rc_token` must ever reach `Linking.openURL`.

#### 🟡 medium: A link preview card opens the server's URL without a scheme guard, whereas the markdown sets one

`ui/linkCard.tsx:159` · not put to the refuter · fix risk: low

`Linking.openURL(preview.url)` on a string that comes as is from `message.urls`, stored raw (lib/normalize.ts:159) and projected without scheme validation (lib/linkPreview.ts:172 only tests `typeof === 'string'`). ui/markdown.tsx:32-37 handles exactly the same class of data and sets `/^https?:\/\//i` with the comment "javascript:, intent:, file: remain dead letters". Same hole on `isImage` (l.73-80), which lets a `file:///…jpg` display in the feed. lib/linkPreview.test.ts has no non-http scheme case.

**Fix.** Extract the guard from ui/markdown.tsx into `lib/externalLink.ts` and call it from linkCard.tsx, embedCard.tsx and the file branch of messageRow.tsx. Also filter at the source in lib/linkPreview.ts (only emit a preview if `url` and `image` are https?), with the matching test case.

#### 🟡 medium: The call WebView grants camera and microphone to any https origin

`app/call/[callId].tsx:188` · not put to the refuter · fix risk: low

The app holds CAMERA and RECORD_AUDIO while the WebView runs (`requestCameraMic`, l.38-41), so react-native-webview answers `onPermissionRequest` without a prompt whatever the origin. Yet navigation filtering is purely scheme-based (`/^(https?|about|blob|data):/i`) with `originWhitelist={['*']}`: any redirect to an arbitrary https is followed, and the page can open camera and microphone silently. The WebView exception is assumed; it is not confined to the host the server designated.

**Fix.** Extract `new URL(u).origin` from the URL returned by `joinConference`, keep it in the state, allow only that origin plus `about:blank` in `onShouldStartLoadWithRequest`, and set `originWhitelist={[origin]}`. The nominal case (a single origin for the whole conference) is not affected.

#### 🟡 medium: The token goes to the host named by the push payload when only one session is known, without host verification

`plugins/with-fcm-deeplink.js:601` · not put to the refuter · fix risk: low

`readSession(ctx, host)` returns the only known session when no `baseUrl` matches the host (`if (nbCandidats == 1) repli`). Yet `host` comes entirely from the FCM payload (l.219 and 262), is validated nowhere, and `fetchContent` (l.656-663) builds `URL(host + "/api/v1/push.get?...")` and sets `X-User-Id` and `X-Auth-Token` on it. The comment aims at tolerance of URL SHAPE; the implementation accepts any domain. An actor able to send to the device's FCM token exfiltrates the session token outside any JS runtime, without a trace.

**Fix.** Compare on the HOST alone (scheme + authority of `session.baseUrl` vs that of `host`), ignoring sub-path and trailing slash (which covers the tolerance sought), and return `null` otherwise, logging the rejection. Requires `expo prebuild` + rebuild; ship it with the native push workstream to pay for a single build.

---

### 4. What enters the database must be right: normalisation, previews, E2EE keys

**Max severity** 🟡 medium · **fix risk** low · **effort** day

Five defects that write wrong data into SQLite, hence durable data, since the UI is only a projection: a correspondent's username replaced by mine in the `users` table, a room's preview erased by a video call message, an encrypted preview that shows an invisible thread reply, a room AES key never invalidated on rotation. All the fixes are local to pure functions or to static SQL, hence testable without a device, and lib/normalize.ts (through which 100 % of server documents pass) has today only three tests, on the `callId`. High gain, low risk: do it early.

#### 🟡 medium: `toRoom` guesses the other party's username by excluding `me`: if `me` is stale, the correspondent's uid receives MY username

`lib/normalize.ts:238` · ✅ verified · fix risk: low

Verified: `names.find((u) => u !== me) ?? (names.length === 1 ? names[0] : null)` never tests that `me` actually appears in `usernames`. `me` is `session.username`, frozen at the construction of `RcTranslator`: after a rename from the web (or with `username: ''`, lib/auth.ts:114), the `find` keeps the first element, which is me one time out of two. The result goes straight into the database: db/store.ts:123-128 runs `UPSERT_IDENTITY(dmOtherUid, dmOtherUsername)`, and this upsert has NO timestamp guard. Bob then shows under my username and with my avatar, in SQLite, until he posts a message.

**Fix.** Only pair by exclusion if the exclusion is proven: `const iAmIn = me !== null && me !== '' && names.includes(me);` then return `null` when we do not know. No cost: `UPSERT_ROOM` writes nothing on null (db/store.ts:123) and the avatar will be set at the first message.

#### 🟡 medium: The room list preview is ERASED when the last message has neither text nor attachment (video call message)

`lib/normalize.ts:179` · not put to the refuter · fix risk: low

`lastMessagePreview` returns `null` when `msg` is empty and no attachment speaks, which is exactly the shape of the `t: 'videoconf'` message whose content lives in `blocks` (handled l.160). Yet since 07411d9, `last_message` is no longer protected by COALESCE (db/upserts.ts:84-87): `null` deliberately means "room emptied" and overwrites. The room rises to the top of the list (the timestamp, for its part, is COALESCEd l.92) but without a line of text.

**Fix.** Add a last fallback deriving a label from the system type (video call → i18n key), and tell the two `null`s apart: "no `lastMessage` at all" (legitimate erasure) vs "last message without displayable text". Pin the three cases in lib/normalize.test.ts.

#### ⚪ low: An encrypted room's preview can show a thread reply or a system message never visible in the room

`db/upserts.ts:216` · not put to the refuter · fix risk: low

`UPDATE_ENCRYPTED_PREVIEW` does `SELECT text ... WHERE rid = ? AND text IS NOT NULL ORDER BY ts DESC LIMIT 1`, without the `isNull(threadId) OR threadShown = true` filter of the feed (app/room/[rid].tsx:219), without excluding `system_type`, and without the secondary sort key `id` that the feed precisely had to add to break ties.

**Fix.** Align the subquery: `AND (thread_id IS NULL OR thread_shown = 1) AND system_type IS NULL`, `ORDER BY ts DESC, id DESC`, in BOTH places where it is written (write and `IS NOT` guard), with a test next to the "list preview of an encrypted room" block of db/upserts.test.ts.

#### 🟡 medium: An E2EE room key rotation is never taken into account: the stale AES key stays cached until restart

`lib/e2e/engine.ts:132` · ✅ verified · fix risk: low

Verified in the code: `saveRoomKey` updates `e2eKeys` then returns if `roomKeys.has(rid)`. The comment announces "idempotent", which is only true if the `E2EKey` never changes; `decryptContent` looks up `roomKeys` FIRST. Both callers are wired to the live stream (lib/sync.ts:234 and :318), so at the first key rotation (member removed from the room) all new messages freeze on the 🔒 placeholder with no hint of the cause.

**Fix.** `const old = this.e2eKeys.get(rid); this.e2eKeys.set(rid, e2eKey); if (old !== undefined && old !== e2eKey) this.roomKeys.delete(rid);` before the existing guard. A test with two successive keys in lib/e2e/engine.test.ts (the file only covers the single-key case).

#### ⚪ low: E2EE locking rewrites every encrypted message, including those already hidden

`db/upserts.ts:199` · not put to the refuter · fix risk: none

`HIDE_ENCRYPTED_MESSAGES` = `UPDATE messages SET text = NULL WHERE encrypted_raw IS NOT NULL`, without `AND text IS NOT NULL`, whereas the whole neighbouring family carries this guard with a comment saying it "is not cosmetic" (l.147, 184, 188, 220): without it, the write wakes up every `useLiveQuery` on the table. `e2eRelocked` (lib/sync.ts:180) replays the operation on a repeated lock.

**Fix.** Add `AND text IS NOT NULL`, and `AND last_message IS NOT NULL` to `HIDE_ENCRYPTED_PREVIEW`. A test on `total_changes()`, a model already present (db/upserts.test.ts:536-544).

#### ⚪ low: `toRoom`, `toSubscription`, `toEpoch` and `lastMessagePreview` have no direct test

`lib/normalize.test.ts:1` · ✅ verified · fix risk: none

The file contains only one `describe` of three cases on the `callId` of a call message. Nothing covers the `uids`/`usernames` pairing explicitly documented as NOT aligned, the name fallback of a DM, the DM with oneself, a missing `avatarEtag`, the three shapes of `toEpoch`. This is the path all server documents take before SQLite, and the two findings above would have been caught by a table of cases.

**Fix.** A table of cases on `toRoom` (me present / me absent / DM with oneself / group DM / encrypted room / without `_updatedAt` / `lastMessage` missing vs `msg: ''`) and on `toSubscription`. A pure module: zero run cost.

---

### 5. Room catch-up: one per room, caches that do not lie

**Max severity** 🟡 medium · **fix risk** medium · **effort** day

At EVERY connection setup (hence at every return to the foreground), two identical paginations start on the open room: the provider (guard `rattrapageSalonEnVol`) and the screen, woken by the bump of `generation` that this same connection setup has just made, which calls `lib/catchUp.ts` directly without consulting the guard. Up to 8 `chat.syncMessages` where 4 are enough, on a route limited to 10 calls/min and at 3-4 s per call on the target server. The fix fits in lib/catchUp.ts, without changing a single caller signature. Three neighbouring coverage defects (guaranteeing read swallowed, cache repopulated after purge, thread without a guard) are dealt with along the way.

#### 🟡 medium: Two concurrent catch-ups on the same room at every connection setup

`lib/catchUp.ts:227` · ✅ verified · fix risk: medium

Verified in both files: ui/sync.tsx:298 protects its own call with `rattrapageSalonEnVol`, but app/room/[rid].tsx:465 calls `catchUpRoom(client, engine, rid, …)` imported directly from lib/catchUp.ts, with `generation` in its effect's deps (l.495). `afterCatchUp` increments `generation` just after `catchUpAll` has launched the catch-up of the active room: the screen's effect replays, `roomCovered(rid, newGeneration)` is necessarily false, and a second pagination starts on the same cursor. No corruption (the cursor does not regress, the upserts are idempotent), but all the work is done twice, plus a `*.history?count=50`.

**Fix.** Put the deduplication INSIDE lib/catchUp.ts, at the only point where the two paths meet: rename the body to `catchUpRawRoom` and export a `catchUpRoom` that coalesces by rid in a `Map<string, Promise<void>>` emptied by a `.finally`. No caller to touch, `activity.track` keeps its behaviour, the existing tests (sequential calls) see an already emptied Map. Document that the joiner inherits the `isDiscarded` of the first arrival, at no loss since the cursor is written after each page. Leave `rattrapageSalonEnVol` in place in the same commit, remove it later.

#### 🟡 medium: The read that GUARANTEES is swallowed for the active room by the anti-stacking guard

`ui/sync.tsx:298` · not put to the refuter · fix risk: medium

lib/connectionSetup.ts calls `catchUp()` twice: the second, after `streamArmed()`, is the one that guarantees no document falls between the two transports. On the room side, `if (rattrapageSalonEnVol) return;` DROPS it instead of deferring it, and the nominal case is precisely that the first one (launched before the socket opens) is still running. Uncovered window: [server evaluation of read #1; arming of the subscriptions], during which the cursor has already moved forward. A message posted then is seen by nobody until the next connection setup, while the room list already shows the up-to-date preview.

**Fix.** Reuse the idiom of `Reconnector` (`inFlight` + `rerunRequested`): set a `redemande` flag and run another pass in the `finally` instead of returning. The coalescer of the previous finding must include this rerun, otherwise it freezes the defect.

#### 🟡 medium: `keepWarm` can repopulate the LRU AFTER `releaseHotRooms`, and the ghost entry makes `roomCovered` lie

`ui/sync.tsx:420` · not put to the refuter · fix risk: low

The provider's cleanup (deps `[state]`) runs BEFORE `<Room>` is unmounted: the screen then calls `keepWarm(rid, generationRef.current, releases)` (app/room/[rid].tsx:366) with releasers pointing at a DDP client already `reset()`. `roomCovered` compares a number equality and the generation restarts from 0: as soon as the new session reaches the value of the ghost entry, the guard answers "covered" for a room never listened to on this socket, and missed edits and deletions are then never brought back.

**Fix.** A session token incremented by `releaseHotRooms`, passed to `keepWarm`/`roomCovered`: if the token no longer matches, release immediately instead of remembering. Same treatment for `markRoomLoaded`. A test in ui/hotRooms.test.ts.

#### 🟡 medium: The thread screen re-downloads the WHOLE thread at every connection setup, with no guard or indicator

`app/thread/[id].tsx:197` · not put to the refuter · fix risk: low

The loading effect has `generation` in its deps and has no equivalent of `loadedRooms`: each increment replays `chat.getMessage` then up to 20 pages of 100 of `chat.getThreadMessages`. On a thread of 300 replies, 4 calls per connection setup on a route limited to 10/min. Nothing is wrapped in `activity.track`: the sync bar stays off while the list is entirely rewritten.

**Fix.** A `loadedThreads` keyed by (threadId, generation) on the model of ui/loadedRooms.ts, and wrap the loading in `activity.track(rid ?? threadId, ...)`. Depends on the "generation no longer moves on E2EE" fix of workstream 1.

#### ⚪ low: `activeRoom` assumes only one room screen is mounted

`app/room/[rid].tsx:366` · not put to the refuter · fix risk: low

`signalerSalonActif` sets the rid on mount and `null` on unmount, on a single provider variable. Yet the stack can contain two room screens (ui/notifications.tsx:88 does a `push` from anywhere, app/profile.tsx:196 a `replace`): on back, the cleanup of the top room sets `null` while a room is displayed, and `catchUpAll` exits without catching up any room. The damage is masked today by the screen's redundant catch-up: fixing the first finding without this one turns this debt into a real loss.

**Fix.** Replace the variable with a stack: `declareOpenRoom(rid): () => void` which pushes/pops, `activeRoom` being the top. Do it in the SAME commit as the catch-up deduplication.

---

### 6. Lifecycle of local data: purge, cursors, retention

**Max severity** 🟡 medium · **fix risk** medium · **effort** day

The purge knows only three tables out of eight, the cursors outlive the data they describe, and the purge criterion is a snapshot OLDER than the state it judges. That last one is the only race in the whole audit that can make a DM the user has just received disappear from the app. The fixes are static parameterised SQL, exactly the style already in place and already tested on `node:sqlite`; the risk comes from touching DELETEs, so do it with the tests written first.

#### 🟡 medium: The anti-ghost reconciliation erases a room created DURING its own network request

`db/store.ts:178` · ✅ verified · fix risk: medium

`reconcileRooms` does a FULL `subscriptions.get` then `purgeMissingRooms(alive)`: three `DELETE … WHERE rid NOT IN (json_each(?))`. During the ~200 ms of the round trip, the DDP stream keeps writing (ui/sync.tsx:257-264): a DM opened by a colleague at that moment is not in `alive` and its three rows are erased. The write queue protects nothing here: it serialises, it does not refresh the list. The DM only comes back at the next `catchUpGlobal`, and meanwhile the push notification leads to a missing room.

**Fix.** Take `listKnownRids()` (`SELECT rid FROM rooms UNION … subscriptions UNION … messages`) BEFORE the request, and tighten the three DELETEs with a second JSON parameter: `rid IN (known) AND rid NOT IN (alive)`. It is the ORDER that carries the correctness, no delay. Signature `purgeMissingRooms(alive, known)`: tsc will flag the fake stores to complete (lib/catchUp.test.ts:29, lib/sync.test.ts:251). Test: `r3` ingested during the flight must not appear in the purge.

#### 🟡 medium: The catch-up cursors outlive the data they describe

`db/schema.ts:242` · not put to the refuter · fix risk: medium

`cursors` is erased neither by `DELETE_ROOM`, nor by `deleteBySubId`, nor by the purge. A room left keeps its `(rid,'messages')` rows while its messages are erased; on rejoining, app/room/[rid].tsx:423-427 anchors the cursor ONLY if it is missing, so the old value takes over again. `catchUpRoom` then restarts from a point that no longer says anything about the local state, capped at 2 pages: on a room with 3,000 messages it takes dozens of openings to converge, each paid for in rate-limited calls. Since `UPSERT_CURSOR` forbids any regression, nothing can correct the value afterwards.

**Fix.** `DELETE FROM cursors WHERE scope = ?` in `deleteRoom`/`deleteBySubId`, and `PURGE_MISSING_CURSORS` (`scope <> '*' AND scope NOT IN (json_each(?))`) in the purge transaction. The `scope <> '*'` is essential: the global cursors must never go.

#### 🟡 medium: The send and upload queues are never purged with their room: zombie rows replayed forever

`db/upserts.ts:246` · not put to the refuter · fix risk: low

Verified on a migrated database: after the three purge DELETEs of the room, `outbox`, `uploads`, `drafts` and `cursors` each keep their row, and the orphan outbox row does come out in `LIST_OUTBOX_TO_SEND`. No screen can show it any more (app/room/[rid].tsx:238 only reads `outbox` for the open room), so no "abandonner" ("discard") button either; at every connection setup it costs two REST calls (`chat.sendMessage` then the `chat.getMessage` of `messageDelivered`), forever, delaying the legitimate sends behind it.

**Fix.** Add `PURGE_MISSING_OUTBOX`, `PURGE_MISSING_UPLOADS`, `PURGE_MISSING_DRAFTS` to the transaction of `purgeMissingRooms`, and erase the rid's rows in `deleteRoom`/`deleteBySubId`. The attempt cap is handled in the uploads workstream.

#### 🟡 medium: No retention: `messages` and its satellite tables never stop growing

`db/schema.ts:77` · not put to the refuter · fix risk: medium

The only mass erasure fires only when a room is left. For a live room, everything stays: `text` plus the JSON blobs `md`, `attachments`, `reactions`, `urls`, often heavier than the text. Yet the app never reads beyond its pagination and knows how to re-download. Two queries moreover sweep the whole table without a usable index (`MESSAGES_TO_DECRYPT`, `HIDE_ENCRYPTED_MESSAGES`). On Android, the user's only recourse is "clear data", which destroys everything.

**Fix.** A retention pass at connection setup, in the write queue: per room, keep the last N (e.g. 500), sparing the optimistic ones (`updated_at = 0`) and the thread roots still referenced. Static SQL with `json_each` for the list of rids, like the existing purges. No need to re-anchor the cursor: only the old end is cut.

---

### 7. Upload queue: no duplicate, no silent disappearance

**Max severity** 🟠 high · **fix risk** medium · **effort** several days

This is the weakest link in the repo. The TEXT path (lib/outbox.ts) acquired, scar after scar, a client `_id`, a confirmation by `chat.getMessage` and an optimistic message; the FILE path has none of that. Real consequences: a photo sent offline disappears from the screen without the slightest sign (the user sends it again and will end up with two), a lost `mediaConfirm` response posts the message twice with one more orphan file on the server, and a row in definitive failure re-pushes all its bytes at every return to the foreground. None of these paths is covered by the tests, hence the order imposed below: tests first, migration next.

#### 🟠 high: A file sent offline disappears from the screen without any trace

`lib/uploadQueue.ts:187` · ✅ verified · fix risk: low

`UploadEngine` creates NO optimistic message (unlike lib/outbox.ts:89-112). On a network failure, `runPass` returns `false` without marking the row: it stays `pending`. Yet the only UI surface filters on `status === 'failed'` (app/room/[rid].tsx:246). And `send()` resolved normally, so the `.then` clears the preview, the draft and the quote; the share screen, for its part, navigates to the room as if all had gone well.

**Fix.** Stop filtering on failure in app/room/[rid].tsx:246 and choose the label by status (new key `room.filePending` in BOTH catalogues: ui/messages.test.ts checks parity). The "réessayer"/"abandonner" (retry/discard) buttons remain valid (`process()` is reentrant, `discard` only does a DELETE). Fix the two comments that became wrong (app/room/[rid].tsx:806-808, app/share.tsx:230-231). Do NOT create an optimistic message for files: it would be irreconcilable with the server echo, which has no client `_id`.

#### 🟡 medium: A lost response on `rooms.mediaConfirm` posts the same file TWICE

`lib/upload.ts:86` · ✅ verified · fix risk: medium

`televerser` chains `rooms.media` then `rooms.mediaConfirm` (which CREATES the message) with no intermediate state. `RestClient` aborts at 15 s and converts any failure without an HTTP response into `RestError(status 0)`; `runPass` then leaves the row `pending` and the next `files.process()` (at EVERY connection setup) starts from scratch. No deduplication key exists: the `uploads` table has neither a client `_id` nor a `file_id`, and its comment (db/schema.ts:161-162) mentions a `sending` status never implemented. Symmetrically, any failure occurring AFTER the upload leaves an orphan file that nothing cleans up: the very trap CLAUDE.md points out on the two-step flow.

**Fix.** Persist `file_id` (migration, nullable column) as soon as `rooms.media` returns; split `televerser` into `uploadBytes` / `confirmMedia`, and skip the first step when `file_id` is already there. Before re-confirming, query SQLite, not the network: `SELECT 1 FROM messages WHERE rid = ? AND attachments LIKE '%' || ? || '%'`; if the message is there, the confirm had succeeded, so purge the row. Purely local, hence insensitive to the rate limit. Do NOT try a client `_id` on `mediaConfirm` (`additionalProperties: false`).

#### 🟡 medium: No "in progress" state: "Abandonner" (Discard) during a retry deletes the row but the message is posted anyway

`lib/uploadQueue.ts:196` · not put to the refuter · fix risk: medium

`LIST_UPLOADS_TO_SEND` returns the `pending` AND `failed` rows, and `runPass` does not change the status when it takes a row on: the banner shows "non envoyé · Réessayer · Abandonner" ("not sent · Retry · Discard") throughout the re-upload, without progress (the `Map progress`, announced "for the UI" in lib/provider.ts:182, is read nowhere). `discard(id)` is only a DELETE: it does not cancel the in-flight `FileSystemUploadTask` (`cancelAsync` is never called) and does not prevent `ingest(message)`: the video appears in the room after the user explicitly discarded it.

**Fix.** Implement the `sending` status already described in the schema: set when the row is taken on, excluded from the listing, shown with the fraction from `progress`. `discard` on a `sending` row sets a cancellation intent checked before `ingest`, and ideally calls `task.cancelAsync()` (to be exposed in the `TransportUpload` type).

#### 🟡 medium: Failed rows are replayed at every return to the foreground, with no cap or backoff

`db/upserts.ts:330` · not put to the refuter · fix risk: low

`afterCatchUp` calls `outbox.process()` and `files.process()` at every connection setup, and both listing queries include `failed`. No engine reads a counter: the `attempts` column exists for `outbox` but is never consulted, and `uploads` does not even have one. A video refused by the server (413, refused type, quota) therefore re-pushes all its bytes at every network flap, a frequent case when `fileSize` is null on Android and the local validation lets it through.

**Fix.** Only replay `pending` rows automatically; keep `failed` for the explicit "réessayer" (retry) gesture. Failing that, an `attempts` column incremented by `MARK_UPLOAD_FAILED` and a cap, as for the text queue: a cap, not a delay.

#### 🟡 medium: `messageDelivered` confuses "the server did not answer" with "the message was not delivered"

`lib/outbox.ts:197` · not put to the refuter · fix risk: low

When `chat.sendMessage` fails with a status ≠ 0, `runPass` queries `chat.getMessage` to decide, but `messageDelivered` catches ALL errors and returns `null`, including a network outage or a 429 after the three retries (the `chat.getMessage` is subject to the same 10/min limit). The caller marks `failed`: the user sees "non envoyé" ("not sent") on a message the server may have accepted.

**Fix.** Return `'inconnu'` when the error is a `RestError` of status 0 or 429 (the row then stays `pending`), `null` only when the server answered that the message does not exist.

#### ⚪ low: No temporary file is ever deleted

`ui/prepareAttachment.ts:27` · not put to the refuter · fix risk: low

`compressImageIfUseful` writes one JPEG per photo, `DocumentPicker({copyToCacheDirectory:true})` copies each document, `ImagePicker` copies each media item, the recorder produces one `.m4a` per take. A search for `deleteAsync` across the whole repo returns NO call: nothing is erased, neither after sending, nor when the preview is removed, nor for attachments removed in app/share.tsx. The only purge mechanism is Android's under pressure, which in passing breaks the sends still queued.

**Fix.** Delete the local file when the upload row is purged (success or discard) if the URI is in the app's cache: the knowledge is on the `UploadEngine` side. And delete the recompressed JPEG when the preview is removed without sending.

#### 🟡 medium: The network-failure path and the SQL of the upload queue are tested nowhere

`lib/uploadQueue.test.ts:116` · not put to the refuter · fix risk: none

The file stops at success and outright refusal. Neither the `status === 0` (the only path that leaves an invisible row), nor the `inFlight`/`rerun` guard, nor the cleanup of `progress` is exercised, whereas the three equivalents of `OutboxEngine` are tested one by one. On the SQL side, `grep TELEVERSEMENT db/*.test.ts` returns only the table name: `INSERT_UPLOAD`, `LIST_…`, `MARK_…`, `DELETE_…` are run by no test, whereas db/store.ts:373 returns `getAllAsync` directly as `UploadRow[]`: a mere type assertion, never checked.

**Fix.** A `describe('upload queue')` in db/upserts.test.ts, modelled on the outbox one (insert with the real parameters of db/store.ts, read back, compare field by field, mark as failed, delete). And three cases in lib/uploadQueue.test.ts: `RestError(…, 0)` → row `pending` and `markFailed` NOT called; concurrent `process()` → one pass then one rerun; `progress.has(id)` false after failure as after success. To be WRITTEN BEFORE the `file_id` migration.

---

### 8. DDP and REST transport: do not kill a healthy socket, do not sleep without listening

**Max severity** 🟡 medium · **fix risk** medium · **effort** day

The domain is solid and well tested, but four precise defects make the app punish itself on a degraded network: a liveness probe sent too early closes a socket that works (server behaviour verified on the test bench), the reconnection driver keeps reopening sockets in the background against the documented intent, a 429 retry sleep ignores cancellation and makes concurrent calls converge, and `/api/info` alone escapes the whole defence of the module, to the point of being able to block the login screen for good. Each fix is local to a module already covered by tests.

#### 🟡 medium: The liveness probe sent during DDP negotiation kills a healthy socket 10 s later

`lib/ddp.ts:437` · not put to the refuter · fix risk: low

`checkAlive()` only protects itself from the `closed` state: it therefore probes during `connecting`. Probed on a real Rocket.Chat: a `ping` sent before the `connect` receives `{msg:'error', reason:'Must connect first'}`, never a `pong`. Yet `receive()` has no case for `msg:'error'`: the message is swallowed, the wait is never resolved, and after 10 s the `catch` does `ws.close()` + `cleanUp()` on a socket that has meanwhile finished its login and replayed its subscriptions. Neither caller filters (ui/sync.tsx:393, the end-of-upload probe).

**Fix.** `if (this.state !== 'authenticated' && this.state !== 'connected') return false;` at the top of `checkAlive()`: a negotiation in progress already has its own timeout. Incidentally, handle `msg:'error'` in `receive()` by rejecting the wait matching `error.offendingMessage.id`, which would turn this silence into an immediate failure.

#### 🟡 medium: The reconnection driver is not suspended on going to the background

`ui/sync.tsx:389` · not put to the refuter · fix risk: medium

The comment l.379-385 sets the rule: in the background, voluntary close, "push takes over". But the handler only does `ddp.close()`; the `Reconnector` only has `stop()`, final and reserved for unmounting. Two paths reopen a socket in the background: an already-armed backoff timer that fires anyway, and an in-flight attempt whose failure restarts the loop. Each attempt brings a full `catchUpAll()` (rate-limited REST) and, on success, a socket left open until Doze kills it, which fires `onLoss` again.

**Fix.** Add `suspend()` / `resume()` to the `Reconnector` (a reversible flag that blocks `trigger()` and cancels the timer), called from the `AppState` handler around `ddp.close()`. A test "a scheduled timer does not fire after suspend()".

#### 🟡 medium: `fetchVersion` calls `fetch` without a timeout: the login screen can stay stuck for life

`lib/server.ts:87` · not put to the refuter · fix risk: low

The module claims the defence of `RestClient`, but `/api/info` goes out on a bare `fetch`, without `TIMEOUT_MS`. `probeServer` awaits both calls in a `Promise.all`; the only net, `controller.abort()`, only runs if one of the two promises REJECTS. If `settings.public` succeeds and `/api/info` stays pending (reverse proxy, captive portal), `Promise.all` stays pending for life: the `finally` of app/login.tsx:136-139 does not run, `inFlight.current` stays `true`, and a second tap exits on the `if (inFlight.current) return;` WITHOUT reaching the `abort()`. A dead screen, with no message.

**Fix.** Bound the call: a local `AbortController` armed by `setTimeout(TIMEOUT_MS)` relaying the received signal, or, more cleanly, a `getHorsApiV1` method on `RestClient` so that `/api/info` inherits the timeout, the 429 retry and the defensive JSON.

#### 🟡 medium: The 429 retry sleep ignores cancellation and has no jitter

`lib/rest.ts:239` · not put to the refuter · fix risk: low

Two defects in the same place. (a) The `finally` removes the cancellation listener BEFORE `await this.dep.sleep(delay)`: an `abort()` during the sleep is only noticed when the recursion returns, up to 30 s later and 90 s in total, and the promise returned to the caller stays pending that long, and so does its spinner. (b) `delayAfter429` computes `reset - now() + 250`: two concurrent calls receive the same `x-ratelimit-reset` and wake up on the same millisecond, with no jitter and no per-route queue; the new window admits only 10 of them, the others get a 429 again.

**Fix.** (a) A race between `sleep(delay)` and a promise resolved by an `abort` listener, then raise `cancelError()`. (b) A bounded jitter injectable through `Dependencies` to keep the tests deterministic (the `deepEqual(sleeps, [2250, 2250])` of lib/rest.test.ts:167 are rewritten as ranges). A lock per `path` would serialise the retries of a single route rather than make them converge.

#### ⚪ low: Nothing invalidates presence when the transport dies

`lib/presence.ts:45` · not put to the refuter · fix risk: low

The module header sets the contract ("a stale presence shown from a cache is worse than no presence at all") and `statusOf` returns `null` so that the UI shows NOTHING. The contract is only kept against PERSISTENCE: the in-memory `statuses` map is never invalidated, `PresenceEngine` is wired neither to `onLoss` nor to any transport signal, and the only refresh is `load()` from `afterCatchUp`. Between the drop and the next connection setup, the DM list keeps showing green dots dating from when the tunnel was entered.

**Fix.** `PresenceEngine.invalidate()` (empty `statuses`, increment the counter to keep sequences monotonic, notify) called from `ddp.onLoss` in ui/sync.tsx:376 and on going to the background. The UI falls back to "unknown", the degradation behaviour already specified.

#### ⚪ low: `cleanUp()` is not idempotent: a socket that dies during login notifies `onLoss` twice

`lib/ddp.ts:552` · ✅ verified · fix risk: low

Verified by running it: `onclose` → `cleanUp()` notifies then rejects the login wait; the `catch` of `connect()` calls `cleanUp(e)` again and notifies a second time. No damage today (`Reconnector.trigger()` is idempotent), but it is an implicit coupling: any future subscriber (drop counter, offline banner, metric) will count double, and the second pass re-emits the event on an object already fully cleaned up.

**Fix.** Return immediately if the cleanup has already happened (a flag reset by `connect()`), and an assertion `losses === 1` in the "socket dead during login" test of lib/ddp.test.ts.

---

### 9. Dead session and end of session: back to login, and take everything when leaving

**Max severity** 🟠 high · **fix risk** HIGH · **effort** day

Three holes meet on the same symptom: the app stays in a state it believes valid and the user has no way out. A token revoked mid-session (password changed elsewhere, `Accounts_LoginExpiration`, `logoutOtherClients`) makes the reconnection driver loop forever on yesterday's cache, without a message; a logout leaves the DECRYPTED E2EE private key on disk, keyed by server alone, so that the next account believes itself unlocked and can no longer read anything; and the SQLite database with the E2E plaintexts survives intact. I place it AFTER the low-risk workstreams because triggering an automatic logout is the most dangerous fix in the whole audit: a discrimination error ejects the user wrongly. Do it with its predicate test written first.

#### 🟠 high: A 401 occurring MID-session never revokes the session: zombie state until restart

`lib/rest.ts:280` · ✅ verified · fix risk: HIGH

Verified by grep: the ONLY TWO places that test `status === 401` to erase the session are ui/session.tsx:114 (startup) and :159-165 (server switch). No everyday call reports the invalidation: `catchUpGlobal`, `chat.syncMessages`, `chat.sendMessage` (which only distinguishes status 0), `users.presence` (which silently swallows everything). On the DDP side, `login {resume}` rejects and the `Reconnector`, deliberately blind to the cause (`catch { attempt++; trigger(); }`), retries every 30 s forever. The screen shows yesterday's data, the sync bar pulses, every send fails: exactly what a network problem looks like.

**Fix.** Two complementary moves. (1) `RestClient` SAYS that the token is refused: an optional field `onTokenRejected?: (token: string) => void`, called at the existing THROW SITE (after the `totp-required` branch, so never on a 2FA challenge; after the JSON parse, so never on a proxy's HTML 401), with the token ACTUALLY sent so that a late 401 on an already replaced token is ignored. Wired in `clientFor` (ui/session.tsx:55, the single creation point of the three paths) onto the already proven startup sequence. (2) On the connection-setup side, wrap the `Reconnector` call and only call `logOut()` on a `RestError` of status 401 that is NOT a `TwoFactorError`: `logOut()` brings down the effect of `SyncProvider`, so the driver stops with no extra stop code. Write FIRST the test of the `isTokenRejected` predicate on four cases: `RestError(401)` → true, `TwoFactorError` → false, `RestError(0)` → false, `DdpError` → false. This test is what protects against the only real risk: the wrongful logout.

#### 🟡 medium: The E2EE private key survives logout and is stored by server alone

`ui/session.tsx:184` · ✅ verified · fix risk: medium

`logOut()` only erases the session, never `clearE2EPrivateKey`, whereas what is stored is the DECRYPTED RSA JWK, the most sensitive secret of the app. Second defect, a structural one: `e2eStorageKey(baseUrl)` derives ONLY from the URL, whereas the session and the SQLite database are keyed by the (server, account) pair. At the next startup, `e2e.resume()` blindly reimports this JWK for ANOTHER account: `importRsaPrivateKey` succeeds (it is a valid JWK), `isUnlocked` becomes true, `decryptRoomKey` fails silently, and the UI shows "chiffré, lecture seule" ("encrypted, read-only") instead of the "Déverrouiller" ("Unlock") button. No visible path to the unlock screen.

**Fix.** (1) ESSENTIAL: `e2eStorageKey(baseUrl, userId)` derived from the digest of `baseUrl + '|' + userId`, propagated to the three exported functions, `session.userId` being already at hand in ui/sync.tsx:167. The only valid fix whatever the session exit path. No migration: an old-format key becomes unfindable, the user re-enters their password once. Extract the derivation as db/fileName.ts did for the database, to test it without expo. (2) HYGIENE: `clearE2EPrivateKey` at the THREE exits: `logOut()` and the two 401 paths (ui/session.tsx:115 and :163). Do not touch lib/e2e/engine.ts, correct by injection.

#### 🟡 medium: Logout leaves the whole SQLite database on disk, E2E plaintexts included

`ui/session.tsx:170` · not put to the refuter · fix risk: medium

`e2eUnlocked` writes the decrypted text into the `text` column (lib/sync.ts:153-176), and the project acknowledges that this plaintext must be able to disappear: `e2eRelocked` calls `hideEncryptedMessages`, wired to the "Verrouiller" ("Lock") button. But `logOut()` does not lock and erases no database (no `deleteDatabaseSync` in the repo, unencrypted database). A glaring inconsistency: the strongest gesture protects less than the weakest.

**Fix.** At a minimum call `hideEncryptedMessages()` in `logOut()`; preferably add `supprimerBase(baseUrl, userId)` to db/client.ts (close then `deleteDatabaseSync`), doing it from `logOut`, NOT from an effect cleanup. If keeping the offline cache for a quick return is preferred, decide explicitly and document it.

#### 🟡 medium: Three module-level stores are never purged at the end of the session

`ui/reply.ts:31` · not put to the refuter · fix risk: low

The cleanup of ui/sync.tsx purges `loadedRooms` and `hotRooms`, but not: (a) the `targets` Map of ui/reply.ts, whose header nonetheless claims that "a pending quote does not survive", true of a process restart, false of a logout: the first message typed after reconnecting goes out prefixed with the permalink of the previous session; (b) `identities` and `etags` of ui/identities.tsx, which serve the previous account's usernames and avatar URLs during the first frames; (c) `availabilityByServer` of lib/call.ts:72, where a memoised `false` hides the 📞 button for the whole life of the process, even after reconnecting: no gesture in the app gets out of it.

**Fix.** Export `forgetReplies()`, `forgetIdentities()` and `forgetCallAvailability()` and call them in the cleanup of ui/sync.tsx, next to the two existing purges, so that the rule "every module-level store is purged at the end of the session" has no exception. Fix the header of ui/reply.ts.

#### 🟡 medium: After an offline logout, the token stays registered on the server

`ui/session.tsx:178` · not put to the refuter · fix risk: low

The `push.token` DELETE is best-effort in an empty try/catch: a network failure (or a `getFcmToken` in `permission-denied`) leaves the token alive, with no retry queue. On the native side, `fetchAndPost` sees `session == null` and posts the degraded notification ANYWAY, then schedules a WorkManager catch-up bound to fail. Result: ghost "Nouveau message" ("New message") notifications on a device without an account, until uninstall.

**Fix.** (1) Native: when `readSession` returns nothing for this host, post nothing and schedule nothing. (2) JS: persist the (baseUrl, token) pair in a "to unregister" queue and empty it at the next startup; the DELETE already tolerates the 404 (lib/pushToken.ts:40).

---

### 10. Native push: duplicates, multi-server deep link, service hygiene

**Max severity** 🟠 high · **fix risk** medium · **effort** several days

This whole workstream is Kotlin injected by a config plugin: neither tsc nor the 460 tests see it, and each iteration costs `expo prebuild` + `assembleRelease` (status tested WITHOUT a pipe). It must therefore be handled in a single pass, not piecemeal. The most serious one is verified: the anti-duplicate guard of commit 249887e only covers one direction of the race, so that the catch-up worker and the FCM redelivery (woken by the SAME event, the network coming back) add the same message to the conversation twice. The deep link moreover ignores the multi-server dimension that the app nonetheless supports, which yields a permanent spinner.

#### 🟠 high: The anti-duplicate guard does not cover the "the worker has already posted" case

`plugins/with-fcm-deeplink.js:249` · ✅ verified · fix risk: medium

`fetchAndPost` cancels the degraded notification and the catch-up then calls `showRoomNotification`, which RE-EXTRACTS the room's active MessagingStyle and adds the message to it: no state remembers that a messageId has already been shown. Symmetrically, `PushCatchUpWorker.doWork` never tests `isStopped` before publishing: a `cancelUniqueWork` does not stop a worker in flight. The network comes back, the worker posts, FCM redelivers the unacknowledged push 1-2 s later, and the user sees the same message twice with "2 new messages".

**Fix.** An atomic test-and-set `alreadyShown(ctx, messageId)` (dedicated SharedPreferences, entries purged after one hour, `@Synchronized`, best-effort returning `false` on an exception so as never to lose a notification), consulted in BOTH id-only paths: in `fetchAndPost` just before display (keeping `cancel` + `cancelCatchUp` BEFORE the test, since the degraded notification must disappear in every case), and in `doWork` in the form `if (isStopped || alreadyShown(...))`. The degraded notification, for its part, does NOT set the marker: it must stay replaceable. The "content present in the push" regime is unchanged (no degraded notification, no catch-up, hence no race).

#### 🟡 medium: The notification deep link does not carry the server: permanent spinner in multi-server

`plugins/with-fcm-deeplink.js:465` · ✅ verified · fix risk: medium

The intent is `rocketvibe://room/<rid>`: the `host`, though present in the payload and correctly used by `readSession` to show the right content, is thrown away. Yet sessions coexist (`switchServer` erases nothing) and the push token is registered on each server, so both push. On arrival, app/room/[rid].tsx has no `rooms` row for this rid: `type === undefined` short-circuits the whole effect, `firstPassDone` stays `false`, and the screen shows a permanent `ActivityIndicator`. ui/notifications.tsx:88 has the same hole on the JS side.

**Fix.** (1) Add the host to the link (`?host=…`) in `showRoomNotification`: the three callers already have it at hand; do NOT read it back from the `push.get` payload, whose shape is not guaranteed. Mirror it on the JS side in ui/notifications.tsx. (2) In `RoomScreen`, if `host` is defined and differs from `session.baseUrl`, render an explicit screen "Ce message est sur <host>" ("This message is on <host>") with a button that calls `switchServer` then `replace`: a switch on explicit gesture only. `host` missing → behaviour identical to today, hence zero regression in single-server.

#### 🟡 medium: No notification is removed when the room is read

`ui/notifications.tsx:118` · not put to the refuter · fix risk: low

`dismissNotificationAsync` appears nowhere (verified by grep): only `setAutoCancel(true)` removes the notification, and only on TAP. Yet the badge effect already follows the unread counts in real time. Notifications being grouped per room and cumulative, reading #general from the icon leaves its 3 messages in the status bar, and the next one is added as a 4th line; same when the room is read from another device.

**Fix.** In `BadgeAndEncryptedTracking`, for every rid going to `unread === 0`, call `Notifications.dismissNotificationAsync('expo-notifications://foreign_notifications?id=' + hashCodeJava(rid))`: the shape that `ExpoPresentationDelegate` decodes into `cancel(tag=null, id)`, the id set by the native side being `rid.hashCode()`. `hashCodeJava` is a dozen deterministic lines, testable under Node.

#### 🟡 medium: The blocking `push.get` can cost 16 s (32 s in debug) on the FCM dispatch thread

`plugins/with-fcm-deeplink.js:663` · not put to the refuter · fix risk: low

The comment announces a "tight timeout" but sets `connectTimeout = 8000` AND `readTimeout = 8000`: in Doze, radio not yet up, that is 16 s in `handleIntent`, and `verifyPushGetInDebug` chains a SECOND full fetch (~32 s). This is what makes the process killable during the fetch (the hypothesis already written l.241-243), hence what FEEDS the FCM redelivery and the family of duplicates above. This path moreover has no handling of the 429, whereas `push.get` is subject to the 10/min limit.

**Fix.** ~3 s of connect and ~3 s of read (6 s total budget), leaving the WorkManager catch-up to do its job; make `verifyPushGetInDebug` conditional on an explicit flag; on 429, schedule the catch-up by reading `x-ratelimit-reset` without consuming an immediate attempt.

#### ⚪ low: A 401 on `push.get` triggers eight WorkManager attempts bound to fail, per notification

`plugins/with-fcm-deeplink.js:667` · not put to the refuter · fix risk: low

`fetchContent` returns `null` for ANY code ≠ 200, without telling a transient outage from a definitive refusal. `fetchAndPost` then systematically schedules the catch-up, and `doWork` retries up to 8 times with a 30 s backoff, rereading the same dead session. Over an evening of messages, that is battery and radio wake-ups for nothing.

**Fix.** Pass the HTTP code up (a typed result rather than `JSONObject?`) and, on 401/403, post the degraded notification WITHOUT scheduling a catch-up, as the "unexpected payload" branch already does.

#### 🟡 medium: The native path's strings are hard-coded in French whereas the app is fully EN/FR

`plugins/with-fcm-deeplink.js:414` · not put to the refuter · fix risk: low

Since the native service posts ALL message notifications, the only strings the user sees are the Kotlin ones: "Message chiffré" ("Encrypted message", l.414), "Vous" ("You", l.436, name of the MessagingStyle's Person), "Nouveau message" (l.518). Yet the JS catalogue has both languages, and the preference is already readable from the native side (`preferred-language` in the same SecureStore SharedPreferences as the session).

**Fix.** Move the three strings out into `res/values/strings.xml` + `res/values-fr/strings.xml` set up by the same plugin (`withStringsXml`), or read `preferred-language` to honour the explicit preference rather than the system locale.

#### ⚪ low: FCM token rotation is never listened to

`ui/sync.tsx:333` · not put to the refuter · fix risk: low

`Notifications.addPushTokenListener` exists nowhere: the token is pushed only once per session. If FCM rotates it while the app is alive, `onNewToken` is handled by expo but nothing re-registers it: notifications silently stop until the next cold start, and the old token stays on the server.

**Fix.** Set an `addPushTokenListener` when the session mounts that calls `registerToken` again (idempotent POST). Do it with the flag fix (workstream 1), which touches the same lines.

#### ⚪ low: The plugin's configuration surgery (pure JS) has no test

`plugins/with-fcm-deeplink.js:737` · not put to the refuter · fix risk: none

The Kotlin can only be verified by a build, that is accepted. But `withServiceManifest` (idempotence, `android:priority=1`, the exact value on which FCM routing to our service rather than expo's depends) and `withNativeDeps` (injection through `contents.replace(/dependencies\s*\{/, …)`, hence into the FIRST occurrence met, with as its only guard `includes(artifact)` without a version) are testable JS. Correct today by a property of the RN 0.86 template, not of the plugin.

**Fix.** `plugins/with-fcm-deeplink.test.ts` (Node, without Expo) on fixtures: the `implementation` lines land in the top-level `dependencies` block, a second pass adds nothing, a gradle file WITHOUT a `dependencies` block is DETECTED instead of being left untouched, and the service is added only once with `android:priority=1`.

---

### 11. Screens: unbounded loops, fixed waits, needless native costs

**Max severity** 🟡 medium · **fix risk** low · **effort** day

Four screen defects that cost network, battery or trust: a pagination that can loop indefinitely on `channels.history` when the oldest messages share a millisecond, a `subscriptions.read` every 2 s in a busy room (30/min on a route limited to 10/min), an ExoPlayer + MediaSession + Visualizer allocated and a file downloaded per voice message MERELY VISIBLE (the exact opposite of the decision written in ui/videoPlayer.tsx), and a scroll after sending pinned on `setTimeout(250)`, that is the wait-time fix the project's standing rule forbids. All the fixes are local to a screen or a component.

#### 🟡 medium: The "past exhausted" criterion (`n > 1`) loops indefinitely if the oldest messages share the same millisecond

`app/room/[rid].tsx:522` · not put to the refuter · fix risk: low

`loadMore` requests the previous page with `latest = ts of the oldest local message` and `inclusive: true`, then concludes `n > 1 ⇒ more past remains`. The reasoning only holds if the boundary message is ALONE on its millisecond, yet the secondary sort key `desc(messages.id)` (l.229) explicitly acknowledges ties as real (bot burst, import). The server then returns the whole group, `n` stays > 1, `passExhausted` is never armed, and the re-ingestion makes `data` change, which re-arms FlashList v2's `onEndReached`: the loop feeds itself until the 429.

**Fix.** Infer exhaustion from the page containing a message strictly older than the boundary (return the smallest `ts` of the batch from `loadHistory` and compare), rather than from the count. A complementary net: also arm `passExhausted` if the last id is unchanged after two consecutive pages.

#### 🟡 medium: The `markRead` debounce bounds bursts but not the RATE: 30 POST/min on a route limited to 10/min

`app/room/[rid].tsx:284` · not put to the refuter · fix risk: low

The effect re-arms a `setTimeout(1500)` on each new id at the top and calls `subscriptions.read`. A trailing debounce only guarantees the absence of two calls less than 1.5 s apart; a message every 2 s produces 30 calls in the minute. The comment "debounced, the REST is rate-limited" assumes a protection that does not exist. On each 429, lib/rest.ts retries 3 times with naps of up to 30 s, for purely idempotent work, and the home screen's unread counter stays wrong for several tens of seconds.

**Fix.** A rate floor on top of the debounce: remember the instant of the last successful `markRead` and only rerun if `Date.now() - last >= 10_000`, otherwise reschedule for the rest of the floor. Nothing is lost semantically (`subscriptions.read` marks everything read up to now, a late call encompasses the earlier ones). Complete it with a guaranteed call on leaving the screen and on going to the background.

#### 🟡 medium: Each MOUNTED voice message creates an ExoPlayer and downloads its file, even without playback

`ui/audioPlayer.tsx:208` · not put to the refuter · fix risk: medium

`useAudioPlayer(url)` is called in the component body, hence for each audio attachment the list renders. On the native side, the constructor does `setMediaSource` → `prepare()`: ExoPlayer immediately buffers the remote URL, plus a periodic coroutine, one MediaSession per instance, and a system `Visualizer` through the effect at l.226, whereas the native side warns "It must only be created once, otherwise the app will crash". The neighbouring file ui/videoPlayer.tsx explicitly decided the other way ("the player only exists while you watch"). Scrolling through 20 voice messages downloads ~20 MB for zero seconds of listening, with URLs carrying `rc_uid`/`rc_token`.

**Fix.** Reuse the pattern of videoPlayer.tsx: the card at rest mounts no player, `useAudioPlayer` and `useAudioSampleListener` live in a sub-component mounted at the first tap on "lire" (play) (the `activePlayer` coordinator then becomes trivial). Remove in passing the redundant call to `setAudioSamplingEnabled(true)`: `useAudioSampleListener` already does it, after testing `isAudioSamplingSupported`, which our effect does not.

#### 🟡 medium: Scrolling after sending in a thread relies on a fixed 250 ms delay

`app/thread/[id].tsx:258` · not put to the refuter · fix risk: low

`afterSend` does `setTimeout(() => list.current?.scrollToEnd(...), 250)`. The expected chain is: SQLite write serialised by the queue (hence behind any sync transaction in progress) → `addDatabaseChangeListener` → `useCoalescedLiveQuery`, whose debounce is 48 ms but CAPPED at 400 ms. The delay therefore has no guaranteed upper bound against what it waits for: under a flood of writes, the scroll starts on the previous data, the reply is born below the fold, and the user sends their message again. This is exactly the wait-time fix the standing rule forbids, and the room screen solves the same problem without a clock (app/room/[rid].tsx:322-336, an effect on `latest` with a chronological guard).

**Fix.** Remove `afterSend` and the `setTimeout`: a `useEffect` watching for a new id appearing at the tail of `data` (the `_id` returned by `outbox.send` is already available to wait for it by name). The list is realigned by the render, not by a clock.

#### 🟡 medium: The emoji picker freezes the list of custom emojis at mount whereas it is never unmounted any more

`ui/emojiPicker.tsx:228` · not put to the refuter · fix risk: low

`useMemo(() => customEmojiCodes(), [])` is justified by a comment ("the panel unmounts on close") stale since 0313574: `useEmojiPanel` mounts the panel once and for all and NEVER unmounts it. Yet `syncCustomEmojis` runs AFTER `ready`, at connection setup, so on first install `customs` is `[]`, the ⭐ tab is not rendered (condition l.272) and search offers no custom emoji, while `:party_parrot:` displays correctly in the messages the next second.

**Fix.** Make the emoji index observable like the other stores: a generation counter in lib/customEmojis.ts exposed through a `useSyncExternalStore` (a pattern already in place in ui/identities.tsx and ui/i18n.ts), and make the `useMemo` depend on that generation. Failing that, at least fix the comment, which claims the opposite of the real behaviour.

#### ⚪ low: The markdown render safeguard never re-arms

`ui/markdown.tsx:56` · not put to the refuter · fix risk: low

`RenderGuard` sets `crashed: true` and renders `this.props.fallback` forever: nothing resets the state to `false` when the props change. The row stays mounted across edits, so a momentarily malformed `md` freezes the message on its bare text (no bold, no link, no emoji) until the cell is recycled, even after the edit that fixes the `md`. The rest of the chain is remarkably defensive; this is the only link with no re-arming.

**Fix.** `componentDidUpdate(prev) { if (this.state.crashed && prev.children !== this.props.children) this.setState({ crashed: false }); }`, or a `key` derived from `message.md ?? message.text` from `MessageContent`.

#### 🟡 medium: Reactions are sent to the server but never shown nor removable

`app/message-actions.tsx:253` · not put to the refuter · fix risk: low

The row of six chips hard-wires `put` to `true`, whereas `chat.react` can also remove. And the `messages.reactions` column is WRITTEN (lib/normalize.ts:156, db/upserts.ts:42) but a grep over ui/, app/, lib/ finds no READ. The user taps 👍, the sheet closes, nothing changes (neither right away, nor when the server echo arrives) and they have no way to undo. It is an action offered with no feedback and no undo, and a write-only SQLite column.

**Fix.** Either remove the row as long as the rendering does not exist (promise nothing), or, preferably, render the reactions in ui/messageRow.tsx from `message.reactions` (a chip per code, a counter, an accented outline if my username is in it) and pass `put = !jaiDejaReagi`. The data is already in the database and already refreshed by the stream.

#### ⚪ low: Side effects run inside a setState updater

`ui/emojiPicker.tsx:131` · not put to the refuter · fix risk: low

`toggle` places `fieldRef.current?.focus()` and `Keyboard.dismiss()` INSIDE the function passed to `setState`. React requires a pure updater: StrictMode systematically doubles it, and an interrupted concurrent render replays it. Yet the keyboard/panel order is precisely what commit 0313574 had the hardest time stabilising: one `Keyboard.dismiss()` too many during the animation can make `useAnimatedReaction` (l.124-129) miss the transition and leave the panel in `yielded`, with its height reserved under the composer.

**Fix.** Compute the next state outside the updater, call `setState(next)`, then perform the side effect; or move `focus()`/`dismiss()` into a `useEffect` triggered by the `state` transition.

#### ⚪ low: Two screens apply an optimistic state without sequencing

`app/settings.tsx:89` · not put to the refuter · fix risk: low

`set` captures `previous` then sets the value before awaiting `users.setPreferences`, with no `inFlight` guard nor sequence number (unlike app/search.tsx:72 and app/message-search.tsx:72). Two close taps launch two concurrent POSTs and the `catch` of the first restores the value from BEFORE the second choice: the UI shows a level the server does not hold. Same family: app/my-profile.tsx:161-216 chains three calls (info, status, avatar) with a single catch that applies no `setInitial`; a resubmission replays the already accepted username and can be refused, making the screen unusable for the only remaining step.

**Fix.** A sequence in a ref for `set` (only apply the rollback and the message if `sequence.current === n`), or an `inFlight` guard with the three options disabled. For `my-profile`, track the success of each step (clear `localAvatar` as soon as `setAvatar` succeeds, `setInitial` field by field) and only state in the banner what failed.

---

### 12. A test net where the code cannot be reached

**Max severity** 🟡 medium · **fix risk** none · **effort** day

The repo's coverage is above average, but it stops at a clear boundary: whatever touches the platform (db/store.ts, lib/server.ts, ui/drafts.ts, the plugins) and all of `app/` (5,400 lines, zero tests). Two points are worse than a plain gap: the fake stores LIE (their `transaction: (fn) => fn(store)` erases the deadlock invariant that db/store.ts paid for with a real crash), and the E2EE crypto is only exercised against `node:crypto`, never against quick-crypto, which is the implementation actually shipped. Zero regression risk by construction: this workstream changes no production code, and it is a precondition for splitting the room screen.

#### 🟡 medium: The fake stores expose the WHOLE store in `transaction`, which makes the queue/transaction deadlock undetectable

`lib/sync.test.ts:274` · not put to the refuter · fix risk: none

lib/sync.test.ts:274 and lib/catchUp.test.ts:45 define `transaction: async (fn) => fn(store)`: the callback receives the whole `Store` object, whose methods are plain `push`es. In production, `transaction` is `serially(() => raw.withTransactionAsync(() => fn(direct)))` and passes the DIRECT writer, outside the queue, because calling a queue method from inside a transaction deadlocks (db/store.ts:64-76, lib/sync.ts:88-93). A refactor that wrote `this.store.upsertMessage` instead of `tx.upsertMessage` would pass tsc and the 460 tests, and would freeze the first catch-up batch on the device, forever.

**Fix.** Make the fake `transaction` a trap: an `inTransaction` flag set during the call, a `directWriter` exposing only `StoreWrites`, and each top-level method of the fake throwing "write outside the queue during a transaction" if the flag is up. The test becomes the exact mirror of the constraint.

#### 🟡 medium: The E2EE crypto is only exercised against `node:crypto`; quick-crypto is covered by nothing

`lib/e2e/crypto.ts:27` · not put to the refuter · fix risk: none

The tests validate an implementation that is never the one running on the device (metro.config.js aliases to react-native-quick-crypto). The contact points are the ones where two OpenSSL implementations diverge the most: `createDecipheriv('aes-256-gcm')` + `setAuthTag` with the tag cut from the end of the buffer, `createPrivateKey({format:'jwk'})`, `privateDecrypt` with `oaepHash: 'sha256'`, and the fact that an authentication failure must return `null` rather than throw. A version bump that broke one of the four would pass tsc and the 9 tests, and would give "Déverrouillage impossible" ("Unlock failed") on the device with no prior signal.

**Fix.** A harness run on the device (or in e2e/harness/) replaying the vectors of crypto.test.ts (v2 envelope, v1 envelope, GCM content, CBC content) through the module actually loaded, with a loud failure. Failing that, a Node test that asserts at least the SURFACE used on the module resolved by the Metro alias.

#### 🟡 medium: `lib/server.ts` has no test although it drives the whole login screen

`lib/server.ts:58` · not put to the refuter · fix risk: none

`normalizeUrl` carries precise and counter-intuitive rules, all justified in comments: https scheme assumed, sub-path KEPT (`origin + pathname`) because a reverse proxy often serves Rocket.Chat under `/chat`, slashes trimmed, invalid URL as a `ServerError`. `probeServer` is no better covered: parallelisation, absorption of rejections, `abort()` of the sibling request, conversion of the settings into a `ServerProfile`. A "simplification" to `new URL(x).origin` would pass every test and make the server unreachable for any user on a sub-path.

**Fix.** Create lib/server.test.ts: a table of cases for `normalizeUrl`, and for `probeServer` inject the fetch (extract `fetchVersion` behind the same injection point as `RestClient`, which also settles its lack of a timeout, transport workstream), then cover a non-JSON `/api/info`, `settings.public` without an array, the 2FA/OAuth flags, and the cancellation that cuts both requests.

#### 🟡 medium: The debounce and the screen-exit flush of drafts are tested nowhere

`ui/drafts.ts:104` · not put to the refuter · fix risk: low

The hook's correctness depends on an unexpressed detail: the flush effect has `[write]` as dependencies, and `write` depends on `[base, key]`: this is the ONLY thing that guarantees the cleanup runs with the `write` of the OLD key. Nothing locks this invariant down: no type, no test, no assertion. Someone stabilising `write` with a ref (a common pattern) would turn the effect into `[]`: the draft of room A, left in under 400 ms, would be lost or written under B's key.

**Fix.** Extract the mechanism into an object testable under Node (`createDeferredDraft({write, timeoutMs, schedule, cancel})`, clock injected like lib/reconnect.ts) and cover: one keystroke → one write, two close keystrokes → only one (the last), empty text → deletion, unmount during the pause → flush, KEY CHANGE during the pause → flush under the OLD key and nothing under the new one. To be combined with moving the drafts into the queue (workstream 2).

#### 🟡 medium: The pure logic of the room screen and the home screen is buried in components, hence untestable

`app/room/[rid].tsx:295` · not put to the refuter · fix risk: low

`dataWithBar` (l.295-312) holds three simultaneous conventions in 17 lines (DESC data so the LAST occurrence is the OLDEST unread, inverted list so i+1 renders above, exclusion of my own messages) plus a case where `client.auth` is null and `myUid` is `undefined` (the bar can then sit above one of MY messages). Same situation for `useSmoothedData`, `historyPath`, the exhaustion predicate of `loadMore`, and for the grouping of app/index.tsx:126-148 (`?.open !== false` hiding, rising on `alert`, empty sections removed). An "optimisation" to a `break` at the first index would put the bar under the most recent message, without any test failing.

**Fix.** Extract four pure functions and test them: `insertUnreadBar(dataDesc, lastSeen, myUid)`, `useSmoothedData` moved to ui/smoothedData.ts with an injectable clock, the exhaustion predicate, and `buildSections(rooms, subscriptions, titles)`. These extractions are part of the risk-free split of the next workstream and must COME BEFORE it.

---

### 13. A single source per concept: i18n, colours, formats, MIME tables

**Max severity** 🟡 medium · **fix risk** low · **effort** day

Commit 4dc5df6 migrated the whole app to `t()`, but four islands were missed and are invisible to the FR/EN parity test, since they are not in the catalogue: each message's time formatted in hard-coded `fr-FR`, the typing indicator ("bob écrit…", "bob is typing…"), the error messages of lib/profilePreload.ts and lib/uploadQueue.ts that reach the screen as is. A user in English therefore sees French sentences in an English interface. On top of that come three competing definitions of the presence colours (with three different shades for the same status) and two MIME→emoji tables that already diverge. Low risk, immediate consistency gain, and it prepares the split of the composer.

#### 🟡 medium: Message times are formatted in hard-coded `fr-FR`, and the typing indicator is in French outside the catalogue

`ui/messageRow.tsx:66` · not put to the refuter · fix risk: low

`toLocaleTimeString('fr-FR', …)` at lines 66 and 193: the ONLY TWO hard-coded `toLocale*` in the repo (the other `toISOString` are API parameters). Same family: `phraseSaisie` (lib/typing.ts:120-125) builds "bob écrit…", "bob et carol écrivent…", "3 personnes écrivent…" without any key; ui/messages.ts contains none for typing, so the parity test sees nothing. In English: "14:05" instead of "2:05 PM", and "bob écrit…" above the composer.

**Fix.** A `useTimeFormatter()` in ui/i18n.ts returning an `Intl.DateTimeFormat` memoised on the active language, called at both places. `phraseSaisie` returns data (`{names, n}`) and the phrasing moves to the catalogue (`room.typingOne/Two/N`); lib/typing.test.ts:96-102, which asserts the French strings, is rewritten on the structured shape.

#### 🟡 medium: Error messages shown to the user are hard-coded in French, duplicating existing keys

`lib/profilePreload.ts:125` · not put to the refuter · fix risk: low

`'Profil illisible.'` and `'Profil introuvable.'` hard-coded, whereas `profile.profileUnreadable` / `profile.profileNotFound` exist in the catalogue and are indeed used by app/profile.tsx:141-145, but only on the ASYNC loading path; the NOMINAL path (`preloaded.error`) shows the hard-coded version. `git log` confirms the cause: the file was created on 2026-07-13 at 11:49, the i18n migration commit is from the same day at 17:34. Same pattern in lib/uploadQueue.ts:85 and :94 ("Fichier trop lourd (maximum X Mo).", "Type X refusé par le serveur.", that is "File too large (maximum X MB).", "Type X refused by the server.") and lib/outbox.ts:176, whose messages reach the screen as is through `setFileError(e.message)`.

**Fix.** In lib/profilePreload.ts, `translateCurrent(...)` (designed exactly for this case, ui/i18n.ts:101). For lib/uploadQueue.ts and lib/outbox.ts (pure modules tested under Node, which must NOT import the i18n), make `ValidationError` carry a code (`'size'`, `'type'`) plus its parameters, and translate at the display point.

#### 🟡 medium: Three competing definitions of the presence colours, with three different values per status

`ui/presence.ts:14` · not put to the refuter · fix risk: low

`COULEURS_PRESENCE` (#2de0a5 / #ffd21f / #f5455c / #9ea2a8, used by the list and the DM subtitle), `PRESENCE` hard-coded in app/profile.tsx:33-38 (#3BD16F / #F5B03E / #E8506B / #8A8FA3, with a comment "same words as a DM's subtitle", wrong for the colours), and the theme tokens (#3ED67F / #FFC24B / #FF7A8A / #5A5573, used by app/my-profile.tsx). The labels are duplicated the same way: `salon.presence*`, `profil.presence*`, `monProfil.presence*`, twelve keys for four words, already diverging in case. Yet ui/kit.tsx explicitly forbids hard-coded colours.

**Fix.** Make `COULEURS_PRESENCE` the only source, fed by the theme tokens, remove the table of app/profile.tsx and the mapping of app/my-profile.tsx, and reduce the twelve keys to four `common.presence*`, leaving the case to the caller.

#### ⚪ low: Two MIME→emoji tables, already diverging on the audio case

`ui/attachmentPreview.tsx:34` · not put to the refuter · fix risk: low

`fileEmoji` (ui/attachmentPreview.tsx:34-40) and `emojiPiece` (app/share.tsx:387-394) are the same mapping written twice; `emojiPiece` handles `audio/` → 🎵, the other does not. The surroundings are duplicated likewise (`isImage` in two places, degraded thumbnail rebuilt in `AttachmentThumbnail`). Any family added to one will not be added to the other.

**Fix.** Export a single function (from ui/attachmentPreview.tsx or a ui/mime.ts), with the `audio/` branch (harmless for the composer's preview, which diverts audio to `AudioPlayer`), and remove `emojiPiece`.

#### ⚪ low: The body of markdown messages carries no font family

`ui/markdown.tsx:306` · not put to the refuter · fix risk: low

ui/markdown.tsx never imports `FONTS`: `styles.paragraph` only declares `fontSize`/`lineHeight`, and the `<Text>` of the PARAGRAPH block is nested in no parent `<Text>` (only `<View>`s), so nothing is inherited. The body of every message that has an `md` comes out in the system font, next to the `RenderGuard` fallback and the quoted text, which are in Nunito. On top of that come three `fontWeight`s, whereas ui/theme.ts:189-206 documents one family PER weight and concludes "never add a fontWeight to it" (Android's synthetic faux bold). Same omission in app/search.tsx and app/message-search.tsx.

**Fix.** `fontFamily: FONTS.body` on `paragraph` and `itemText`, and replace the `fontWeight`s with the families (`FONTS.title`, `bodyBold`, `bodySemi`): both together, never one without the other.

#### ⚪ low: The media components hard-code dark colours, which invalidates the theme's "three edits" promise

`ui/imageViewer.tsx:240` · not put to the refuter · fix risk: low

ui/theme.ts:10-17 claims that wiring the theme toggle back "will take THREE edits". That is already false: `rgba(4,3,10,0.94)` (viewer), `rgba(12,11,22,0.80)` and `:186` (videoPlayer), `#00000020` and `rgba(12,11,22,0.42)` (embedCard), linkCard:197-202, and ui/kit.tsx itself (`textColor = '#FFFFFF'`, a hard-coded boxShadow) while claiming "never a hard-coded colour here". On the day of the toggle, it will be a hunt for hues across six files, and an 80 % black scrim on a white background.

**Fix.** Add the two tokens that are really missing (`mediaScrim`, `fullScreenBackground`) to both sets and replace the six literals. Fix the "THREE edits" sentence of theme.ts: it serves as a contract, so it must stay true or disappear.

---

### 14. Structural duplication and splitting the room screen

**Max severity** 🟡 medium · **fix risk** medium · **effort** several days

Three copy-pastes have already cost, or will cost, a fix written twice: `catchUpUpdated` / `catchUpDeleted` (commit ffe1f7c had to apply the SAME cursor fix in two hunks of the same commit), the room composer / thread composer (the thread lacks the keyboard dismissal before a picker that fixes the view-tree NPE, and will reproduce it the day it gains attachments), and the debounce of the two search screens (already diverged). Add to that the room screen at 1,397 lines, two of whose components move WITHOUT RISK (props only, module-level stores) and bring it down to ~450 lines. Placed at the end of the sequence deliberately: it is pure refactoring, so to be done when the tests of the previous workstreams are in place and no functional fix is in flight in these files.

#### 🟡 medium: `app/room/[rid].tsx` mixes three responsibilities over 1,397 lines; two can be extracted with no risk at all

`app/room/[rid].tsx:161` · not put to the refuter · fix risk: low

The file carries the list engine (l.161-706), the full composer (l.708-1156: pickers, audio, emojis, mentions, quotes, NPE workaround), the header (l.1158-1291), a Rocket.Chat REST utility (`historyPath`) and a generic hook (`useSmoothedData`). A consequence already visible in this audit: the three most costly defects of the domain (double catch-up, `n > 1`, `markRead` rate) live in the same soup of effects as the choice of an attached file. The history shows three successive fixes on the picker launch alone (ad8ecec, e06f658, c9e6694).

**Fix.** PURE moves, no line of logic changed: `Composer` + `ComposerChiffre` + `assetToFile` → ui/composerSalon.tsx (~420 l., 11 explicit props, external couplings only through module-level stores); `RoomHeader` → ui/roomHeader.tsx (~135 l., props only); `useSmoothedData` → ui/smoothedData.ts; `historyPath` → providers/rocketchat/. Do NOT extract `useFluxSalon` (limit/fresh/data/nearBottom/lastTracked/passExhausted arbitrate one another, and the inverted idiom is a measured scar) as long as the pure functions are not tested.

#### 🟡 medium: The thread composer is a diverged copy of the room composer

`app/thread/[id].tsx:330` · not put to the refuter · fix risk: medium

`ComposerFil` takes up `Composer` point by point: same `useEmojiCompletion`, same `useEmojiPanel`, same `useReply`/`cancelReply` + `useHardwareBack` pair, same `change`/`changeDraft`, same `send`, same banners, down to the comment "`:` and `@` tokens mutually exclusive" copied word for word. The divergences are already there: a different border, NO `FONTS` family (so the thread screen displays in the system font), a text send button instead of the ➤ tile, and four duplicated translation keys (`fil.chiffre` = `salon.chiffre`, etc.). Above all, the thread lacks the `closeEmoji()` + `Keyboard.dismiss()` that the room does before launching a picker.

**Fix.** Extract `ui/composer.tsx` carrying the common trunk, parameterised by what really differs (📎/🎤 presence, reply key `rid` vs `rid:threadId`, `threadId` passed to `outbox.send`, placeholder). Prerequisite: the move of the room composer above. Merge the duplicated `thread.*` keys into `common.*`.

#### 🟡 medium: `catchUpUpdated` and `catchUpDeleted` are two copies of the same pagination loop

`lib/catchUp.ts:227` · ✅ verified · fix risk: medium

The two functions have the same structure line for line: `for (page < PAGES_MAX)` loop, `cursorPage`, `isDiscarded` guard, computation of `next`, "last page" branch advancing on the largest ingested timestamp, cursor write, cap `console.warn`. Only the `type`, the stream name and the ingestion body differ. `git show ffe1f7c` shows that the fix "move the cursor forward on the LAST page" was applied TWICE in the same commit, with "see catchUpUpdated, same reasoning" as the only link.

**Fix.** `paginateCursor(client, rid, type, stream, since, isDiscarded, apply)` carrying the loop, the cursor and the cap, with as its only parameter `apply(result) => Promise<number | null>`, which returns the largest timestamp processed. The two callers drop to three lines. Do it AFTER the per-rid deduplication (workstream 5), which touches the same file.

#### 🟡 medium: Debounce + sequence guard copied between the two search screens

`app/search.tsx:85` · not put to the refuter · fix risk: low

The same block (`sequence = useRef(0)`, `const n = ++sequence.current`, `setTimeout(…, clean === '' ? 0 : 300)`, short-circuit on an empty query, `if (sequence.current !== n) return` in the `.then` AND the `.catch`, `clearTimeout` on cleanup) in both screens, the second admitting it in a comment ("Same idiom as the spotlight"). The copy has already diverged on clearing the error message (see workstream 1).

**Fix.** `useDebouncedSearch<T>(query, search, timeoutMs = 300)` encapsulating the timer, the sequence guard and a full reset (results AND message) on an empty query.

#### 🟡 medium: "Open or create a DM" is implemented twice, with two different handlings of the response

`app/profile.tsx:180` · not put to the refuter · fix risk: low

app/profile.tsx:180-186 posts `im.create`, guards `typeof rid !== 'string'` and conditionally ingests the room; app/search.tsx:119-121 does the same POST but passes the response to a local helper with an `as string | undefined` cast. Both have already diverged on validation and on error handling (catch vs finally), and neither goes through `ProviderActions`.

**Fix.** `openOrCreateDm(username): Promise<{ rid, rawRoom }>` on `ProviderActions`, implemented once in providers/rocketchat/actions.ts with the type guard. The two screens then only have to call and navigate.

#### ⚪ low: The rendering of attachment images is written twice in the same file, with different bounds

`ui/messageRow.tsx:355` · not put to the refuter · fix risk: low

`QuotedFile` (l.355-381) and the image branch of `Attachments` (l.485-527) redo the same sequence (source `title_link ?? image_url` with the same justifying comment, `protectedFileUrl`, ratio with the same defensive `Math.max(…, 1)`, `Pressable` + viewer + `Image cover`) with bounds that have already diverged (72..200 over a fixed 200 vs 120..400 over `availableWidth`). `Math.min(screenWidth - 92, 380)` is moreover duplicated identically in ui/linkCard.tsx:45.

**Fix.** `<AttachedImage c attachment client maxWidth minHeight maxHeight onLongPress />` carrying the choice of source, the protected URL, the layout and the opening; export `availableBodyWidth(screenWidth)` from ui/theme.ts.

#### ⚪ low: Dead code: `lightColors` and five unused translation keys

`ui/theme.ts:141` · not put to the refuter · fix risk: low

`lightColors` (~28 lines of tokens) is referenced only by a comment, `useColors` always returning `darkColors`. Five keys are referenced by no file (`commun.erreur`, `commun.chargement`, `commun.copier`, `commun.ok`, `salon.chiffre`, the last one a word-for-word duplicate of `fil.chiffre`), that is ten dead entries across the two catalogues.

**Fix.** Delete (Git keeps it) or wire `lightColors` behind `useColorScheme()` together with the `mediaScrim`/`fullScreenBackground` tokens of the previous workstream; remove the five keys.

---

### 15. The Provider facade: whatever names Rocket.Chat must go through it

**Max severity** 🟡 medium · **fix risk** medium · **effort** day

The abstraction is clean and exhaustive on sync and actions, but it is bypassed exactly where it matters: the room screen imports `catchUpRoom` from lib/catchUp.ts, names three REST endpoints (`channels/groups/im.history`) and builds the stream keys `${rid}/deleteMessage` and `${rid}/user-activity` itself. There are therefore TWO paths for the same catch-up, one routed, the other hard-coded, and the Rocket.Chat key format is duplicated in two screens plus `topicOf`. A purely structural gain, no user bug today: do it last, once the split of the room screen has already moved `historyPath`.

#### 🟡 medium: The `Provider` interface has no seam for PER-ROOM subscriptions

`lib/provider.ts:208` · not put to the refuter · fix risk: medium

The header sets the rule ("everything that names an /api/v1/* endpoint or a stream-* stream must eventually go through here") and the contract provides `initialSubscriptions()` for GLOBAL subscriptions. Nothing covers the subscription to the open room, though it is permanent: app/room/[rid].tsx:358-360 and app/thread/[id].tsx:205-206 import `STREAM_MESSAGES`/`STREAM_NOTIFY_ROOM` from lib/sync.ts and build the keys by hand. The "rid + / + topic" format is thus duplicated in two screens, in `topicOf` and in a comment of ui/hotRooms.ts.

**Fix.** `roomSubscriptions(rid): readonly (readonly [name, key])[]`, symmetrical to `initialSubscriptions`, implemented in providers/rocketchat/index.ts, with the screens looping over its result. This also removes the stream-name imports from app/.

#### 🟡 medium: The room screen bypasses the facade by calling the Rocket.Chat implementation directly

`app/room/[rid].tsx:44` · not put to the refuter · fix risk: medium

lib/provider.ts:216-218 exposes `catchUpRoom(engine, rid, isDiscarded)` and ui/sync.tsx does call it through this path, but the screen imports the function from lib/catchUp.ts with the `RestClient` in hand. The same screen names `channels.history`/`groups.history`/`im.history` (`historyPath`), and app/thread/[id].tsx calls `chat.getMessage` and `chat.getThreadMessages` directly. A second driver (Mattermost, anticipated by `ProviderKind`) would see each room opening emit `chat.syncMessages` on a nonexistent route.

**Fix.** Add `loadHistory(rid, type, latest)` to the `Provider` interface (implemented on the RC side by `historyPath` + `chat.getThreadMessages`) and route the screen through `sync.provider` for the catch-up as for the history: the provider is already carried by the context. Do it AFTER the per-rid deduplication (workstream 5), of which it is the natural extension.

#### 🟡 medium: The quote permalink is built on `client.baseUrl` whereas the server only accepts `Site_Url`

`lib/quote.ts:21` · not put to the refuter · fix risk: low

The module's doc says so itself (l.18): the `BeforeSaveJumpToMessage` hook only recognises a quote if the URL STARTS WITH `Site_Url`. `lib/server.ts:142-147` does retrieve `siteUrl`, but a grep returns only these three lines: the value is neither stored in the `Session` nor read anywhere. As soon as the entered URL differs (proxy alias, IP, port, http/https; the case of the emulator bench: `10.0.2.2:3300` vs `localhost:3300`), the server does not attach `message_link`. Worse than "no block": the optimistic display SHOWS the quote, then the server echo overwrites `attachments` and `withoutQuoteLinks` removes the raw link from the body: the final message no longer bears any trace of what it was replying to.

**Fix.** Propagate `siteUrl` from the probe up to the `Session` (already read) and make `messagePermalink` a consumer of `siteUrl ?? baseUrl`: zero extra network calls, and a fallback identical to the current behaviour when the setting is missing. A test in lib/quote.test.ts with `baseUrl !== siteUrl`.

#### ⚪ low: `lib/`, declared a "non-UI core", drives navigation

`lib/profilePreload.ts:22` · not put to the refuter · fix risk: low

The module imports `{ router } from 'expo-router'` and calls it at 113 and 164; on top of that it holds a singleton REST client, a cache and a state store with listeners. It is the only dependency inversion in the repo (the only other crossing, lib/systemMessages.ts → ui/messages.ts, is a recorded `import type`). A direct and measurable consequence: it is the only module of lib/ without a `.test.ts`, because it cannot be loaded under Node, so the race between `users.info`, the call probe and the 2 s cap remains entirely untested.

**Fix.** Make the module pure: `precharger(p): Promise<RawProfile | null>`, which returns the decision, navigation staying with the caller. If the call from ui/markdown.tsx imposes a singleton, `setProfileNavigator((p) => router.push(...))` from ui/, on the model of `setProfileClient` already in place.

---

### 16. Bring the documentation back in line with the code

**Max severity** 🟡 medium · **fix risk** none · **effort** hours

CLAUDE.md designates EXECUTION.md as the "source of truth on where we are", and this file is 110 commits behind: neither read-side E2EE, nor Jitsi calls, nor i18n, nor quotes, nor the multi-provider facade, nor the room caches appear in it, and its progress table claims step 9 is iOS whereas the body of the document says theme. Symmetrically, ROADMAP.md §4.2, EXECUTION.md:52 and CLAUDE.md:50 declare the WebView "strictly forbidden" whereas react-native-webview is an ordinary dependency and the call screen mounts it full screen, to the point that ui/embedCard.tsx cites as its authority the very section the call screen violates. Zero risk, an hour's cost, and it prevents a future session from reimplementing or deleting shipped work.

#### 🟡 medium: EXECUTION.md, declared the source of truth, is 110 commits behind and its table renumbers the steps wrongly

`EXECUTION.md:77` · ✅ verified · fix risk: none

`git log -1 -- EXECUTION.md` gives ee1a4aa and `git rev-list --count ee1a4aa..HEAD` gives 110. Missing from the document: full read-side E2EE (8 commits), Jitsi calls, EN/FR i18n, quotes, multi-provider facade, WorkManager catch-up for push, room caches, which nonetheless carry measured performance decisions. The "Progress" table lists "9 | iOS | ☐" whereas the body has "Step 9 - Visual theme" (9.4 unchecked) and "Step 10 - iOS".

**Fix.** Fix the table to reflect the real numbering (9 = theme, partial; 10 = iOS) and add a section "Step 11 - post-theme work" listing, one line each, the building blocks shipped since ee1a4aa, with a pointer to the file that carries the justification. Or, if the ceremony really is lifted, fix CLAUDE.md:7 so that the file no longer claims to be the source of truth.

#### 🟡 medium: The call screen's WebView is recorded in none of the three documents that declare it forbidden

`ROADMAP.md:150` · ✅ verified · fix risk: none

ROADMAP.md:150, EXECUTION.md:52 and CLAUDE.md:50 set "any WebView" as strictly forbidden, never amended. Yet react-native-webview 13.16.1 is an ordinary dependency (package.json:45) and app/call/[callId].tsx:164 mounts it full screen; the justification exists only in the code comments (l.22-29, lib/call.ts:16-19). Worse, ui/embedCard.tsx:4 and lib/videoLinks.ts:10 write "a WebView (forbidden, ROADMAP §4.2)": the very section the call screen violates.

**Fix.** Amend ROADMAP §4.2 with a one-line bounded exception ("react-native-webview: ONLY app/call/[callId].tsx, Jitsi being a web app; the native SDK targets RN ~0.79 and ships react-native-webrtc"), reusing the reasoning already written in lib/call.ts, and carry the "except the call screen" over into EXECUTION.md:52 and CLAUDE.md:50.

---

## The order of attack, and why

1. The one-line batch: seven verified fixes, each in a single file, two of them high severity; it is the best gain/risk ratio in the repo, and two of them (the generation not bumped by E2EE, the upload guard) are prerequisites of later workstreams.

2. One write queue per SQLite connection: two lines in db/client.ts that make impossible the only race able to cancel a batch silently; a strict no-op on the nominal path, so to be done before anything that will touch the database.

3. Zero secrets outside the process: the only critical finding of the audit (the token in Chrome) plus three leaks of the same family; independent of everything else, so to be done as soon as the surface is calm.

4. What enters the database must be right: fixes to pure functions and static SQL, with the tests of lib/normalize.test.ts written in the same commit; to be done before the purge workstreams, which manipulate the same tables.

5. Deduplicated room catch-up: the deduplication lives in lib/catchUp.ts, so no caller signature moves; it assumes the `generation` fix (workstream 1) is in, and must ship the `activeRoom` stack, without which it turns a debt into a real loss of catch-up.

6. Lifecycle of local data (purge, cursors, retention): it touches DELETEs, so after the normalisation workstream and with the store tests written first; the reconciliation race is the only one of the batch that makes visible data disappear.

7. Upload queue: the largest functional workstream: write FIRST the missing tests (status 0, the queue's SQL), then the "en attente" ("pending") banner that removes the silent disappearance, and only then the `file_id` migration that removes the duplicate.

8. DDP and REST transport: liveness probe, suspending the driver in the background, `/api/info` timeout, interruptible 429 sleep; modules already well covered, to be handled in one block so as to pay for a single campaign of reconnection tests.

9. Dead session and end of session: placed here because automatic logout on 401 is the most dangerous fix of the audit: write the `isTokenRejected` predicate and its four-case test BEFORE wiring it, and do first the part with the E2EE key keyed by account, which is risk-free.

10. Native push: a single pass, a single prebuild + assembleRelease cycle (status tested without a pipe); ship the host validation of workstream 3 with it so as not to pay for two builds.

11. Screens: unbounded loops and fixed waits: independent of the rest, but after the catch-up workstream, which already touches app/room/[rid].tsx, so as not to stack two series of changes on the same file.

12. A test net where the code cannot be reached: zero risk by construction, and imperative BEFORE the split: the fake stores that lie about `transaction` and the pure functions of the room screen are exactly what will protect the next refactor.

13. A single source per concept (i18n, colours, formats, MIME): prepares the shared composer by removing the style and key divergences between room and thread.

14. Structural duplication and splitting the room screen: pure refactoring, to be done when no functional fix is in flight in these files any more and the tests of workstreams 12 and 13 are in place; start with the four risk-free moves, leave the list engine alone.

15. The Provider facade: the natural extension of workstream 5 and of the split (`historyPath` has already moved); a structural gain only, no user bug pending.

16. Documentation: one hour, zero risk, to be done last so that EXECUTION.md describes the real state after all the workstreams rather than an intermediate state.

---

## Do not touch

What was flagged during the audit but is better left as is, either because the fix risk exceeds the gain, or because it is a deliberate choice.

- The double read of `setUpConnection` (lib/connectionSetup.ts:89 and 104, two `catchUpAll` per connection setup). The finding is real (2 x rooms.get + 2 x subscriptions.get at each return to the foreground, on a route limited to 10 req/min), but the second read is WHAT guarantees that no document falls between the read and the arming of the subscriptions. Making it conditional touches the heart of the connection setup, with no non-regression test today. To be revisited only after the "deduplicated catch-up" workstream (which already removes most of the waste) AND once lib/connectionSetup.test.ts has been extended.

- Decoupling the `SyncProvider` effect from the `state` object (key `baseUrl|userId|authToken` as the dependency). Proposed by two reviewers, contradicted by a third after verification: `RcTranslator` and `OutboxEngine` capture `session.username` at construction (providers/rocketchat/index.ts:40), so freezing the key breaks the display name and the `dmOtherUsername` of DMs after a rename. The real fix (memoising the write queue with the connection) removes the danger without touching the dependencies; the needless rebuild of the engine on a rename then becomes mere waste, to be handled later with a translator that rereads its username.

- The 24 eslint react-hooks/immutability and refs errors of ui/imageViewer.tsx and ui/audioPlayer.tsx. Verified: they are `SharedValue` writes in gesture worklets, that is Reanimated's normal API, which the rule (React Compiler model) does not model. `flatten` does carry its `'worklet'` directive. The only debatable case, `me.current.pause = …` written during render, is benign (the coordinator compares the object's identity, never the closure). Touching them would only add indirections.

- The "inverted list + maintainVisibleContentPosition off" idiom and the smoothing of incoming messages in app/room/[rid].tsx (comment l.74-99), as well as the secondary sort key `desc(messages.id)`. These are measured scars, not oddities; the split of the file must touch neither the list engine nor these settings.

- The `setTimeout` of ui/launchPicker.ts. It is the only fixed delay in the repo that is explicitly argued (Android view-tree NPE when launching a picker, three successive fixes: c9e6694, e06f658, ad8ecec). The "no wait as a fix" rule targets data synchronisation, not documented workarounds for platform bugs.

- `closeDatabase` (db/client.ts:45): do NOT call it in the cleanup of `SyncProvider`. The connection is shared and the cleanup runs while writes from the old engine may still be in flight: closing under them is worse than leaving the connection open. The right move is to document the choice in db/client.ts and to filter `databaseName` in ui/liveQuery.ts (finding kept), not to call the function.

- The WebView exception of app/call/[callId].tsx. The native Jitsi SDK targets RN ~0.79 and ships react-native-webrtc: the exception is justified and must stay. What is needed is to record it in ROADMAP §4.2 and bound it to one origin, not to call it into question.

- `Push_request_content_from_server` (push without content, `push.get` on receipt). It is a dated user decision (2026-07-16: nothing at Google/Apple). Every push finding must work with it, never propose lifting it.

- Do not pass a client `_id` to `rooms.mediaConfirm` to deduplicate uploads: the server schema is `additionalProperties: false`. Deduplication must go through persisting the `fileId` on the client side, as kept in the uploads workstream.

- Do not remove the long press of app/room/[rid].tsx:584 and app/thread/[id].tsx:245 to settle the empty action sheet: it would be the same rule duplicated in two screens, and it would remove the haptic feedback that confirms the press registered. The fallback goes in app/message-actions.tsx.

---

## The refuted findings

7 findings of high or critical severity were **demolished** by the adversarial refuter. They are recorded here so that a future session does not rediscover them.

### A `ready` followed by the socket's death in the same JS turn marks the subscription as established on a dead socket: it is never re-armed

`lib/ddp.ts`

**The code described is accurate; the trigger, however, does not exist on the architecture the project imposes.**

1. What the code says (read in full, `lib/ddp.ts` 1-589). `establish()` l.330-345 only tests `this.wanted.get(key) !== entry`; `cleanUp()` l.566-569 resets `s.id = null` synchronously; `establish()` l.325 exits on `entry.id !== null`. I replayed the scenario in a Node harness (FakeWebSocket, `receive({msg:'ready'})` then `onclose(null)` in the SAME synchronous turn, without letting the microtasks drain): `etat= ferme  etablies= 1  desirees= 1`, then full reconnection → `subs sur la nouvelle socket = 0`. The internal mechanism is therefore real, and `lib/ddp.test.ts` (505 l., read in full) does not lock it down: the closest test, "closing the socket lets the negotiation settle cleanly" (l.310), closes BEFORE the `ready`.

2. But the premise "RN bridge batching: several native events are delivered before the microtasks drain" is false for RN 0.86 in the New Architecture, which is mandatory here (CLAUDE.md, and the legacy bridge no longer exists since 0.82). Chain verified in `node_modules/react-native`:
   - `ReactAndroid/.../modules/websocket/WebSocketModule.kt` l.62-65, 167/185: each event goes through `reactAppContext.emitDeviceEvent(...)`, one call per event, `websocketMessage` as well as `websocketClosed`.
   - `runtime/BridgelessReactContext.kt` l.156-162: `emitDeviceEvent` → `reactHost.callFunctionOnModule("RCTDeviceEventEmitter","emit",…)`.
   - `ReactCommon/react/runtime/ReactInstance.cpp` l.300-314 + l.159-162: `callFunctionOnModule` → `bufferedRuntimeExecutor_` → `runtimeScheduler->scheduleWork(...)`.
   - `RuntimeScheduler.cpp` l.26: under `enableBridgelessArchitecture()` it is `RuntimeScheduler_Modern`. And `ReactNativeFeatureFlagsOverridesOSSStable.h` l.16-19 forces this flag to `true` for every published OSS app.
   - `RuntimeScheduler_Modern.cpp` l.293-322: `runEventLoop` loops over `runEventLoopTick`, and **each tick does `executeTask(...)` THEN `performMicrotaskCheckpoint(runtime)`** (l.313-315), which calls `runtime.drainMicrotasks()` in a loop until exhaustion (l.414-421, unbounded).

   In other wo

*(justification truncated)*

### A login `result` followed by the socket's death in the same turn leaves the client "authenticated" with `ws === null`: the driver believes the stream is active and no longer reconnects

`lib/ddp.ts`

## What I read

- `lib/ddp.ts` in full (589 l.), `lib/ddp.test.ts` in full (598 l.), `lib/reconnect.ts`, `ui/sync.tsx`.
- The React Native 0.86 sources present in `node_modules` (the real delivery path of WebSocket events).

## The mechanism described is accurate, on a model that does not exist in production

I first replayed the scenario so as not to reject it lightly (a throwaway script, the `FakeWebSocket` of the test file):

```
memeTour=true  -> connecter resolue; etat=authentifie; pertes=1; subs=0/1; wsFerme=false
   subs envoyees sur le fil: 0 ; garde active ? true
memeTour=false -> connecter resolue; etat=ferme;       pertes=1; subs=0/1; wsFerme=false
   subs envoyees sur le fil: 1 ; garde active ? false
```

So yes: IF `onmessage({result})` then `onclose()` are invoked in **the same JS macrotask**, the client ends up `state='authenticated'` with `ws === null`, zero `sub` sent, guard re-triggered: exactly the announced zombie. The reviewer is right about the internal mechanics.

But `memeTour=true` is not a model of the transport: it is the test calling `ws.onclose?.(null)` by hand, on the next line, without letting the microtask queue empty. It must therefore be shown that the real transport can produce this.

## The real transport cannot produce it

The only production caller: `providers/rocketchat/index.ts:39` → `new ClientDdp(urlWebSocket(...))` **without** `createWebSocket`, hence `lib/ddp.ts:153` → React Native's global `WebSocket`. No other injector outside the tests (grep on `createWebSocket|new ClientDdp`).

Real chain of an Android WebSocket event, verified in the sources:

1. `ReactAndroid/.../websocket/WebSocketModule.kt`: `onMessage` (l.185) and `onClosed` (l.167) each call `sendEvent(...)` → `reactAppContext.emitDeviceEvent(...)`. Two distinct calls.
2. `runtime/BridgelessReactContext.kt:156`: `emitDeviceEvent` → `reactHost.callFunctionOnModule("RCTDeviceEventEmitter", "emit", …)`, **one call per event**.
3. `ReactCommon/react/runtime/ReactInstance.cpp:310`: `bufferedRuntimeExecutor_->execute(...)`. `BufferedRuntimeExecutor.cpp`: outside the startup phase, fast path `runtimeExecutor

*(justification truncated)*

### The session token can be sent to an arbitrary host dictated by the push (single-session fallback + no verification of the host or the scheme)

`plugins/with-fcm-deeplink.js`

I read `plugins/with-fcm-deeplink.js` in full (760 l.), `lib/sessionStore.ts`, `lib/server.ts`, `lib/push.ts`, `lib/pushToken.ts`, `ui/notifications.tsx`, the generated manifest `android/app/src/main/AndroidManifest.xml` + `src/debug/AndroidManifest.xml`, `docker/.env`, `.gitignore`, and `git log -- plugins/with-fcm-deeplink.js`.

WHAT IS ACCURATE IN THE FINDING (code mechanics): yes, `readSession` (l.581-607) returns `fallback` when `nbCandidats == 1` even if no `baseUrl` matches (l.602), and `fetchContent` (l.647-686) builds the URL from the push's `host` (l.655-657) then sets `X-User-Id`/`X-Auth-Token` on it (l.660-661). There is indeed a broken invariant: the only thing that guarantees "the token only goes to the server it belongs to" is exact equality, and the fallback breaks it.

BUT THE THREAT PREMISE IS FALSE, so the scenario is not reachable:

1. **"Any Rocket.Chat server able to push to this app holds the app's Firebase credentials": the implication is reversed.** To deliver a data message to this token one must sign an FCM HTTP v1 request with the PRIVATE KEY of a service account of the app's Firebase project. That key is neither in the APK nor in the repo (`google-services.json` is gitignored, and the client file does NOT allow sending over HTTP v1 anyway; the legacy server key no longer exists, cf. `Push_UseLegacy=false` in CLAUDE.md). The hostile server "collecte.example" therefore cannot push. A third-party server the user connects to receives the FCM token (`lib/pushToken.ts`, `POST push.token`) but a token does not authorise sending. And the RC Cloud gateway only routes to the official app ids (CLAUDE.md). The set of possible senders = {whoever holds the Firebase service account} = the user's own server, that is precisely the owner of the stolen token. No escalation.

2. **The service is closed to local apps**: `android:exported: 'false'` (l.724 of the plugin); injection can only come from GMS's FCM channel.

3. **"In cleartext" is false in release.** The main manifest declares no `usesCleartextTraffic` and targetSdk = 36 → cleart

*(justification truncated)*

### The `Provider` facade is bypassed by the screens: Rocket.Chat endpoints and stream names hard-coded in app/, including a catch-up that already exists behind the contract

`app/room/[rid].tsx`

I read lib/provider.ts in full, providers/index.ts, providers/rocketchat/index.ts:75-78, ui/sync.tsx:240-370, lib/catchUp.ts:377-406, app/room/[rid].tsx (imports, 340-495, 1293-1299), app/thread/[id].tsx:165-210, lib/provider.test.ts, and the messages of the 5 commits that built the facade.

1) The FACTS cited are accurate, but the FINDING ("the facade is bypassed", high severity) contradicts what the code says about itself. The rule invoked is quoted truncated: lib/provider.ts:3-5 says "must **eventually** go through here", not "goes through here". The same file explicitly bounds the scope reached: ProviderActions (l.138-141) "The secondary reads (profile, search, room info, spotlight) **will be added here when their screens are routed**: they carry DTOs that are not defined in advance"; the Provider interface (l.196-197) "The ornaments still RC-only (presence, custom emojis, push, E2EE) stay outside this facade **in 4a**, guarded by capabilities, **to be absorbed later**". Commit 59bc618 ("Tier 4a") restates word for word "stay on `client`, guarded by `capabilities`, **to be absorbed in 4b/5**", and eb764a9 "Transitional (absorbed in 4b)". The finding therefore re-describes the documented progress of a migration under way, not a defect. This is exactly the case "a comment documents the choice as deliberate".

2) The failure scenario is UNREACHABLE as things stand. `ProviderKind` (lib/provider.ts:46) has only one member, `KINDS` likewise, `createProvider` has only one `case 'rocketchat'` clause, and no Mattermost driver exists in providers/ (a single subfolder, `rocketchat`). The scenario "createProvider does return a Mattermost object" assumes code that is not written; the day it is, the exhaustive switch breaks compilation (documented providers/index.ts:4-5) and the driver's author will necessarily go through these screens. No input state today produces an empty room, an empty thread or a failed DM. A "high" severity (= wrong behaviour visible to the user) is therefore greatly exaggerated: the current effect is nil.

3) The most concrete point of the finding, "catchUpRoom is byp

*(justification truncated)*

### No test ties the migrations to `_journal.json` / `migrations.js`: a migration present but not journaled passes green

`db/schema.test.ts`

**What the finding describes correctly.** The source divergence is real: `db/schema.test.ts:17-19` and `43-45` list the folder (`readdirSync(FOLDER).filter(f => f.endsWith('.sql')).sort()`), whereas `db/migrate.ts:40` does `await migrate(openDatabase(baseUrl, userId).base, migrations)` with `migrations` imported from `db/migrations/migrations.js`, which exports `{ journal, migrations: { m0000…m0011 } }`. And the grep confirms that no test mentions `_journal` or `migrations.js`: the only occurrences outside `node_modules` are `db/migrations/migrations.js:3`, `db/migrate.ts:17`, `db/migrations.d.ts` and `drizzle.config.ts`. `db/upserts.test.ts:52` moreover copies the same folder-based loader.

But the failure scenario does not hold, for four reasons.

**1. The ".sql present, journal missing" case requires going around the only producer.** `drizzle.config.ts` carries `driver: 'expo'` and `package.json` exposes only one way: `"db:generate": "drizzle-kit generate"`. This command writes the `.sql`, the `meta/NNNN_snapshot.json`, the journal entry AND regenerates `migrations.js` in a single pass. The repo confirms it on its 12 migrations: `git show --stat f98d696 -- db/` (migration 0011, the most recent) touches in the SAME commit `0011_safe_mach_iv.sql`, `meta/0011_snapshot.json`, `meta/_journal.json` and `migrations.js`. `git log -- db/migrations/meta/_journal.json` returns exactly the same list of commits as `git log -- db/migrations/`. No hand-written migration has ever existed here.

**2. The "merge conflict on `_journal.json`" branch is ruled out by the project's process.** CLAUDE.md: "Main branch: **`master`**. Direct commits, no PR." Single developer, no merge, hence no journal conflict to resolve badly.

**3. The really plausible variant is NOT silent.** If the journal is up to date but `migrations.js` is stale, `node_modules/drizzle-orm/expo-sqlite/migrator.js` (`readMigrationFiles`) does `const query = migrations['m' + journalEntry.idx.toString().padStart(4,'0')]; if (!query) throw new Error('Missing migration: ' + journalEntry.tag)`. That throws BEFORE any write, at the first launch, and `migrateDa

*(justification truncated)*

### `db/store.ts`: the only real implementation of the `Store` (385 lines) has no test, write queue included

`db/store.ts`

VERIFIED FACT: there is indeed no `db/store.test.ts` (`find . -name "*.test.ts"`: 36 files, none for `store.ts`), and `lib/sync.test.ts:243` as well as `lib/catchUp.test.ts:29` use in-memory fake `Store`s. The wiring of `db/store.ts` is therefore not covered. That is the only accurate point of the finding. Everything else (the mechanism, the scenario, the severity) does not stand up to the code.

1) THE FAILURE SCENARIO IS FALSE. The finding claims that removing `await raw.runAsync(DELETE_OUTBOX, [m.id])` (db/store.ts:114) would leave "each sent message with its `outbox` row pending after delivery", then a repost of the whole outbox history at each reconnection until the 429. `lib/outbox.ts` contradicts it twice:
   - nominal path, `OutboxEngine.runPass()` l.145-156: `const response = await this.client.post('chat.sendMessage', …)` THEN `await this.store.deleteOutbox(row.id);` (l.155): the outbox row is erased by the engine itself, BEFORE ingestion (`this.ingest(response.message)` l.156). Locked down by a test: `lib/outbox.test.ts:106`: `assert.equal(outbox.size, 0, 'the queue is emptied on success')`.
   - path of the replay of an already accepted `_id` (RC 8.5's "starred" 400), l.168-174: `const delivered = await this.messageDelivered(row.id); if (delivered !== null) { await this.ingest(delivered); await this.store.deleteOutbox(row.id); continue; }`: again an explicit `deleteOutbox`. Locked down by `lib/outbox.test.ts:151` ("a refused but ALREADY DELIVERED replay is reconciled, not marked failed") and :167.
   There is therefore no path where an outbox row survives a confirmed delivery without line 114. The worst effect of removing it: after a process kill between the HTTP response and `deleteOutbox`, the next `process()` makes ONE more 400 round trip + `chat.getMessage` per message concerned, then erases the row. One call, once: not a repost loop, no 429. Line 114 is a belt-and-braces reconciliation (its comment l.110-113 says so: "One of them carrying our `_id` proves delivery"), not the only rampart.

2) THE PURGE SAFEGUARD IS ALREADY TESTED, ELSEWHERE. `purgeMissingR

*(justification truncated)*

### `lock()` forgets the in-memory key BEFORE erasing the Keystore, and its rejection is caught nowhere

`lib/e2e/engine.ts`

CODE READ IN FULL: lib/e2e/engine.ts (173 l.), lib/e2e/engine.test.ts (152 l.), ui/sync.tsx:160-256, app/settings.tsx:369-423, lib/sessionStore.ts (137 l.), ui/e2e.ts, lib/sync.ts:170-185, db/store.ts:210-230, db/upserts.ts:199, and the native implementation node_modules/expo-secure-store/android/.../SecureStoreModule.kt.

1) THE ALLEGED TRIGGER DOES NOT EXIST. The finding rests entirely on "SecureStore.deleteItemAsync fails (Keystore key invalidated after a screen-lock change, a known Android case)". That is false at the native level. `deleteItemImpl` (SecureStoreModule.kt:243-264) touches NEITHER the Keystore NOR decryption:

    if (prefs.contains(keychainAwareKey)) success = prefs.edit().remove(keychainAwareKey).commit()
    if (prefs.contains(key)) success = prefs.edit().remove(key).commit() && success
    if (legacyPrefs.contains(key)) success = legacyPrefs.edit().remove(key).commit() && success
    if (!success) throw DeleteException(...)

Three `SharedPreferences.remove().commit()`, nothing else. `KeyPermanentlyInvalidatedException` can only occur in `getItemImpl`/`setItemImpl`, and in `getItemImpl` (l.156-158) it is CAUGHT and returns `null`, it does not even reject. The only possible rejection of `deleteItemAsync` is a `commit()` returning `false`, that is a storage failure (disk full / corrupted prefs). The concrete scenario described therefore does NOT produce the announced result: the path is unreachable through the mechanism invoked.

2) THE MAIN FIX PROPOSED IS A SECURITY REGRESSION. "Reverse the order: `await clear()` first, then `privateKey = null`": in the failure case (the only case where the order matters), the reversal leaves the RSA private key IN RAM and `isUnlocked` at `true`. The current order is the right one for a "forget everything" operation: the only part that cannot fail (clearing memory) is done first, unconditionally. The comment l.15/116 says exactly that ("Forget every key: memory and Keystore"). Applying the proposed fix would degrade the current strong guarantee in favour of a weak one.

3) THE THREAT MODEL EXPLICITLY EXCLUDES WHAT THE FINDING Q

*(justification truncated)*
