//! Transient Teams browser-import preview, independent of persistent accounts.
use crate::{Client, model::RvError, on_tokio};
use rv_core::teams::{Error, Reader};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
#[derive(Clone, uniffi::Record)]
pub struct TeamsConversation {
    pub id: String,
    pub name: String,
    pub kind: String,
}
#[derive(Clone, uniffi::Record)]
pub struct TeamsMessage {
    pub key: String,
    pub id: String,
    pub author: String,
    pub arrived_at: String,
    pub text: String,
    pub unsupported: bool,
}
#[derive(Clone, uniffi::Record)]
pub struct TeamsHistory {
    pub items: Vec<TeamsMessage>,
    pub backward_link: Option<String>,
}
fn error(e: Error) -> RvError {
    RvError::Server {
        status: e.status,
        message: e.to_string(),
        error: Some(e.code.to_owned()),
        two_factor: None,
        request_id: None,
        retry_after: e.retry_after,
    }
}
#[derive(uniffi::Object)]
pub struct TeamsPreview {
    pairing: Arc<rv_core::teams_handoff::Pairing>,
    reader: Mutex<Option<Arc<Reader>>>,
    closed: AtomicBool,
}
#[uniffi::export]
impl Client {
    pub fn teams_preview(&self) -> Result<Arc<TeamsPreview>, RvError> {
        Ok(Arc::new(TeamsPreview {
            pairing: rv_core::teams_handoff::Pairing::new().map_err(error)?,
            reader: Mutex::new(None),
            closed: AtomicBool::new(false),
        }))
    }
}
#[uniffi::export]
impl TeamsPreview {
    pub fn pairing_code(&self) -> Result<String, RvError> {
        self.pairing.code().map_err(error)
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.pairing.close();
        if let Some(reader) = self.reader.lock().expect("reader").take() {
            reader.close();
        }
    }
    pub async fn connect(self: Arc<Self>, code: String) -> Result<(), RvError> {
        on_tokio(async move {
            let session = self.pairing.open(&code).map_err(error)?;
            let reader = Reader::from_browser(session).map_err(error)?;
            {
                let mut slot = self.reader.lock().expect("reader");
                if self.closed.load(Ordering::Acquire) {
                    reader.close();
                    return Err(RvError::local("Teams: cancelled"));
                }
                *slot = Some(reader.clone());
            }
            reader.discover().await.map_err(error)
        })
        .await
    }
    pub async fn conversations(&self) -> Result<Vec<TeamsConversation>, RvError> {
        let reader = self.ready()?;
        on_tokio(async move {
            Ok(reader
                .conversations()
                .await
                .map_err(error)?
                .into_iter()
                .map(|r| TeamsConversation { id: r.id, name: r.name, kind: r.kind })
                .collect())
        })
        .await
    }
    pub async fn history(&self, conversation: String, backward: Option<String>) -> Result<TeamsHistory, RvError> {
        let reader = self.ready()?;
        on_tokio(async move {
            let page = reader.history(&conversation, backward.as_deref()).await.map_err(error)?;
            Ok(TeamsHistory {
                items: page
                    .items
                    .into_iter()
                    .map(|m| {
                        let text = rv_core::teams::plain_text(&m);
                        TeamsMessage {
                            key: m.key,
                            id: m.id,
                            author: m.author,
                            arrived_at: m.arrived_at,
                            text,
                            unsupported: m.format == "unsupported",
                        }
                    })
                    .collect(),
                backward_link: page.backward_link,
            })
        })
        .await
    }
}
impl TeamsPreview {
    fn ready(&self) -> Result<Arc<Reader>, RvError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(RvError::local("Teams: cancelled"));
        }
        self.reader.lock().expect("reader").clone().ok_or_else(|| RvError::local("Teams: sign_in_required"))
    }
}
impl Drop for TeamsPreview {
    fn drop(&mut self) {
        self.close();
    }
}
