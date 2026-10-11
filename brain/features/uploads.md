# Uploads and downloads

Sending a file is a two-step server exchange (`rooms.media`, then `rooms.mediaConfirm`) behind a persisted queue that survives a kill and retries on reconnection. Desktop Rocket.Chat confirmations use a persisted attempt guard to prevent posting the same file twice; mobile still owes that guard. Downloading a protected file keeps the auth token inside the process and writes through a partial file. Both apps implement the same mechanism: mobile in `lib/uploadQueue.ts` (`UploadEngine`, the upload engine), desktop in `rv-core/src/uploads.rs` (`Uploads`).

## The server contract

`POST /api/v1/rooms.upload` was removed in Rocket.Chat 8.0. An upload is now two calls (see [the server contract](../architecture/rocket-chat.md)):

1. `POST rooms.media/<rid>`, multipart with the bytes in field `file`. It answers `{file: {_id, url}}` and posts **no** message: the file waits on the server, orphaned.
2. `POST rooms.mediaConfirm/<rid>/<fileId>` with an optional `{msg: caption}` and, for a file sent in a thread, `tmid` (passed to `sendFileMessage`, whose `Match` pattern accepts it in 8.5.1). This creates the message and answers it in full (`attachments`, `file`, `md`); both apps ingest that document like any other.

Replaying `rooms.mediaConfirm` on the same `fileId` has no usable answer (probed on 8.5): replayed at once, the server posts a second message but answers 200 with the first one; replayed minutes later, it refuses with `invalid-file` although the file was delivered. Its schema is `additionalProperties: false`, so a client `_id` cannot be added for server-side dedup. Deduplication is therefore entirely local.

## The queue and the local dedup

Each file is a row persisted **before** any byte leaves:

- Mobile: SQLite table `uploads` (`db/schema.ts`): `id`, `rid`, `uri`, `name`, `type` (MIME), `caption`, `status` (`pending` / `sending` / `failed`), `last_error` (diagnostic only, never shown), `file_id`, `created_at`.
- Desktop: table `uploads` in `rv-core/src/store.rs`: `id`, `rid`, `path`, `name`, `mime`, `caption`, `file_id`, `status` (`pending` / `sending` / `failed`), `temporary`, `created_at`, `confirm_started` (persisted before a Rocket.Chat confirmation leaves).

A pass processes rows in creation order, one pass at a time (a request during a pass is noted and run after it). For each row:

1. **Claim** it atomically (`pending` to `sending`; mobile `claim`, desktop `claim_upload`). A row another pass took is skipped.
2. If `file_id` is empty, send the bytes, then **write the returned `fileId` to the row before confirming** (mobile `recordFileId`, desktop `set_upload_file_id`). This is the point of the column: a lost confirm answer no longer means re-uploading the bytes.
3. If `file_id` is already set, ask the **local database** whether a message carrying that file exists: a `LIKE` on the attachments column for `/file-upload/<fileId>/` in that room (mobile `MESSAGE_WITH_FILE` in `db/upserts.ts`, desktop `Store::file_posted`). Found: the confirm had succeeded and only its answer was lost, so the row is settled without calling the server. The query is local, so it costs nothing against the 10-calls-per-minute REST limit.
4. When the database knows nothing (typical after a kill: no room screen was open, so no stream delivered the message), refresh **that room once** and ask again. Mobile calls `provider.catchUpRoom` (the per-room catch-up, wired in `ui/sync.tsx` with the session's abandon predicate so it stops at logout); desktop calls `SyncEngine::load_history`. This targeted REST call is paid only on that rare path.
5. Confirm, settle the row (delete it, delete its temporary file), ingest the returned message.

On desktop Rocket.Chat, `confirm_started` changes steps 3 to 5: the first confirm is durably marked before sending. An uncertain response (timeout, dropped connection, proxy/5xx error or unreadable success) leaves the row pending in "Checking delivery". Subsequent passes only look for its message, even if history is empty, fails or the room kind is unknown. A slow confirm can still be running when history answers, so absence is never proof that it is safe to post again. The same guard covers encrypted files, both while their key is in memory and after a restart; it is checked before any new encryption/upload. A recognized Rocket.Chat 4xx refusal clears the guard and requires explicit Retry. Checking rows do not block unrelated uploads; the existing 2/5/15/30 s scheduler checks them again. Discard stays available and does not retract a message already accepted by the server.

This deliberately prefers an unresolved delivery over an automatic duplicate: if the request never reached the server, or the message is outside both local retention and the latest history page, the row remains checking. The user can check the conversation, discard the uncertain row and stage the file again. The append-only desktop migration conservatively marks existing file ids as potentially confirmed, since older rows cannot tell whether their confirm was sent. The flag is ignored on Mattermost/kChat, whose existing post recovery remains unchanged.

Mobile still confirms when its local/room lookup finds nothing, including a failed refresh; it owes the persisted attempt guard (see [parity](../parity.md)).

**Recovery after a kill.** A row still in `sending` can only come from a run that died mid-upload. Desktop re-arms all of them when `Uploads::new` runs (one process owns the database). Mobile re-arms them on the first pass of the process, but **excludes the ids this JS runtime has in flight** (`IN_FLIGHT_HERE`, module level): `SyncProvider` can build a second engine over the same SQLite connection without stopping the first, and a blind re-arm would upload and confirm the same file twice (`REARM_IN_FLIGHT_UPLOADS`).

## Outcomes, retries and discard

- **Network unreachable** (status 0): the row goes back to pending and the pass stops. Mobile retries on the next connection (`afterCatchUp` in `ui/sync.tsx`) and after an E2E unlock. Desktop also retries on catch-up, and schedules its own retries at 2, 5, 15 then 30 s (`OFFLINE_RETRY`), shown as "retrying" in the strip.
- **Server refusal**: `failed`. Only the explicit Retry button puts it back (mobile `retry`, desktop `retry`); automatic passes never see failed rows.
- **Encrypted room still locked**: the row waits (pending), it does not fail.
- **Missing local file** (mobile cache purged by the OS): a plain error, so the row fails and can be discarded instead of waiting forever (`ui/transportUpload.ts`).
- **Discard** removes the row, **aborts the running transfer** (mobile: the upload task's `cancelAsync`, desktop: the tokio task's `AbortHandle`) and notes the id so the running pass ingests nothing. Without the abort the bytes kept going up and the file appeared after the user discarded it. After the confirm, the message exists and cannot be taken back.

## Validation

`FileUpload_MaxFileSize`, `FileUpload_MediaTypeWhiteList` (`image/*` matches any image) and `E2E_Enable_Encrypt_Files` (an encrypted room takes no file without it) are read from `settings.public` with `count=0`: since 7.0 its `query` parameter is ignored and pages stop at 50, which once made validation a silent no-op. Mobile memoises only a successful read; offline it validates permissively for that call. Mobile validates when a file is staged (a file the server would refuse never shows) and again at send, since the reduced copy may differ; desktop validates once, in `Session::attach`, as each staged file is queued. Mobile refusals carry data (`ValidationError.detail`), worded at display by `ui/fileValidation.ts`; desktop returns `uploads::Refusal`.

## Progress

The fraction lives only in memory, never in SQLite. Both engines publish a change only when the whole percentage changes (per-chunk re-renders would cost more than the upload).

- Mobile: `UploadEngine.progress` plus `subscribe`, read by `ui/fileProgress.ts`; the room screen (`app/room/[rid].tsx`) shows one line per row: waiting, "sending N %", or failed with Retry, and Discard on every line. The transport is `expo-file-system` `createUploadTask` (`ui/transportUpload.ts`).
- Desktop: `Uploads::progress` and a broadcast of the rid, forwarded as `SessionEvent::Upload`. GTK's upload strip (`Chat::refresh_uploads` in `rv-gtk/src/chat.rs`) shows a progress bar, or waiting / retrying / checking delivery / failed with Retry, and a discard button. `RestClient::upload` streams the bytes in 64 KiB chunks with a timeout of 60 s plus 1 s per 32 KiB. The whole file is read into memory first.

## Footguns

- **The multipart filename is the file on disk.** `createUploadTask` sends the disk name, not the `name` field, so a cache copy or a transcode would post as a random name. `ui/transportUpload.ts` copies the file under its real name into a private folder first (`uploadName` in `lib/attachment.ts`); `ui/prepareAttachment.ts` renames reduced outputs.
- **An upload can kill the DDP socket silently** on mobile. The end of every upload (success or failure) calls `reportUploadEnd` (`ui/uploadProbe.ts`), which makes the session probe its socket (`ddp.checkAlive`). See [mobile transport](../architecture/mobile-transport.md).
- **Temporary files only.** Settling deletes the local file only when it is the app's own copy: mobile `deleteIfTemporary` (`ui/temporaryFiles.ts`) checks the path is in the app cache; desktop deletes only rows marked `temporary` (pasted pictures, reduced copies, voice recordings), never a file the user picked in place.

## Encrypted rooms

The file goes up encrypted under its own AES-CTR key, named by the SHA-256 of its real name, with the file metadata encrypted under the room key in a `content` form field. The confirm carries `t: 'e2e'`, an encrypted `content` (caption, attachment with key and hash, file) and `fileContent`. The per-file key lives in memory only between the two steps: a process killed in between re-encrypts and re-uploads under a new key on mobile, and on desktop only when no confirm attempt has started. A desktop row with `confirm_started` only checks delivery; loss of its in-memory key never triggers a second send. Details in [E2EE](../architecture/e2ee.md).

## Downloads

Protected files (`FileUpload_ProtectFiles`) need `rc_uid` and `rc_token` in the query. Both apps add them **only to URLs on our own origin** (mobile `protectedFileUrl` in `lib/upload.ts`, desktop `media::protected_url`), because attachment links come from anyone and would otherwise carry our token to a third-party host.

`/file-upload/...` answers chunked, without `Content-Length`, so progress falls back on the size announced in the attachment (`downloadedFraction` in `lib/attachment.ts`; desktop `progress_text` in `rv-gtk/src/cards.rs`, which shows bytes received when no size is known).

### Mobile

- `lib/attachment.ts` (pure, tested under Node) picks the cache path: `jointes/<fileId>/<safe name>`, the server id as subfolder so two `invoice.pdf` never collide, the name sanitised so it cannot escape the folder (`safeFileName`), an extension added from the MIME when missing.
- `ui/attachment.ts` wires it: download to `<dest>.part`, reject any non-200 (a 401 body would otherwise be saved as the file), decrypt if the room is encrypted, then rename. A file present under its real name is therefore complete and reused.
- **Share** hands the local `file://` to the Android share sheet (`expo-sharing`), never the tokenised URL. **Save** puts photos, videos and audio in the gallery (`expo-media-library`), anything else in the public Downloads folder through the local Kotlin module `modules/downloads` (`MediaStore.Downloads`, no permission from Android 10; on iOS the module is null and the share sheet is used).
- Both run in the background (`ui/attachmentActions.ts`): the action sheet closes at once, `ui/transfers.ts` keys progress by the file's server path so the message row shows it, a second start on the same file is ignored, and a toast reports the outcome.

### Desktop

- `Session::download_with_progress` streams to `<dest>.part` (`RestClient::download_protected`, ended only by a 30 s silence, not the usual 15 s cap), decrypts files of encrypted rooms once whole, then renames.
- GTK file cards (`rv-gtk/src/cards.rs`) cache under the user cache dir (`files/<url digest>-<name>`). "Open" uses the desktop's default application (GTK launcher, then GIO, then `xdg-open` on Linux); audio plays in the card. "Download" (card button or the message menu) copies into the Downloads folder under a free name (`n-name`). SwiftUI does the same through `rv-ffi`'s `download` (`RoomView.swift`).

## Web

The serving-origin client uses the native prepare/bytes/complete contract in `src/uploads.ts`, with File objects and durable operation ids in IndexedDB. The staged batch moves into the upload queue in one transaction; a session/membership fence runs before that transaction. Creation order is retained across retries, and only the first file receives the caption. Each job retains its originating room/thread and membership lifetime. The advanced browser suite qualifies offline media reload and excludes replay after withdrawal/rejoin.

GTK's Original-quality checkbox is parked per room in browser storage. `src/staged.ts` prepares JPEG with longest side 1920 and quality 82 at send, leaving an image within 1920 and below 1 MiB unchanged. Browser decode failure keeps the original. The image suite verifies unchanged PNG originals and a real reduced 1920x960 JPEG from a 2400x1200 source. Browser codec and encoder implementations differ from GdkPixbuf, so this verifies the policy and resulting dimensions rather than identical JPEG bytes.

Videos are reduced too, with mobile's figures: H.264 MP4, short side capped at 720 with the aspect kept and both sides even, 2 Mbps. The pure decision is `src/video-plan.ts` (`tests/video-plan.test.ts`): every video is a candidate, but a source already within 720p whose average bitrate is at most 2.2 Mbps is sent as is, the bitrate never exceeds the source's own average (floor 500 kbps), and a result that is not lighter is thrown away, as on mobile. The work runs at send, in a worker per video (`src/video-reduce.worker.ts`) built on Mediabunny (MPL-2.0, unmodified, in that worker's chunk only and left out of the service worker's precache by `scripts/build-shell.mjs`): it demuxes MP4, QuickTime, WebM and Matroska, decodes and encodes through WebCodecs, copies the sound when MP4 can carry it (AAC, Opus, MP3...) or re-encodes it to AAC where the browser has an encoder, and muxes a fast-start MP4 named after the original. Any failure (no video track, undecodable codec, a track that would be dropped, the worker failing to load) sends the original, never fails the send; the reason goes to the console. `src/video-reduce.ts` probes `VideoEncoder.isConfigSupported` for High-profile H.264 at 720p (the profile Mediabunny asks for); without it (some Firefox builds, Linux Chromium without a platform encoder) the strip says videos will go out in original quality. While reducing, the strip shows "Reducing <name>" with a progress bar and Cancel, the quality checkbox is disabled and a second Enter is ignored; Cancel, removing a staged file or leaving the room terminates the worker and keeps the files staged. Known limit: a WebM carrying an alpha plane (a canvas recording) needs Mediabunny's `blob:` merge workers, which the server's CSP (`worker-src 'self'`) refuses, so it goes out in original quality. `tests/video-reduce.mjs` stages a generated 1600x900 VP8/Opus WebM, cancels, then checks the stored file is a 1280x720 H.264 MP4 with its sound that plays back, the original choice, and the fallback with the encoder probe forced off; on a Chromium without an H.264 encoder it checks the fallback only.

## Parity

Both apps have persisted queues, local file lookup, retries and validation. Desktop additionally prevents uncertain Rocket.Chat confirm replay and displays "Checking delivery" on GTK and SwiftUI; mobile owes that behavior. Desktop adds drag-and-drop and paste in place of the Android share sheet, and automatic timed retries. Reduction differs: mobile reduces photos over 500 KB to JPEG 1920 px and transcodes videos to H.264 720p (`modules/video-compressor`), as does the web where the browser has an H.264 encoder; desktop reduces still images only (JPEG 1920 px, quality 82, skipped when within 1920 px and below 1 MiB). Each queued row keeps the thread it answers (`uploads.tmid`, mobile migration 0018 and desktop migration 9), sent as `tmid` with the confirm, or as the native intent's `complete.reply_to` (see [threads](threads.md)). Picking files and the pre-send strip are in [the composer](composer.md); sharing into the app is in [sharing and links](sharing-and-links.md).

## Sources

- apps/web/src/app.ts
- apps/web/src/staged.ts
- apps/web/src/uploads.ts
- apps/web/src/store.ts
- apps/web/src/video-plan.ts
- apps/web/src/video-reduce.ts
- apps/web/src/video-reduce.worker.ts
- apps/web/scripts/build-shell.mjs
- apps/web/tests/images.mjs
- apps/web/tests/video-plan.test.ts
- apps/web/tests/video-reduce.mjs
- apps/web/tests/features.mjs

- apps/mobile/lib/uploadQueue.ts
- apps/mobile/lib/upload.ts
- apps/mobile/lib/attachment.ts
- apps/mobile/db/schema.ts
- apps/mobile/db/store.ts
- apps/mobile/db/upserts.ts
- apps/mobile/providers/rocketchat/index.ts
- apps/mobile/ui/sync.tsx
- apps/mobile/ui/transportUpload.ts
- apps/mobile/ui/uploadProbe.ts
- apps/mobile/ui/fileProgress.ts
- apps/mobile/ui/temporaryFiles.ts
- apps/mobile/ui/prepareAttachment.ts
- apps/mobile/ui/attachmentQuality.ts
- apps/mobile/ui/fileValidation.ts
- apps/mobile/ui/attachment.ts
- apps/mobile/ui/attachmentActions.ts
- apps/mobile/ui/transfers.ts
- apps/mobile/modules/downloads/index.ts
- apps/mobile/app/room/[rid].tsx
- apps/desktop/crates/rv-core/tests/uploads.rs
- apps/desktop/crates/rv-core/src/uploads.rs
- apps/desktop/crates/rv-core/src/store.rs
- apps/desktop/crates/rv-core/src/rest.rs
- apps/desktop/crates/rv-core/src/media.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-gtk/src/attach.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/cards.rs
- apps/desktop/crates/rv-gtk/src/actions_menu.rs
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
