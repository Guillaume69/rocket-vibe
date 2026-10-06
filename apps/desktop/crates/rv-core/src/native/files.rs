//! Protected native files. Transfers stream from disk; original intentions survive restart.
use super::{Error, NativeSession, Ordering, store::FileIntent};
use crate::media::Media;
use futures_util::StreamExt;
use rv_protocol::parity::{
    CompleteUpload, EncryptedFile, FileDescriptor, MessageContent, PrepareUpload, Upload, UploadState,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX: u64 = 100 << 20;
pub(crate) struct Files {
    root: PathBuf,
    downloads: String,
    creating: Mutex<std::collections::HashSet<PathBuf>>,
    pub(super) progress: Mutex<HashMap<String, f64>>,
    cache: Mutex<HashMap<String, PathBuf>>,
    views: Mutex<HashMap<String, (FileDescriptor, String, String)>>,
    /// Encrypted files of the open private views, by id: their room and
    /// descriptor, key included (E2EE_FILES.md). Never persisted.
    private: Mutex<HashMap<String, Shown>>,
    slots: tokio::sync::Semaphore,
}
/// An encrypted file's room and descriptor, and the private views showing it.
type Shown = (String, EncryptedFile, std::collections::BTreeSet<u64>);
/// `rv-file:~<id>`: an encrypted file of a private room. `~` never occurs in
/// an ordinary file id, so every existing `rv-file:` path keeps working.
const PRIVATE: &str = "rv-file:~";
/// Attachments of a private message's encrypted files, shaped like ordinary
/// ones; previews only for the types ordinary files allow.
pub(crate) fn private_attachments(files: &[EncryptedFile]) -> Vec<Value> {
    files
        .iter()
        .map(|f| {
            let link = format!("{PRIVATE}{}", f.id);
            let size = f.bytes.parse::<u64>().unwrap_or_default();
            let mut card = json!({"title":f.filename,"title_link":link,"title_link_download":true,"format":f.media_type,"size":size});
            let kind = ["image", "audio", "video"]
                .into_iter()
                .find(|k| mime(&f.media_type) && f.media_type.starts_with(&format!("{k}/")));
            if let Some(kind) = kind {
                card[format!("{kind}_url")] = json!(link);
                card[format!("{kind}_type")] = json!(f.media_type);
                card[format!("{kind}_size")] = json!(size);
            }
            card
        })
        .collect()
}
fn io(_: std::io::Error) -> Error {
    Error::Protocol("file_io_failed")
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
fn mime(value: &str) -> bool {
    matches!(
        value,
        "application/octet-stream"
            | "text/plain"
            | "application/pdf"
            | "application/zip"
            | "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "audio/mpeg"
            | "audio/ogg"
            | "audio/wav"
            | "audio/mp4"
            | "video/mp4"
            | "video/quicktime"
            | "video/webm"
    )
}
fn filename(value: &str) -> bool {
    !value.is_empty() && value.len() <= 240 && !value.chars().any(|c| c.is_control() || "/\\".contains(c))
}
pub(super) fn validate_descriptors(files: &[FileDescriptor], room: &str) -> Result<(), Error> {
    let mut seen = std::collections::HashSet::new();
    if files.len() > 10 {
        return Err(Error::Protocol("invalid_file"));
    }
    for f in files {
        let bytes = f.bytes.parse::<u64>().ok().filter(|n| n.to_string() == f.bytes && *n > 0 && *n <= MAX);
        if !id(&f.id)
            || f.room_id != room
            || !id(room)
            || bytes.is_none()
            || f.encrypted
            || !mime(&f.media_type)
            || f.sha256.len() != 64
            || !f.sha256.bytes().all(|c| c.is_ascii_digit() || b"abcdef".contains(&c))
            || f.filename.as_ref().is_some_and(|s| !filename(s))
            || !seen.insert(&f.id)
        {
            return Err(Error::Protocol("invalid_file"));
        }
    }
    Ok(())
}
pub(super) fn attachments(files: &[FileDescriptor]) -> Result<Vec<Value>, Error> {
    let mut cards = vec![];
    for f in files {
        validate_descriptors(std::slice::from_ref(f), &f.room_id)?;
        let link = format!("rv-file:{}", f.id);
        let mut card = json!({"title":f.filename.as_deref().unwrap_or("file"),"title_link":link,"title_link_download":true,"format":f.media_type,"size":f.bytes.parse::<u64>().unwrap()});
        let kind = if f.media_type.starts_with("image/") {
            Some("image")
        } else if f.media_type.starts_with("audio/") {
            Some("audio")
        } else if f.media_type.starts_with("video/") {
            Some("video")
        } else {
            None
        };
        if let Some(kind) = kind {
            card[format!("{kind}_url")] = json!(link);
            card[format!("{kind}_type")] = json!(f.media_type);
            card[format!("{kind}_size")] = json!(f.bytes.parse::<u64>().unwrap());
        }
        cards.push(card);
    }
    Ok(cards)
}
impl Files {
    pub(super) fn new(db: &Path, info: &crate::session::SessionInfo) -> Self {
        let key = format!("{}\0{}\0{:?}", info.base_url, info.user_id, info.native);
        let scope = hex(&Sha256::digest(key.as_bytes()));
        Self {
            root: db.with_extension("native-files").join(scope),
            downloads: format!("downloads-{:032x}", fastrand::u128(..)),
            creating: Mutex::default(),
            progress: Mutex::default(),
            cache: Mutex::default(),
            views: Mutex::default(),
            private: Mutex::default(),
            slots: tokio::sync::Semaphore::new(4),
        }
    }
    async fn directory(&self, kind: &str) -> Result<PathBuf, Error> {
        let path = self.root.join(kind);
        tokio::fs::create_dir_all(&path).await.map_err(io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&self.root, std::fs::Permissions::from_mode(0o700)).await.map_err(io)?;
            tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).await.map_err(io)?;
        }
        Ok(path)
    }
}
impl NativeSession {
    pub fn files_available(&self) -> bool {
        !self.is_closed() && self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.uploads)
    }
    pub fn file_version(&self) -> String {
        format!(
            "{}:{}:{}",
            self.security_generation.load(Ordering::SeqCst),
            self.store.projection_token(),
            self.store.search_token()
        )
    }
    pub fn file_current(&self, path: &str) -> bool {
        if path.starts_with(PRIVATE) {
            return self.private_file(path).is_ok();
        }
        self.file_descriptor(path).is_ok()
    }
    /// Makes the encrypted files shown by private view `view` openable, until
    /// that view closes.
    pub(crate) fn register_private_files<'a>(
        &self,
        view: u64,
        room: &str,
        files: impl Iterator<Item = &'a EncryptedFile>,
    ) {
        let mut private = self.files.private.lock().unwrap();
        for file in files {
            let entry =
                private.entry(file.id.clone()).or_insert_with(|| (room.to_owned(), file.clone(), Default::default()));
            if entry.0 == room && entry.1 == *file {
                entry.2.insert(view);
            }
        }
    }
    /// A closed view's files close with it, cached plaintext included, unless
    /// another open view still shows them.
    pub(crate) fn forget_private_files(&self, view: u64) {
        let mut gone = vec![];
        self.files.private.lock().unwrap().retain(|id, (_, _, views)| {
            views.remove(&view);
            if views.is_empty() {
                gone.push(format!("~{id}"));
            }
            !views.is_empty()
        });
        let mut cache = self.files.cache.lock().unwrap();
        for key in gone {
            if let Some(path) = cache.remove(&key) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    fn private_file(&self, path: &str) -> Result<(String, EncryptedFile), Error> {
        self.ready()?;
        let key = path.strip_prefix(PRIVATE).filter(|s| id(s)).ok_or(Error::Protocol("invalid_file"))?;
        let found = self
            .files
            .private
            .lock()
            .unwrap()
            .get(key)
            .map(|(room, file, _)| (room.clone(), file.clone()))
            .ok_or(Error::Protocol("file_unavailable"))?;
        if !self.store.rooms()?.iter().any(|r| r.id == found.0 && r.encrypted) {
            return Err(Error::Protocol("file_unavailable"));
        }
        Ok(found)
    }
    /// Seals `source` and uploads its opaque object to an encrypted room; the
    /// private message then completes it. The id and the descriptor's secret.
    pub(crate) async fn upload_private_object(
        &self,
        room: &str,
        source: &Path,
    ) -> Result<(String, rv_crypto::files::Sealed), Error> {
        self.ready()?;
        if !self.files_available() {
            return Err(Error::Protocol("files_unavailable"));
        }
        let folder = self.files.directory("private-uploads").await?;
        let object = folder.join(format!("{:032x}", fastrand::u128(..)));
        let result = async {
            let (from, to) = (source.to_owned(), object.clone());
            let sealed = tokio::task::spawn_blocking(move || rv_crypto::files::seal_path(&from, &to))
                .await
                .map_err(|_| Error::Protocol("file_io_failed"))?
                .map_err(|e| match e {
                    rv_crypto::files::Error::TooLarge => Error::Protocol("too-large:100"),
                    _ => Error::Protocol("file_io_failed"),
                })?;
            let upload = self
                .client
                .prepare_upload(&PrepareUpload {
                    operation_id: super::room_operation_id(),
                    room_id: room.into(),
                    bytes: sealed.object_bytes.to_string(),
                    sha256: sealed.object_sha256_text(),
                    media_type: "application/octet-stream".into(),
                    filename: None,
                    encrypted: true,
                })
                .await?;
            let sent = async {
                let file = tokio::fs::File::open(&object).await.map_err(io)?;
                let stream = futures_util::stream::try_unfold(file, |mut file| async move {
                    let mut buf = vec![0u8; 256 * 1024];
                    let n = file.read(&mut buf).await?;
                    if n == 0 {
                        return Ok::<_, std::io::Error>(None);
                    }
                    buf.truncate(n);
                    Ok(Some((buf, file)))
                });
                let ready = self.client.upload_bytes(&upload.id, rv_client::UploadBody::wrap_stream(stream)).await?;
                if ready.state != UploadState::Ready
                    || ready.file.bytes != sealed.object_bytes.to_string()
                    || ready.file.sha256 != sealed.object_sha256_text()
                    || !ready.file.encrypted
                {
                    return Err(Error::Protocol("invalid_file"));
                }
                Ok(())
            }
            .await;
            if let Err(error) = sent {
                let _ = self.client.cancel_upload(&upload.id).await;
                return Err(error);
            }
            Ok((upload.file.id, sealed))
        }
        .await;
        let _ = tokio::fs::remove_file(&object).await;
        result
    }
    pub(crate) async fn cancel_private_object(&self, id: &str) {
        let _ = self.client.cancel_upload(id).await;
    }
    /// Downloads an encrypted object and opens it into the private cache.
    async fn private_local_file(&self, path: &str) -> Result<PathBuf, Error> {
        let (_, file) = self.private_file(path)?;
        let _slot = self.files.slots.acquire().await.map_err(|_| Error::Protocol("session_closed"))?;
        let bytes = file.bytes.parse::<u64>().map_err(|_| Error::Protocol("invalid_file"))?;
        let object_bytes = rv_crypto::files::object_size(bytes);
        let key = format!("~{}", file.id);
        let cached = self.files.cache.lock().unwrap().get(&key).cloned();
        if let Some(cache) = cached.filter(|p| p.is_file()) {
            // The server still grants the object: membership is current.
            let proof = self.client.file_response(&file.id, Some("bytes=0-0")).await?;
            if proof.status().as_u16() != 206
                || proof.headers().get("content-range").and_then(|v| v.to_str().ok())
                    != Some(format!("bytes 0-0/{object_bytes}").as_str())
            {
                return Err(Error::Protocol("invalid_file"));
            }
            self.private_file(path)?;
            return Ok(cache);
        }
        let folder = self.files.directory(&self.files.downloads).await?;
        let object = folder.join(format!("{:032x}.part", fastrand::u128(..)));
        let destination = folder.join(format!("~{}-{:032x}", file.id, fastrand::u128(..)));
        let result = async {
            let response = self.client.file_response(&file.id, None).await?;
            if response.status().as_u16() != 200
                || response.headers().get("content-length").and_then(|v| v.to_str().ok())
                    != Some(object_bytes.to_string().as_str())
            {
                return Err(Error::Protocol("invalid_file"));
            }
            let mut out = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&object).await.map_err(io)?;
            let mut stream = response.bytes_stream();
            let mut received = 0u64;
            while let Some(chunk) = stream.next().await {
                self.private_file(path)?;
                let chunk = chunk.map_err(|_| Error::Protocol("file_transfer_failed"))?;
                received += chunk.len() as u64;
                if received > object_bytes {
                    return Err(Error::Protocol("file_integrity"));
                }
                out.write_all(&chunk).await.map_err(io)?;
            }
            out.sync_all().await.map_err(io)?;
            drop(out);
            let secret = rv_crypto::files::decode_key(&file.key).map_err(|_| Error::Protocol("invalid_file"))?;
            let digest = rv_crypto::files::decode_sha256(&file.sha256).map_err(|_| Error::Protocol("invalid_file"))?;
            let (from, to) = (object.clone(), destination.clone());
            tokio::task::spawn_blocking(move || rv_crypto::files::open_path(&secret, bytes, &digest, &from, &to))
                .await
                .map_err(|_| Error::Protocol("file_io_failed"))?
                .map_err(|_| Error::Protocol("file_integrity"))?;
            self.private_file(path)?;
            let mut cache = self.files.cache.lock().unwrap();
            let stored: u64 = cache.values().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum();
            if cache.len() >= 32 || stored + bytes > 512 << 20 {
                for path in cache.values() {
                    let _ = std::fs::remove_file(path);
                }
                cache.clear();
            }
            if let Some(old) = cache.insert(key, destination.clone()) {
                let _ = std::fs::remove_file(old);
            }
            Ok(destination.clone())
        }
        .await;
        let _ = tokio::fs::remove_file(&object).await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&destination).await;
        }
        result
    }
    fn file_descriptor(&self, path: &str) -> Result<FileDescriptor, Error> {
        if self.is_closed() {
            return Err(Error::Protocol("session_closed"));
        }
        let key = path.strip_prefix("rv-file:").filter(|s| id(s)).ok_or(Error::Protocol("invalid_file"))?;
        let file = self
            .store
            .file_descriptor(key)?
            .or_else(|| {
                self.files
                    .views
                    .lock()
                    .unwrap()
                    .get(key)
                    .filter(|(file, version, membership)| {
                        self.search_version().ok().as_deref() == Some(version.as_str())
                            && self
                                .store
                                .read_state(&file.room_id)
                                .ok()
                                .flatten()
                                .and_then(|s| s.membership_version)
                                .as_deref()
                                == Some(membership)
                    })
                    .map(|(file, _, _)| file.clone())
            })
            .ok_or(Error::Protocol("file_unavailable"))?;
        validate_descriptors(std::slice::from_ref(&file), &file.room_id)?;
        Ok(file)
    }
    pub fn upload_progress(&self, id: &str) -> Option<f64> {
        self.files.progress.lock().unwrap().get(id).copied()
    }
    pub fn file_uploads(&self, room: &str) -> Result<Vec<crate::store::UploadRow>, Error> {
        Ok(self
            .store
            .file_intents()?
            .into_iter()
            .filter(|u| u.rid == room)
            .map(|u| crate::store::UploadRow {
                id: u.id,
                rid: u.rid,
                path: u.path,
                name: u.prepare.filename.unwrap_or_else(|| "file".into()),
                mime: u.prepare.media_type,
                caption: match u.complete.content {
                    MessageContent::Plain { markdown, .. } => Some(markdown),
                    _ => None,
                },
                file_id: None,
                status: if u.failed { "failed" } else { "pending" }.into(),
                temporary: true,
                tmid: u.complete.reply_to,
            })
            .collect())
    }
    #[allow(clippy::too_many_arguments)] // Existing attachment inputs plus the captured room membership.
    pub async fn attach_file(
        &self,
        room: &str,
        path: &Path,
        name: &str,
        media_type: &str,
        caption: Option<&str>,
        temporary: bool,
        membership: &str,
    ) -> Result<(), Error> {
        self.attach_file_in(room, None, path, name, media_type, caption, temporary, membership).await
    }
    /// `attach_file`, answering the thread `reply_to` when there is one.
    #[allow(clippy::too_many_arguments)] // Existing attachment inputs plus the thread and the captured membership.
    pub async fn attach_file_in(
        &self,
        room: &str,
        reply_to: Option<&str>,
        path: &Path,
        name: &str,
        media_type: &str,
        caption: Option<&str>,
        temporary: bool,
        membership: &str,
    ) -> Result<(), Error> {
        if !self.files_available() {
            return Err(Error::Protocol("unsupported_feature"));
        }
        if !mime(media_type) {
            return Err(Error::Protocol("type-not-allowed"));
        }
        if !filename(name) {
            return Err(Error::Protocol("invalid_file"));
        }
        if self.store.read_state(room)?.and_then(|s| s.membership_version).as_deref() != Some(membership) {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        let operation = format!("{:032x}", fastrand::u128(..));
        let copy = self.files.directory("uploads").await?.join(&operation);
        self.files.creating.lock().unwrap().insert(copy.clone());
        let result = async {
            let mut source = tokio::fs::File::open(path).await.map_err(io)?;
            let mut dest = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&copy).await.map_err(io)?;
            let mut hash = Sha256::new();
            let mut bytes = 0u64;
            let mut buf = vec![0; 256 << 10];
            loop {
                let read = source.read(&mut buf).await.map_err(io)?;
                if read == 0 {
                    break;
                }
                bytes += read as u64;
                if bytes > MAX {
                    return Err(Error::Protocol("too-large:100"));
                }
                hash.update(&buf[..read]);
                dest.write_all(&buf[..read]).await.map_err(io)?;
            }
            if bytes == 0 {
                return Err(Error::Protocol("invalid_file"));
            }
            dest.sync_all().await.map_err(io)?;
            let intent = FileIntent {
                id: operation.clone(),
                rid: room.into(),
                membership: membership.into(),
                path: copy.to_string_lossy().into(),
                prepare: PrepareUpload {
                    operation_id: operation.clone(),
                    room_id: room.into(),
                    bytes: bytes.to_string(),
                    sha256: hex(&hash.finalize()),
                    media_type: media_type.into(),
                    filename: Some(name.into()),
                    encrypted: false,
                },
                complete: CompleteUpload {
                    operation_id: format!("{:032x}", fastrand::u128(..)),
                    content: MessageContent::Plain {
                        markdown: caption.unwrap_or_default().into(),
                        mentions: vec![],
                        quotes: vec![],
                        files: vec![],
                    },
                    reply_to: reply_to.map(str::to_owned),
                },
                cancelling: false,
                failed: false,
                error: None,
            };
            if self.is_closed() || !self.store.save_file_intent(&intent)? {
                return Err(Error::Protocol("delivery_revalidate"));
            }
            Ok(())
        }
        .await;
        self.files.creating.lock().unwrap().remove(&copy);
        if result.is_err() {
            let _ = tokio::fs::remove_file(&copy).await;
        } else {
            if temporary {
                let _ = tokio::fs::remove_file(path).await;
            }
            self.file_wake.notify_one();
        }
        result
    }
    pub(super) fn cache_search_files(
        &self,
        page: &rv_protocol::search::SearchPage,
        version: &str,
        membership: &str,
    ) -> Result<(), Error> {
        let mut views = self.files.views.lock().unwrap();
        for message in &page.messages {
            validate_descriptors(&message.files, &message.room_id)?;
        }
        if version != self.search_version()? {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        if views.len() + page.messages.iter().map(|m| m.files.len()).sum::<usize>() > 256 {
            views.clear();
        }
        for message in &page.messages {
            for file in &message.files {
                views.insert(file.id.clone(), (file.clone(), version.into(), membership.into()));
            }
        }
        Ok(())
    }
    pub fn retry_file(&self, id: &str) -> Result<(), Error> {
        self.store.retry_file_intent(id)?;
        self.file_wake.notify_one();
        Ok(())
    }
    pub fn discard_file(&self, id: &str) -> Result<(), Error> {
        self.store.file_intent_state(id, true, false)?;
        self.file_wake.notify_one();
        Ok(())
    }
    fn file_guard(&self, intent: &FileIntent, generation: u64) -> Result<(), Error> {
        self.ready()?;
        if generation != self.security_generation.load(Ordering::SeqCst)
            || self.paused.load(Ordering::SeqCst)
            || self.store.read_state(&intent.rid)?.and_then(|s| s.membership_version).as_deref()
                != Some(&intent.membership)
        {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        if !self.store.file_intents()?.iter().any(|u| u.id == intent.id && u.cancelling == intent.cancelling) {
            return Err(Error::Protocol("upload_interrupted"));
        }
        Ok(())
    }
    async fn guarded_upload<T>(
        &self,
        intent: &FileIntent,
        generation: u64,
        future: impl std::future::Future<Output = Result<T, rv_client::Error>>,
    ) -> Result<T, Error> {
        tokio::pin!(future);
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        loop {
            tokio::select! {result=&mut future=>{self.file_guard(intent,generation)?;return Ok(result?)},_=tick.tick()=>self.file_guard(intent,generation)?}
        }
    }
    fn verified_upload(intent: &FileIntent, u: &Upload) -> Result<(), Error> {
        validate_descriptors(std::slice::from_ref(&u.file), &intent.rid)?;
        if !id(&u.id)
            || u.file.bytes != intent.prepare.bytes
            || u.file.sha256 != intent.prepare.sha256
            || u.file.media_type != intent.prepare.media_type
            || u.file.filename != intent.prepare.filename
            || u.state == UploadState::Completed && u.message_id.as_deref() != Some(&intent.complete.operation_id)
        {
            return Err(Error::Protocol("invalid_upload"));
        }
        Ok(())
    }
    async fn transfer_file(self: &Arc<Self>, intent: &FileIntent) -> Result<(), Error> {
        let generation = self.security_generation.load(Ordering::SeqCst);
        self.file_guard(intent, generation)?;
        self.identity().await?;
        self.file_guard(intent, generation)?;
        let mut upload = self.guarded_upload(intent, generation, self.client.prepare_upload(&intent.prepare)).await?;
        Self::verified_upload(intent, &upload)?;
        let mut complete = intent.complete.clone();
        if let MessageContent::Plain { files, .. } = &mut complete.content {
            *files = vec![upload.file.id.clone()];
        }
        if intent.cancelling && upload.state != UploadState::Completed {
            upload = match self.guarded_upload(intent, generation, self.client.cancel_upload(&upload.id)).await {
                Ok(u) => u,
                Err(Error::Network(rv_client::Error::Server { status: 409, .. })) => {
                    self.guarded_upload(intent, generation, self.client.upload_status(&upload.id)).await?
                }
                Err(e) => return Err(e),
            };
            Self::verified_upload(intent, &upload)?;
        }
        let receipt = match upload.state {
            UploadState::Cancelled | UploadState::Expired if intent.cancelling => None,
            UploadState::Cancelled | UploadState::Expired => return Err(Error::Protocol("upload_expired")),
            UploadState::Completed | UploadState::Ready
                if !intent.cancelling || upload.state == UploadState::Completed =>
            {
                Some(self.guarded_upload(intent, generation, self.client.complete_upload(&upload.id, &complete)).await?)
            }
            UploadState::Prepared if !intent.cancelling => {
                let file = tokio::fs::File::open(&intent.path).await.map_err(io)?;
                let session = self.clone();
                let key = intent.id.clone();
                let total = intent.prepare.bytes.parse::<u64>().map_err(|_| Error::Protocol("invalid_file"))?;
                let stream = futures_util::stream::try_unfold(
                    (file, 0u64, Sha256::new()),
                    move |(mut file, mut sent, mut hash)| {
                        let (session, key) = (session.clone(), key.clone());
                        async move {
                            let mut buf = vec![0u8; 256 << 10];
                            let n = file.read(&mut buf).await?;
                            if n == 0 {
                                if sent != total
                                    || hex(&hash.finalize())
                                        != session
                                            .store
                                            .file_intents()
                                            .ok()
                                            .and_then(|v| v.into_iter().find(|u| u.id == key))
                                            .map(|u| u.prepare.sha256)
                                            .unwrap_or_default()
                                {
                                    return Err(std::io::Error::other("file_integrity"));
                                }
                                return Ok(None);
                            }
                            sent += n as u64;
                            if sent > total {
                                return Err(std::io::Error::other("file_integrity"));
                            }
                            buf.truncate(n);
                            hash.update(&buf);
                            let fraction = sent as f64 / total as f64;
                            let changed = {
                                let mut progress = session.files.progress.lock().unwrap();
                                if progress.get(&key).is_none_or(|old| fraction - old >= 0.02 || sent == total) {
                                    progress.insert(key, fraction);
                                    true
                                } else {
                                    false
                                }
                            };
                            if changed {
                                let _ = session.events.send(());
                            }
                            Ok(Some((buf, (file, sent, hash))))
                        }
                    },
                );
                upload = self
                    .guarded_upload(
                        intent,
                        generation,
                        self.client.upload_bytes(&upload.id, rv_client::UploadBody::wrap_stream(stream)),
                    )
                    .await?;
                Self::verified_upload(intent, &upload)?;
                if upload.state != UploadState::Ready {
                    return Err(Error::Protocol("invalid_upload"));
                }
                Some(self.guarded_upload(intent, generation, self.client.complete_upload(&upload.id, &complete)).await?)
            }
            _ => return Err(Error::Protocol("invalid_upload")),
        };
        self.file_guard(intent, generation)?;
        if self.store.finish_file_intent(intent, receipt.as_ref())? {
            let _ = tokio::fs::remove_file(&intent.path).await;
        }
        Ok(())
    }
    pub(super) fn start_files(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        *self.file_task.lock().unwrap() = Some(tokio::spawn(async move {
            if let Some(s) = weak.upgrade() {
                s.clean_old_downloads().await;
            }
            loop {
                let Some(s) = weak.upgrade() else { return };
                if s.is_closed() {
                    return;
                }
                if s.files_available() && s.ready().is_ok() {
                    for intent in
                        s.store.file_intents().unwrap_or_default().into_iter().filter(|u| !u.failed || u.cancelling)
                    {
                        let result = s.transfer_file(&intent).await;
                        s.files.progress.lock().unwrap().remove(&intent.id);
                        if let Err(e) = result {
                            let permanent = matches!(&e,Error::Network(rv_client::Error::Server{status,..}) if matches!(status,400|403|404|409|413|415))
                                || matches!(
                                    e.code(),
                                    "file_io_failed" | "invalid_file" | "invalid_upload" | "upload_expired"
                                );
                            if permanent {
                                let _ = s.store.fail_file_intent(&intent.id, e.code());
                            }
                        }
                        let _ = s.events.send(());
                    }
                }
                s.clean_files().await;
                tokio::select! {_=s.file_wake.notified()=>{},_=tokio::time::sleep(Duration::from_secs(5))=>{}}
            }
        }));
    }
    async fn clean_files(&self) {
        let current = self.store.file_intents().unwrap_or_default();
        if let Ok(mut dir) = tokio::fs::read_dir(self.files.root.join("uploads")).await {
            while let Ok(Some(entry)) = dir.next_entry().await {
                if !self.files.creating.lock().unwrap().contains(&entry.path())
                    && !current.iter().any(|u| Path::new(&u.path) == entry.path())
                    && !self.store.file_intents().unwrap_or_default().iter().any(|u| Path::new(&u.path) == entry.path())
                {
                    let _ = tokio::fs::remove_file(entry.path()).await;
                }
            }
        }
        let stale = {
            let mut cache = self.files.cache.lock().unwrap();
            let stale: Vec<_> = cache
                .iter()
                .filter(|(id, _)| !self.file_current(&format!("rv-file:{id}")))
                .map(|(id, path)| (id.clone(), path.clone()))
                .collect();
            for (id, _) in &stale {
                cache.remove(id);
            }
            stale
        };
        for (_, path) in stale {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
    async fn clean_old_downloads(&self) {
        if let Ok(mut dir) = tokio::fs::read_dir(&self.files.root).await {
            while let Ok(Some(entry)) = dir.next_entry().await {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with("downloads-")
                    && name != self.files.downloads
                    && entry.file_type().await.is_ok_and(|t| t.is_dir())
                {
                    let _ = tokio::fs::remove_dir_all(entry.path()).await;
                }
            }
        }
    }
    fn read_file_guard(
        &self,
        file: &FileDescriptor,
        generation: u64,
        projection: u64,
        membership: &str,
    ) -> Result<(), Error> {
        self.ready()?;
        if self.paused.load(Ordering::SeqCst)
            || generation != self.security_generation.load(Ordering::SeqCst)
            || projection != self.store.projection_token()
            || self.store.read_state(&file.room_id)?.and_then(|s| s.membership_version).as_deref() != Some(membership)
            || self.file_descriptor(&format!("rv-file:{}", file.id))? != *file
        {
            return Err(Error::Protocol("file_unavailable"));
        }
        Ok(())
    }
    pub async fn local_file(&self, path: &str) -> Result<PathBuf, Error> {
        self.ready()?;
        if path.starts_with(PRIVATE) {
            return self.private_local_file(path).await;
        }
        let file = self.file_descriptor(path)?;
        let _slot = self.files.slots.acquire().await.map_err(|_| Error::Protocol("session_closed"))?;
        let generation = self.security_generation.load(Ordering::SeqCst);
        let projection = self.store.projection_token();
        let membership = self
            .store
            .read_state(&file.room_id)?
            .and_then(|s| s.membership_version)
            .ok_or(Error::Protocol("file_unavailable"))?;
        self.identity().await?;
        self.read_file_guard(&file, generation, projection, &membership)?;
        let cached = self.files.cache.lock().unwrap().get(&file.id).cloned();
        if let Some(cache) = cached.filter(|p| p.is_file()) {
            let proof = self.client.file_response(&file.id, Some("bytes=0-0")).await?;
            if proof.status().as_u16() != 206
                || proof.headers().get("content-range").and_then(|v| v.to_str().ok())
                    != Some(format!("bytes 0-0/{}", file.bytes).as_str())
            {
                return Err(Error::Protocol("invalid_file"));
            }
            if proof.bytes().await.map_err(|_| Error::Protocol("file_transfer_failed"))?.len() != 1 {
                return Err(Error::Protocol("invalid_file"));
            }
            self.read_file_guard(&file, generation, projection, &membership)?;
            return Ok(cache);
        }
        let folder = self.files.directory(&self.files.downloads).await?;
        let partial = folder.join(format!("{:032x}.part", fastrand::u128(..)));
        let destination = folder.join(format!("{}-{:032x}", file.id, fastrand::u128(..)));
        let result = async {
            let response = self.client.file_response(&file.id, None).await?;
            if response.status().as_u16() != 200
                || response.headers().get("content-length").and_then(|v| v.to_str().ok()) != Some(file.bytes.as_str())
                || response.headers().get("content-type").and_then(|v| v.to_str().ok())
                    != Some(file.media_type.as_str())
            {
                return Err(Error::Protocol("invalid_file"));
            }
            let mut out =
                tokio::fs::OpenOptions::new().write(true).create_new(true).open(&partial).await.map_err(io)?;
            let mut stream = response.bytes_stream();
            let mut hash = Sha256::new();
            let mut bytes = 0u64;
            let expected = file.bytes.parse::<u64>().unwrap();
            while let Some(chunk) = stream.next().await {
                self.read_file_guard(&file, generation, projection, &membership)?;
                let chunk = chunk.map_err(|_| Error::Protocol("file_transfer_failed"))?;
                bytes += chunk.len() as u64;
                if bytes > expected {
                    return Err(Error::Protocol("file_integrity"));
                }
                hash.update(&chunk);
                out.write_all(&chunk).await.map_err(io)?;
            }
            if bytes != expected || hex(&hash.finalize()) != file.sha256 {
                return Err(Error::Protocol("file_integrity"));
            }
            out.sync_all().await.map_err(io)?;
            drop(out);
            self.read_file_guard(&file, generation, projection, &membership)?;
            tokio::fs::rename(&partial, &destination).await.map_err(io)?;
            let mut cache = self.files.cache.lock().unwrap();
            let stored: u64 = cache.values().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum();
            if cache.len() >= 32 || stored + expected > 512 << 20 {
                for path in cache.values() {
                    let _ = std::fs::remove_file(path);
                }
                cache.clear();
            }
            if let Some(old) = cache.insert(file.id.clone(), destination.clone()) {
                let _ = std::fs::remove_file(old);
            }
            Ok(destination.clone())
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&partial).await;
            let _ = tokio::fs::remove_file(&destination).await;
        }
        result
    }
    pub async fn file_media(&self, path: &str) -> Result<Media, Error> {
        if path.starts_with(PRIVATE) {
            let (_, file) = self.private_file(path)?;
            if file.bytes.parse::<u64>().map_err(|_| Error::Protocol("invalid_file"))? > 32 << 20
                || !mime(&file.media_type)
            {
                return Err(Error::Protocol("file_too_large_to_preview"));
            }
            let bytes = tokio::fs::read(self.local_file(path).await?).await.map_err(io)?;
            self.private_file(path)?;
            return Ok(Media { bytes, content_type: file.media_type });
        }
        let file = self.file_descriptor(path)?;
        if file.bytes.parse::<u64>().unwrap() > 32 << 20 {
            return Err(Error::Protocol("file_too_large_to_preview"));
        }
        let local = self.local_file(path).await?;
        let bytes = tokio::fs::read(local).await.map_err(io)?;
        if !self.file_current(path) {
            return Err(Error::Protocol("file_unavailable"));
        }
        Ok(Media { bytes, content_type: file.media_type })
    }
    pub async fn download_file(&self, path: &str, destination: &Path) -> Result<(), Error> {
        let local = self.local_file(path).await?;
        let parent = destination.parent().ok_or(Error::Protocol("file_io_failed"))?;
        let partial = parent.join(format!(".rv-{:032x}.part", fastrand::u128(..)));
        let result = async {
            tokio::fs::copy(local, &partial).await.map_err(io)?;
            if !self.file_current(path) {
                return Err(Error::Protocol("file_unavailable"));
            }
            tokio::fs::rename(&partial, destination).await.map_err(io)?;
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&partial).await;
        }
        result
    }
}
