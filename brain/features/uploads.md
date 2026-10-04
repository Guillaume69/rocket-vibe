# Uploads and downloads

Sending a file is a two-step server exchange (`rooms.media`, then `rooms.mediaConfirm`) behind a persisted queue that survives a kill, retries on reconnection and never posts the same file twice. Downloading a protected file keeps the auth token inside the process and writes through a partial file. Both apps implement the same mechanism: mobile in `lib/envoiFichiers.ts` (`MoteurTeleversement`, the upload engine), desktop in `rv-core/src/uploads.rs` (`Uploads`).

## The server contract

`POST /api/v1/rooms.upload` was removed in Rocket.Chat 8.0. An upload is now two calls (see [the server contract](../architecture/rocket-chat.md)):

1. `POST rooms.media/<rid>`, multipart with the bytes in field `file`. It answers `{file: {_id, url}}` and posts **no** message: the file waits on the server, orphaned.
2. `POST rooms.mediaConfirm/<rid>/<fileId>` with an optional `{msg: caption}`. This creates the message and answers it in full (`attachments`, `file`, `md`); both apps ingest that document like any other.

Replaying `rooms.mediaConfirm` on the same `fileId` has no usable answer (probed on 8.5): replayed at once, the server posts a second message but answers 200 with the first one; replayed minutes later, it refuses with `invalid-file` although the file was delivered. Its schema is `additionalProperties: false`, so a client `_id` cannot be added for server-side dedup. Deduplication is therefore entirely local.

## The queue and the local dedup

Each file is a row persisted **before** any byte leaves:

- Mobile: SQLite table `televersements` (uploads; `db/schema.ts`): `id`, `rid`, `uri`, `nom` (name), `type` (MIME), `legende` (caption), `statut` (`en-attente` pending / `envoi` sending / `echec` failed), `derniere_erreur` (diagnostic only, never shown), `file_id`, `cree_le`.
- Desktop: table `uploads` in `rv-core/src/store.rs`: `id`, `rid`, `path`, `name`, `mime`, `caption`, `file_id`, `status` (`pending` / `sending` / `failed`), `temporary`, `created_at`.

A pass processes rows in creation order, one pass at a time (a request during a pass is noted and run after it). For each row:

1. **Claim** it atomically (`pending` to `sending`; mobile `prendreEnCharge`, desktop `claim_upload`). A row another pass took is skipped.
2. If `file_id` is empty, send the bytes, then **write the returned `fileId` to the row before confirming** (mobile `noterFileId`, desktop `set_upload_file_id`). This is the point of the column: a lost confirm answer no longer means re-uploading the bytes.
3. If `file_id` is already set, ask the **local database** whether a message carrying that file exists: a `LIKE` on the attachments column for `/file-upload/<fileId>/` in that room (mobile `MESSAGE_AVEC_FICHIER` in `db/upserts.ts`, desktop `Store::file_posted`). Found: the confirm had succeeded and only its answer was lost, so the row is settled without calling the server. The query is local, so it costs nothing against the 10-calls-per-minute REST limit.
4. When the database knows nothing (typical after a kill: no room screen was open, so no stream delivered the message), refresh **that room once** and ask again. Mobile calls `fournisseur.rattraperSalon` (the per-room catch-up, wired in `ui/synchro.tsx` with the session's abandon predicate so it stops at logout); desktop calls `SyncEngine::load_history`. This targeted REST call is paid only on that rare path.
5. Confirm, settle the row (delete it, delete its temporary file), ingest the returned message.

If the refresh itself fails, the engine confirms anyway: a possible duplicate is preferred to a lost file.

**Recovery after a kill.** A row still in `sending` can only come from a run that died mid-upload. Desktop re-arms all of them when `Uploads::new` runs (one process owns the database). Mobile re-arms them on the first pass of the process, but **excludes the ids this JS runtime has in flight** (`EN_VOL_ICI`, module level): `SynchroProvider` can build a second engine over the same SQLite connection without stopping the first, and a blind re-arm would upload and confirm the same file twice (`REARMER_TELEVERSEMENTS_EN_VOL`).

## Outcomes, retries and discard

- **Network unreachable** (status 0): the row goes back to pending and the pass stops. Mobile retries on the next connection (`apresRattrapage` in `ui/synchro.tsx`) and after an E2E unlock. Desktop also retries on catch-up, and schedules its own retries at 2, 5, 15 then 30 s (`OFFLINE_RETRY`), shown as "retrying" in the strip.
- **Server refusal**: `failed`. Only the explicit Retry button puts it back (mobile `reessayer`, desktop `retry`); automatic passes never see failed rows.
- **Encrypted room still locked**: the row waits (pending), it does not fail.
- **Missing local file** (mobile cache purged by the OS): a plain error, so the row fails and can be discarded instead of waiting forever (`ui/transportUpload.ts`).
- **Discard** removes the row, **aborts the running transfer** (mobile: the upload task's `cancelAsync`, desktop: the tokio task's `AbortHandle`) and notes the id so the running pass ingests nothing. Without the abort the bytes kept going up and the file appeared after the user discarded it. After the confirm, the message exists and cannot be taken back.

## Validation

`FileUpload_MaxFileSize`, `FileUpload_MediaTypeWhiteList` (`image/*` matches any image) and `E2E_Enable_Encrypt_Files` (an encrypted room takes no file without it) are read from `settings.public` with `count=0`: since 7.0 its `query` parameter is ignored and pages stop at 50, which once made validation a silent no-op. Mobile memoises only a successful read; offline it validates permissively for that call. Mobile validates when a file is staged (a file the server would refuse never shows) and again at send, since the reduced copy may differ; desktop validates once, in `Session::attach`, as each staged file is queued. Mobile refusals carry data (`ErreurValidation.detail`), worded at display by `ui/validationFichiers.ts`; desktop returns `uploads::Refusal`.

## Progress

The fraction lives only in memory, never in SQLite. Both engines publish a change only when the whole percentage changes (per-chunk re-renders would cost more than the upload).

- Mobile: `MoteurTeleversement.progression` plus `abonner`, read by `ui/progressionFichiers.ts`; the room screen (`app/salon/[rid].tsx`) shows one line per row: waiting, "sending N %", or failed with Retry, and Discard on every line. The transport is `expo-file-system` `createUploadTask` (`ui/transportUpload.ts`).
- Desktop: `Uploads::progress` and a broadcast of the rid, forwarded as `SessionEvent::Upload`. GTK's upload strip (`Chat::refresh_uploads` in `rv-gtk/src/chat.rs`) shows a progress bar, or waiting / retrying / failed with Retry, and a discard button. `RestClient::upload` streams the bytes in 64 KiB chunks with a timeout of 60 s plus 1 s per 32 KiB. The whole file is read into memory first.

## Footguns

- **The multipart filename is the file on disk.** `createUploadTask` sends the disk name, not the `nom` field, so a cache copy or a transcode would post as a random name. `ui/transportUpload.ts` copies the file under its real name into a private folder first (`nomATeleverser` in `lib/fichierJoint.ts`); `ui/preparerPieceJointe.ts` renames reduced outputs.
- **An upload can kill the DDP socket silently** on mobile. The end of every upload (success or failure) calls `signalerFinUpload` (`ui/sondeUpload.ts`), which makes the session probe its socket (`ddp.verifierVie`). See [mobile transport](../architecture/mobile-transport.md).
- **Temporary files only.** Settling deletes the local file only when it is the app's own copy: mobile `supprimerSiTemporaire` (`ui/fichiersTemporaires.ts`) checks the path is in the app cache; desktop deletes only rows marked `temporary` (pasted pictures, reduced copies, voice recordings), never a file the user picked in place.

## Encrypted rooms

The file goes up encrypted under its own AES-CTR key, named by the SHA-256 of its real name, with the file metadata encrypted under the room key in a `content` form field. The confirm carries `t: 'e2e'`, an encrypted `content` (caption, attachment with key and hash, file) and `fileContent`. The per-file key lives in memory only between the two steps: a process killed in between re-encrypts and re-uploads under a new key. Details in [E2EE](../architecture/e2ee.md).

## Downloads

Protected files (`FileUpload_ProtectFiles`) need `rc_uid` and `rc_token` in the query. Both apps add them **only to URLs on our own origin** (mobile `urlFichierProtege` in `lib/upload.ts`, desktop `media::protected_url`), because attachment links come from anyone and would otherwise carry our token to a third-party host.

`/file-upload/...` answers chunked, without `Content-Length`, so progress falls back on the size announced in the attachment (`fractionTelechargee` in `lib/fichierJoint.ts`; desktop `progress_text` in `rv-gtk/src/cards.rs`, which shows bytes received when no size is known).

### Mobile

- `lib/fichierJoint.ts` (pure, tested under Node) picks the cache path: `jointes/<fileId>/<safe name>`, the server id as subfolder so two `facture.pdf` never collide, the name sanitised so it cannot escape the folder (`nomDeFichierSur`), an extension added from the MIME when missing.
- `ui/fichierJoint.ts` wires it: download to `<dest>.part`, reject any non-200 (a 401 body would otherwise be saved as the file), decrypt if the room is encrypted, then rename. A file present under its real name is therefore complete and reused.
- **Share** hands the local `file://` to the Android share sheet (`expo-sharing`), never the tokenised URL. **Save** puts photos, videos and audio in the gallery (`expo-media-library`), anything else in the public Downloads folder through the local Kotlin module `modules/telechargements` (`MediaStore.Downloads`, no permission from Android 10; on iOS the module is null and the share sheet is used).
- Both run in the background (`ui/actionsJointe.ts`): the action sheet closes at once, `ui/transferts.ts` keys progress by the file's server path so the message row shows it, a second start on the same file is ignored, and a toast reports the outcome.

### Desktop

- `Session::download_with_progress` streams to `<dest>.part` (`RestClient::download_protected`, ended only by a 30 s silence, not the usual 15 s cap), decrypts files of encrypted rooms once whole, then renames.
- GTK file cards (`rv-gtk/src/cards.rs`) cache under the user cache dir (`files/<url digest>-<name>`). "Open" uses the desktop's default application (GTK launcher, then GIO, then `xdg-open` on Linux); audio plays in the card. "Download" (card button or the message menu) copies into the Downloads folder under a free name (`n-name`). SwiftUI does the same through `rv-ffi`'s `download` (`RoomView.swift`).

## Parity

Same queue, dedup, retry and validation in both apps. Desktop adds drag-and-drop and paste in place of the Android share sheet, and automatic timed retries. Reduction differs: mobile reduces photos over 500 KB to JPEG 1920 px and transcodes videos to H.264 720p (`modules/reducteur-video`); desktop reduces still images only (JPEG 1920 px, quality 82, skipped when not smaller). The queue has no thread id, so no file is ever posted inside a thread (see [threads](threads.md)). Picking files and the pre-send strip are in [the composer](composer.md); sharing into the app is in [sharing and links](sharing-and-links.md).

## Sources

- apps/mobile/lib/envoiFichiers.ts
- apps/mobile/lib/upload.ts
- apps/mobile/lib/fichierJoint.ts
- apps/mobile/db/schema.ts
- apps/mobile/db/depot.ts
- apps/mobile/db/upserts.ts
- apps/mobile/fournisseurs/rocketchat/index.ts
- apps/mobile/ui/synchro.tsx
- apps/mobile/ui/transportUpload.ts
- apps/mobile/ui/sondeUpload.ts
- apps/mobile/ui/progressionFichiers.ts
- apps/mobile/ui/fichiersTemporaires.ts
- apps/mobile/ui/preparerPieceJointe.ts
- apps/mobile/ui/qualitePieceJointe.ts
- apps/mobile/ui/validationFichiers.ts
- apps/mobile/ui/fichierJoint.ts
- apps/mobile/ui/actionsJointe.ts
- apps/mobile/ui/transferts.ts
- apps/mobile/modules/telechargements/index.ts
- apps/mobile/app/salon/[rid].tsx
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
- apps/desktop/docs/PARITY.md
