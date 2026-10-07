//! Files sent in two steps: `rooms.media` stores the bytes and returns a
//! `fileId`, `rooms.mediaConfirm` posts the message. The `fileId` is persisted
//! between the two, because the server cannot say whether a confirm already
//! happened: replayed at once, it posts a second message yet answers with the
//! first; replayed later, it refuses with `invalid-file` although the file was
//! delivered. Only the local database can tell, so it is asked (after a
//! refresh of the room when it knows nothing) before any replay.
//!
//! In an encrypted room the file goes up encrypted under a key of its own and
//! the SHA-256 of its name; its real name, type, key and the caption travel
//! only in contents encrypted under the room key, as the web client sends them.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::broadcast;
use tokio::task::AbortHandle;

use crate::actions::ServerSettings;
use crate::mattermost::sync::MmSync;
use crate::rest::{Api, CallOptions, RestClient, RestError};
use crate::store::{Store, UploadRow};
use crate::sync::SyncEngine;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    TooLarge { max_mb: String },
    TypeNotAllowed { mime: String },
    EncryptedFilesOff,
}

/// `FileUpload_MaxFileSize` and `FileUpload_MediaTypeWhiteList`, where
/// `image/*` accepts any image.
pub fn validate(settings: &ServerSettings, size: u64, mime: &str, encrypted_room: bool) -> Result<(), Refusal> {
    if encrypted_room && !settings.encrypted_files {
        return Err(Refusal::EncryptedFilesOff);
    }
    if let Some(max) = settings.max_file_size
        && size > max as u64
    {
        return Err(Refusal::TooLarge { max_mb: format!("{:.1}", max as f64 / 1024.0 / 1024.0) });
    }
    let allowed = settings.media_whitelist.is_empty()
        || settings.media_whitelist.iter().any(|pattern| {
            pattern == mime
                || pattern
                    .split_once('/')
                    .is_some_and(|(family, sub)| sub == "*" && mime.split_once('/').is_some_and(|(f, _)| f == family))
        });
    if allowed { Ok(()) } else { Err(Refusal::TypeNotAllowed { mime: mime.to_owned() }) }
}

enum Outcome {
    Done,
    /// The server is out of reach: stop the pass, the row waits for the next.
    Offline,
    /// No room key (locked): this row waits, the others go on.
    Waiting,
}

type Encryptor = dyn Fn(&str, &Value) -> Option<Value> + Send + Sync;

/// What goes up to `rooms.media`: the file's bytes under a name and type, and text fields beside it.
struct Upload {
    bytes: Vec<u8>,
    name: String,
    mime: String,
    texts: Vec<(String, String)>,
}

/// A file encrypted and uploaded, waiting for its confirm. In memory only:
/// a process killed in between loses its key, and the file goes up again.
struct Sealed {
    key: Value,
    iv: String,
    sha256: String,
    size: usize,
    hashed_name: String,
}

/// The attachment of an encrypted file, as the web client builds and reads
/// it: `title_link` is the ciphertext, the key and hash make it readable, and
/// an image, sound or video announces itself as such.
fn encrypted_attachment(file_id: &str, row: &UploadRow, sealed: &Sealed) -> Value {
    let (name, mime, size) = (&row.name, &row.mime, sealed.size);
    let url = format!("/file-upload/{file_id}/{}", sealed.hashed_name);
    let mut attachment = json!({
        "title": name, "type": "file", "title_link": url, "title_link_download": true,
        "encryption": {"key": sealed.key, "iv": sealed.iv}, "hashes": {"sha256": sealed.sha256}, "fileId": file_id,
    });
    match mime.split('/').next().filter(|g| matches!(*g, "image" | "audio" | "video")) {
        Some(group) => {
            attachment[format!("{group}_url")] = json!(url);
            attachment[format!("{group}_type")] = json!(mime);
            attachment[format!("{group}_size")] = json!(size);
        }
        None => {
            attachment["size"] = json!(size);
            attachment["format"] = json!(name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default());
        }
    }
    attachment
}

pub struct Uploads {
    store: Arc<Store>,
    rest: RestClient,
    sync: Arc<SyncEngine>,
    progress: Mutex<HashMap<String, f64>>,
    running: tokio::sync::Mutex<()>,
    again: AtomicBool,
    abandoned: Mutex<HashSet<String>>,
    tasks: Mutex<HashMap<String, AbortHandle>>,
    encryptor: Mutex<Option<Arc<Encryptor>>>,
    sealed: Mutex<HashMap<String, Sealed>>,
    /// The rid whose upload progressed.
    changed: broadcast::Sender<String>,
    /// Passes in a row that ended for want of a connection; each schedules
    /// the next one, without waiting for the socket to come back.
    offline_passes: AtomicU32,
}

/// Delays before trying the queue again after a connection error.
const OFFLINE_RETRY: [Duration; 4] =
    [Duration::from_secs(2), Duration::from_secs(5), Duration::from_secs(15), Duration::from_secs(30)];

impl Uploads {
    pub fn new(store: Arc<Store>, rest: RestClient, sync: Arc<SyncEngine>) -> Self {
        // One process at a time owns the database: a `sending` row can only
        // come from a run that died mid-upload.
        store.write(|w| w.rearm_sending_uploads());
        let (changed, _) = broadcast::channel(64);
        Uploads {
            store,
            rest,
            sync,
            progress: Mutex::default(),
            running: tokio::sync::Mutex::new(()),
            again: AtomicBool::new(false),
            abandoned: Mutex::default(),
            tasks: Mutex::default(),
            encryptor: Mutex::new(None),
            sealed: Mutex::default(),
            changed,
            offline_passes: AtomicU32::new(0),
        }
    }

    /// How a payload is encrypted for a room: None while it cannot be.
    pub fn set_encryptor(&self, encryptor: impl Fn(&str, &Value) -> Option<Value> + Send + Sync + 'static) {
        *self.encryptor.lock().unwrap() = Some(Arc::new(encryptor));
    }

    pub fn changes(&self) -> broadcast::Receiver<String> {
        self.changed.subscribe()
    }

    /// 0..1 while the bytes go up.
    pub fn progress(&self, id: &str) -> Option<f64> {
        self.progress.lock().unwrap().get(id).copied()
    }

    #[allow(clippy::too_many_arguments)] // The file, its caption and where it goes.
    pub fn enqueue(
        &self,
        rid: &str,
        path: &str,
        name: &str,
        mime: &str,
        caption: Option<&str>,
        temporary: bool,
        tmid: Option<&str>,
    ) {
        let row = UploadRow {
            id: format!("up-{:016x}", fastrand::u64(..)),
            rid: rid.to_owned(),
            path: path.to_owned(),
            name: name.to_owned(),
            mime: mime.to_owned(),
            caption: caption.map(str::trim).filter(|c| !c.is_empty()).map(str::to_owned),
            file_id: None,
            status: "pending".to_owned(),
            temporary,
            tmid: tmid.map(str::to_owned),
        };
        let now = chrono::Utc::now().timestamp_millis();
        self.store.write(|w| w.insert_upload(&row, now));
    }

    /// One pass over the queue at a time; a call during a pass asks for another.
    pub async fn process(self: &Arc<Self>) {
        let Ok(_guard) = self.running.try_lock() else {
            self.again.store(true, Ordering::SeqCst);
            return;
        };
        loop {
            self.again.store(false, Ordering::SeqCst);
            if !self.pass().await {
                self.retry_later();
                return;
            }
            self.offline_passes.store(0, Ordering::SeqCst);
            if !self.again.load(Ordering::SeqCst) {
                return;
            }
        }
    }

    fn retry_later(self: &Arc<Self>) {
        let passes = self.offline_passes.fetch_add(1, Ordering::SeqCst) as usize;
        let delay = OFFLINE_RETRY[passes.min(OFFLINE_RETRY.len() - 1)];
        let this = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if let Some(this) = this.upgrade() {
                this.process().await;
            }
        });
        for rid in self.store.pending_uploads().into_iter().map(|row| row.rid) {
            let _ = self.changed.send(rid);
        }
    }

    /// The last pass found no connection: the queue is being retried.
    pub fn reconnecting(&self) -> bool {
        self.offline_passes.load(Ordering::SeqCst) > 0
    }

    /// The explicit "Retry": the only way out of `failed`.
    pub async fn retry(self: &Arc<Self>, id: &str) {
        self.store.write(|w| w.set_upload_status(id, "pending"));
        self.process().await;
    }

    /// Removes the row and interrupts its transfer. After the confirm the
    /// message exists and nothing can take it back.
    pub fn discard(&self, id: &str) {
        self.abandoned.lock().unwrap().insert(id.to_owned());
        self.sealed.lock().unwrap().remove(id);
        let row = self.store.upload(id);
        self.store.write(|w| w.delete_upload(id));
        if let Some(task) = self.tasks.lock().unwrap().remove(id) {
            task.abort();
        }
        if let Some(row) = row {
            self.remove_temporary(&row);
        }
        self.progress.lock().unwrap().remove(id);
    }

    async fn pass(self: &Arc<Self>) -> bool {
        for row in self.store.pending_uploads() {
            if !self.store.write(|w| w.claim_upload(&row.id)) {
                continue;
            }
            self.set_progress(&row, 0.0);
            let result = self.post(&row).await;
            self.progress.lock().unwrap().remove(&row.id);
            self.tasks.lock().unwrap().remove(&row.id);
            let abandoned = self.abandoned.lock().unwrap().remove(&row.id);
            let _ = self.changed.send(row.rid.clone());
            match result {
                _ if abandoned => {}
                Ok(Outcome::Done) => {}
                Ok(Outcome::Offline) => {
                    self.store.write(|w| w.set_upload_status(&row.id, "pending"));
                    return false;
                }
                Ok(Outcome::Waiting) => self.store.write(|w| w.set_upload_status(&row.id, "pending")),
                Err(_) => self.store.write(|w| w.set_upload_status(&row.id, "failed")),
            }
        }
        true
    }

    fn set_progress(&self, row: &UploadRow, fraction: f64) {
        let before = self.progress.lock().unwrap().insert(row.id.clone(), fraction).unwrap_or(0.0);
        if (before * 100.0).floor() != (fraction * 100.0).floor() || fraction == 0.0 {
            let _ = self.changed.send(row.rid.clone());
        }
    }

    async fn post(self: &Arc<Self>, row: &UploadRow) -> Result<Outcome, RestError> {
        if let Some(mm) = self.sync.mattermost().cloned() {
            return self.post_mattermost(row, &mm).await;
        }
        if self.store.room_encrypted(&row.rid) {
            return self.post_encrypted(row).await;
        }
        let file_id = match &row.file_id {
            Some(file_id) if self.already_posted(&row.rid, file_id).await => {
                self.settle(row);
                return Ok(Outcome::Done);
            }
            Some(file_id) => file_id.clone(),
            None => {
                let bytes = tokio::fs::read(&row.path)
                    .await
                    .map_err(|e| RestError::incomplete(&format!("{}: {e}", row.path)))?;
                let upload = Upload { bytes, name: row.name.clone(), mime: row.mime.clone(), texts: Vec::new() };
                match self.send_bytes(row, upload).await {
                    Ok(file_id) => file_id,
                    Err(e) if e.status == 0 => return Ok(Outcome::Offline),
                    Err(e) => return Err(e),
                }
            }
        };
        if self.abandoned.lock().unwrap().contains(&row.id) {
            return Ok(Outcome::Done);
        }
        // `sendFileMessage` validates `tmid` on 8.5: the file answers the thread.
        let mut body = match &row.caption {
            Some(caption) => json!({"msg": caption}),
            None => json!({}),
        };
        if let Some(tmid) = &row.tmid {
            body["tmid"] = json!(tmid);
        }
        let confirmed =
            match self.rest.post(&format!("rooms.mediaConfirm/{}/{file_id}", row.rid), CallOptions::body(body)).await {
                Ok(v) => v,
                Err(e) if e.status == 0 => return Ok(Outcome::Offline),
                Err(e) => return Err(e),
            };
        self.settle(row);
        if let Some(message) = confirmed.get("message").filter(|m| m.is_object())
            && !self.abandoned.lock().unwrap().contains(&row.id)
        {
            self.sync.ingest_messages(std::slice::from_ref(message));
        }
        Ok(Outcome::Done)
    }

    /// Mattermost's two steps: `POST /files` stores the bytes, a post with
    /// `file_ids` shows them. The file id is persisted between the two, as on
    /// Rocket.Chat, and the store asked before a replay.
    async fn post_mattermost(self: &Arc<Self>, row: &UploadRow, mm: &MmSync) -> Result<Outcome, RestError> {
        let file_id = match &row.file_id {
            Some(file_id) if self.already_posted(&row.rid, file_id).await => {
                self.settle(row);
                return Ok(Outcome::Done);
            }
            Some(file_id) => file_id.clone(),
            None => {
                let bytes = tokio::fs::read(&row.path)
                    .await
                    .map_err(|e| RestError::incomplete(&format!("{}: {e}", row.path)))?;
                let texts = vec![("channel_id".to_owned(), row.rid.clone())];
                let upload = Upload { bytes, name: row.name.clone(), mime: row.mime.clone(), texts };
                match self.send_bytes(row, upload).await {
                    Ok(file_id) => file_id,
                    Err(e) if e.status == 0 => return Ok(Outcome::Offline),
                    Err(e) => return Err(e),
                }
            }
        };
        if self.abandoned.lock().unwrap().contains(&row.id) {
            return Ok(Outcome::Done);
        }
        let body = json!({"channel_id": row.rid, "message": row.caption.clone().unwrap_or_default(),
            "root_id": row.tmid.clone().unwrap_or_default(), "file_ids": [file_id], "pending_post_id": row.id});
        let post = match self.rest.post("posts", CallOptions::body(body)).await {
            Ok(v) => v,
            Err(e) if e.status == 0 => return Ok(Outcome::Offline),
            Err(e) => return Err(e),
        };
        self.settle(row);
        if !self.abandoned.lock().unwrap().contains(&row.id) {
            mm.ingest(&[post]);
        }
        Ok(Outcome::Done)
    }

    /// The encrypted counterpart of `post`, same two steps. Nothing leaves
    /// while the room key is missing, neither the bytes nor the message.
    async fn post_encrypted(self: &Arc<Self>, row: &UploadRow) -> Result<Outcome, RestError> {
        let Some(encrypt) = self.encryptor.lock().unwrap().clone() else { return Ok(Outcome::Waiting) };
        if encrypt(&row.rid, &json!({})).is_none() {
            return Ok(Outcome::Waiting);
        }
        let mut file_id = row.file_id.clone();
        if let Some(known) = &file_id
            && !self.sealed.lock().unwrap().contains_key(&row.id)
        {
            if self.already_posted(&row.rid, known).await {
                self.settle(row);
                return Ok(Outcome::Done);
            }
            file_id = None;
        }
        let meta = |s: &Sealed| {
            json!({"type": row.mime, "typeGroup": row.mime.split('/').next().unwrap_or_default(), "name": row.name,
                "encryption": {"key": s.key, "iv": s.iv}, "hashes": {"sha256": s.sha256}})
        };
        let file_id = match file_id {
            Some(id) => id,
            None => {
                let plain = tokio::fs::read(&row.path)
                    .await
                    .map_err(|e| RestError::incomplete(&format!("{}: {e}", row.path)))?;
                let encrypted = crate::e2e::encrypt_file(&plain)
                    .map_err(|e| RestError::incomplete(&format!("{}: {e}", row.name)))?;
                let sealed = Sealed {
                    key: encrypted.key,
                    iv: encrypted.iv,
                    sha256: encrypted.sha256,
                    size: plain.len(),
                    hashed_name: crate::e2e::hashed_name(&row.name),
                };
                let Some(content) = encrypt(&row.rid, &meta(&sealed)) else { return Ok(Outcome::Waiting) };
                let upload = Upload {
                    bytes: encrypted.data,
                    name: sealed.hashed_name.clone(),
                    mime: "application/octet-stream".to_owned(),
                    texts: vec![("content".to_owned(), content.to_string())],
                };
                let id = match self.send_bytes(row, upload).await {
                    Ok(id) => id,
                    Err(e) if e.status == 0 => return Ok(Outcome::Offline),
                    Err(e) => return Err(e),
                };
                self.sealed.lock().unwrap().insert(row.id.clone(), sealed);
                id
            }
        };
        if self.abandoned.lock().unwrap().contains(&row.id) {
            return Ok(Outcome::Done);
        }
        let body = {
            let sealed = self.sealed.lock().unwrap();
            let Some(s) = sealed.get(&row.id) else { return Ok(Outcome::Waiting) };
            let attachment = encrypted_attachment(&file_id, row, s);
            let file = json!({"_id": file_id, "name": row.name, "type": row.mime, "size": s.size});
            let payload = json!({"msg": row.caption.clone().unwrap_or_default(), "attachments": [attachment],
                "files": [file], "file": file});
            let (Some(content), Some(file_content)) = (encrypt(&row.rid, &payload), encrypt(&row.rid, &meta(s))) else {
                return Ok(Outcome::Waiting);
            };
            let mut body = json!({"msg": "", "t": crate::normalize::ENCRYPTED_TYPE, "content": content, "fileContent": file_content});
            if let Some(tmid) = &row.tmid {
                body["tmid"] = json!(tmid);
            }
            body
        };
        let confirmed =
            match self.rest.post(&format!("rooms.mediaConfirm/{}/{file_id}", row.rid), CallOptions::body(body)).await {
                Ok(v) => v,
                Err(e) if e.status == 0 => return Ok(Outcome::Offline),
                Err(e) => return Err(e),
            };
        self.sealed.lock().unwrap().remove(&row.id);
        self.settle(row);
        if let Some(message) = confirmed.get("message").filter(|m| m.is_object())
            && !self.abandoned.lock().unwrap().contains(&row.id)
        {
            self.sync.ingest_messages(std::slice::from_ref(message));
        }
        Ok(Outcome::Done)
    }

    /// The bytes, in a task of their own so that Discard can cut them off.
    async fn send_bytes(self: &Arc<Self>, row: &UploadRow, upload: Upload) -> Result<String, RestError> {
        let (this, task_row) = (self.clone(), row.clone());
        let mattermost = self.rest.api() == Api::Mattermost;
        let task = tokio::spawn(async move {
            let (progress_of, progress_row) = (this.clone(), task_row.clone());
            let (path, field) = if mattermost {
                ("files".to_owned(), "files")
            } else {
                (format!("rooms.media/{}", task_row.rid), "file")
            };
            this.rest
                .upload(&path, field, upload.bytes, &upload.name, &upload.mime, upload.texts, move |sent, total| {
                    progress_of.set_progress(&progress_row, sent as f64 / total.max(1) as f64)
                })
                .await
        });
        self.tasks.lock().unwrap().insert(row.id.clone(), task.abort_handle());
        let response = match task.await {
            Ok(r) => r?,
            Err(_) => return Err(RestError::incomplete("upload discarded")),
        };
        let file_id = response
            .pointer("/file/_id")
            .or_else(|| response.pointer("/file_infos/0/id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| RestError::incomplete("rooms.media: no file id"))?;
        self.store.write(|w| w.set_upload_file_id(&row.id, &file_id));
        Ok(file_id)
    }

    async fn already_posted(&self, rid: &str, file_id: &str) -> bool {
        if self.store.file_posted(rid, file_id) {
            return true;
        }
        let Some(kind) = self.store.room_kind(rid) else { return false };
        if self.sync.load_history(rid, &kind, None).await.is_err() {
            return false;
        }
        self.store.file_posted(rid, file_id)
    }

    fn settle(&self, row: &UploadRow) {
        self.store.write(|w| w.delete_upload(&row.id));
        self.remove_temporary(row);
    }

    fn remove_temporary(&self, row: &UploadRow) {
        if row.temporary {
            let _ = std::fs::remove_file(&row.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation() {
        let settings = ServerSettings {
            max_file_size: Some(1024 * 1024),
            media_whitelist: vec!["image/*".into(), "application/pdf".into()],
            ..ServerSettings::from_list(&[])
        };
        assert_eq!(validate(&settings, 10, "image/png", false), Ok(()));
        assert_eq!(validate(&settings, 10, "application/pdf", false), Ok(()));
        assert_eq!(
            validate(&settings, 10, "video/mp4", false),
            Err(Refusal::TypeNotAllowed { mime: "video/mp4".into() })
        );
        assert_eq!(
            validate(&settings, 2 * 1024 * 1024, "image/png", false),
            Err(Refusal::TooLarge { max_mb: "1.0".into() })
        );
        assert_eq!(validate(&ServerSettings::from_list(&[]), u64::MAX, "x/y", false), Ok(()));
        assert_eq!(validate(&ServerSettings::from_list(&[]), 10, "image/png", true), Err(Refusal::EncryptedFilesOff));
        let on = ServerSettings::from_list(&[json!({"_id": "E2E_Enable_Encrypt_Files", "value": true})]);
        assert_eq!(validate(&on, 10, "image/png", true), Ok(()));
    }
}
