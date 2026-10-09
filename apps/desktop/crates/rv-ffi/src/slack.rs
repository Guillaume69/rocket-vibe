//! Transient Slack preview for SwiftUI. Secret fields are never returned as DTOs.
use crate::{Client, model::RvError, on_tokio};
use std::sync::Arc;
#[derive(Clone, uniffi::Record)]
pub struct SlackIdentity {
    pub key: String,
    pub team: String,
    pub user: String,
}
#[derive(Clone, uniffi::Record)]
pub struct SlackConversation {
    pub id: String,
    pub name: String,
    pub kind: String,
}
#[derive(Clone, uniffi::Record)]
pub struct SlackConversationPage {
    pub items: Vec<SlackConversation>,
    pub next_cursor: Option<String>,
}
#[derive(Clone, uniffi::Record)]
pub struct SlackMessage {
    pub ts: String,
    pub user: String,
    pub text: String,
    pub thread_ts: Option<String>,
}
#[derive(Clone, uniffi::Record)]
pub struct SlackMessagePage {
    pub items: Vec<SlackMessage>,
    pub next_cursor: Option<String>,
}
#[derive(uniffi::Object)]
pub struct SlackPreview {
    reader: Arc<rv_core::slack::Reader>,
    identity: SlackIdentity,
}
fn error(e: rv_core::slack::Error) -> RvError {
    RvError::Server {
        status: e.status,
        message: e.to_string(),
        error: Some(e.code.to_owned()),
        two_factor: None,
        request_id: None,
        retry_after: e.retry_after,
    }
}
#[uniffi::export]
impl Client {
    pub fn experimental_providers(&self) -> bool {
        self.dirs.config.join("experimental-providers").exists()
    }
    pub fn set_experimental_providers(&self, enabled: bool) -> Result<(), RvError> {
        let file = self.dirs.config.join("experimental-providers");
        if enabled {
            std::fs::create_dir_all(&self.dirs.config)
                .and_then(|()| std::fs::write(file, ""))
                .map_err(|_| RvError::local("Unable to save experimental provider setting"))?;
        } else if file.exists() {
            std::fs::remove_file(file).map_err(|_| RvError::local("Unable to save experimental provider setting"))?;
        }
        Ok(())
    }
    pub async fn slack_preview(&self, token: String, cookie: String) -> Result<Arc<SlackPreview>, RvError> {
        on_tokio(async move {
            let reader = rv_core::slack::Reader::new(token, cookie).map_err(error)?;
            let who = reader.authenticate().await.map_err(error)?;
            Ok(Arc::new(SlackPreview {
                reader,
                identity: SlackIdentity { key: who.key, team: who.team, user: who.user },
            }))
        })
        .await
    }
}
#[uniffi::export]
impl SlackPreview {
    pub fn identity(&self) -> SlackIdentity {
        self.identity.clone()
    }
    pub fn close(&self) {
        self.reader.close();
    }
    pub async fn conversations(&self, cursor: Option<String>) -> Result<SlackConversationPage, RvError> {
        let reader = self.reader.clone();
        on_tokio(async move {
            let page = reader.conversations(cursor.as_deref()).await.map_err(error)?;
            Ok(SlackConversationPage {
                items: page
                    .items
                    .into_iter()
                    .map(|r| SlackConversation { id: r.id, name: r.name, kind: r.kind })
                    .collect(),
                next_cursor: page.next_cursor,
            })
        })
        .await
    }
    pub async fn history(&self, channel: String, cursor: Option<String>) -> Result<SlackMessagePage, RvError> {
        let reader = self.reader.clone();
        on_tokio(async move {
            let page = reader.history(&channel, cursor.as_deref()).await.map_err(error)?;
            Ok(SlackMessagePage {
                items: page
                    .items
                    .into_iter()
                    .map(|m| SlackMessage { ts: m.ts, user: m.user, text: m.text, thread_ts: m.thread_ts })
                    .collect(),
                next_cursor: page.next_cursor,
            })
        })
        .await
    }
}
impl Drop for SlackPreview {
    fn drop(&mut self) {
        self.reader.close();
    }
}
