//! Files sent in two steps: `rooms.media` stores the bytes and returns a
//! `fileId`, `rooms.mediaConfirm` posts the message. The `fileId` is persisted
//! between the two, because the server cannot say whether a confirm already
//! happened: replayed at once, it posts a second message yet answers with the
//! first; replayed later, it refuses with `invalid-file` although the file was
//! delivered. Only the local database can tell, so it is asked (after a
//! refresh of the room when it knows nothing) before any replay.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::broadcast;
use tokio::task::AbortHandle;

use crate::actions::ServerSettings;
use crate::rest::{CallOptions, RestClient, RestError};
use crate::store::{Store, UploadRow};
use crate::sync::SyncEngine;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    TooLarge { max_mb: String },
    TypeNotAllowed { mime: String },
}

/// `FileUpload_MaxFileSize` and `FileUpload_MediaTypeWhiteList`, where
/// `image/*` accepts any image.
pub fn validate(settings: &ServerSettings, size: u64, mime: &str) -> Result<(), Refusal> {
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
    /// The rid whose upload progressed.
    changed: broadcast::Sender<String>,
}

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
            changed,
        }
    }

    pub fn changes(&self) -> broadcast::Receiver<String> {
        self.changed.subscribe()
    }

    /// 0..1 while the bytes go up.
    pub fn progress(&self, id: &str) -> Option<f64> {
        self.progress.lock().unwrap().get(id).copied()
    }

    pub fn enqueue(&self, rid: &str, path: &str, name: &str, mime: &str, caption: Option<&str>, temporary: bool) {
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
            if !self.pass().await || !self.again.load(Ordering::SeqCst) {
                return;
            }
        }
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
        let file_id = match &row.file_id {
            Some(file_id) if self.already_posted(&row.rid, file_id).await => {
                self.settle(row);
                return Ok(Outcome::Done);
            }
            Some(file_id) => file_id.clone(),
            None => match self.send_bytes(row).await {
                Ok(file_id) => file_id,
                Err(e) if e.status == 0 => return Ok(Outcome::Offline),
                Err(e) => return Err(e),
            },
        };
        if self.abandoned.lock().unwrap().contains(&row.id) {
            return Ok(Outcome::Done);
        }
        let body = match &row.caption {
            Some(caption) => json!({"msg": caption}),
            None => json!({}),
        };
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

    /// The bytes, in a task of their own so that Discard can cut them off.
    async fn send_bytes(self: &Arc<Self>, row: &UploadRow) -> Result<String, RestError> {
        let bytes =
            tokio::fs::read(&row.path).await.map_err(|e| RestError::incomplete(&format!("{}: {e}", row.path)))?;
        let (this, task_row) = (self.clone(), row.clone());
        let task = tokio::spawn(async move {
            let (progress_of, progress_row) = (this.clone(), task_row.clone());
            this.rest
                .upload(
                    &format!("rooms.media/{}", task_row.rid),
                    bytes,
                    &task_row.name,
                    &task_row.mime,
                    move |sent, total| progress_of.set_progress(&progress_row, sent as f64 / total.max(1) as f64),
                )
                .await
        });
        self.tasks.lock().unwrap().insert(row.id.clone(), task.abort_handle());
        let response = match task.await {
            Ok(r) => r?,
            Err(_) => return Err(RestError::incomplete("upload discarded")),
        };
        let file_id = response
            .pointer("/file/_id")
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
        assert_eq!(validate(&settings, 10, "image/png"), Ok(()));
        assert_eq!(validate(&settings, 10, "application/pdf"), Ok(()));
        assert_eq!(validate(&settings, 10, "video/mp4"), Err(Refusal::TypeNotAllowed { mime: "video/mp4".into() }));
        assert_eq!(validate(&settings, 2 * 1024 * 1024, "image/png"), Err(Refusal::TooLarge { max_mb: "1.0".into() }));
        assert_eq!(validate(&ServerSettings::from_list(&[]), u64::MAX, "x/y"), Ok(()));
    }
}
