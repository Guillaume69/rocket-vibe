//! Slack for SwiftUI: the saved, read-only account (`slack_login`,
//! `slack_pair`) and the transient preview. Secret fields are never returned as DTOs.
use crate::{Chat, Client, accounts, blocking, model::RvError, on_tokio};
use rv_core::session::SessionInfo;
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
#[derive(Clone, uniffi::Record)]
pub struct SlackWorkspace {
    pub id: String,
    pub label: String,
}
#[derive(Clone, uniffi::Record)]
pub struct SlackBrowserStatus {
    pub phase: String,
    pub workspaces: Vec<SlackWorkspace>,
    pub error: Option<String>,
}
#[derive(uniffi::Object)]
pub struct SlackBrowserLogin {
    login: Arc<rv_core::slack::browser_login::BrowserLogin>,
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
    /// Signs in with a browser session's `xoxc` token and `d` cookie, checked
    /// by Slack, then saves and opens the account.
    pub async fn slack_login(&self, token: String, cookie: String) -> Result<Arc<Chat>, RvError> {
        let info = on_tokio(async move { rv_core::slack::login(&token, &cookie, None).await }).await?;
        self.keep_slack(info).await
    }

    /// Opens the encrypted answer `code` of the browser bridge with `pairing`,
    /// then saves and opens the account it names.
    pub async fn slack_pair(&self, pairing: Arc<SlackPairing>, code: String) -> Result<Arc<Chat>, RvError> {
        let session = pairing.pairing.open(&code).map_err(error)?;
        if pairing.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(RvError::local("Slack: cancelled"));
        }
        let info = on_tokio(async move { rv_core::slack::login_paired(&session).await }).await?;
        self.keep_slack(info).await
    }

    /// Opens Slack in an owned temporary browser and captures a validated session.
    pub async fn slack_browser_login(&self) -> Result<Arc<SlackBrowserLogin>, RvError> {
        let login =
            on_tokio(async move { rv_core::slack::browser_login::BrowserLogin::start().map_err(error) }).await?;
        Ok(Arc::new(SlackBrowserLogin { login }))
    }

    /// Saves and opens the workspace selected from a completed browser sign-in.
    pub async fn complete_slack_browser_login(
        &self,
        attempt: Arc<SlackBrowserLogin>,
        team_id: String,
    ) -> Result<Arc<Chat>, RvError> {
        let login = attempt.login.clone();
        let info = on_tokio(async move { login.take(&team_id).await.map_err(error) }).await?;
        attempt.login.cancel();
        self.keep_slack(info).await
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
impl SlackBrowserLogin {
    pub fn state(&self) -> SlackBrowserStatus {
        use rv_core::slack::browser_login::State;
        match self.login.state() {
            State::OpeningBrowser => {
                SlackBrowserStatus { phase: "opening_browser".into(), workspaces: vec![], error: None }
            }
            State::SigningIn => SlackBrowserStatus { phase: "signing_in".into(), workspaces: vec![], error: None },
            State::Ready(workspaces) => SlackBrowserStatus {
                phase: "ready".into(),
                workspaces: workspaces.into_iter().map(|w| SlackWorkspace { id: w.id, label: w.label }).collect(),
                error: None,
            },
            State::Complete => SlackBrowserStatus { phase: "complete".into(), workspaces: vec![], error: None },
            State::Failed(code) => {
                SlackBrowserStatus { phase: "failed".into(), workspaces: vec![], error: Some(code.into()) }
            }
            State::Cancelled => SlackBrowserStatus { phase: "cancelled".into(), workspaces: vec![], error: None },
        }
    }

    pub fn cancel(&self) {
        self.login.cancel();
    }
}

impl Drop for SlackBrowserLogin {
    fn drop(&mut self) {
        self.login.cancel();
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

/// Owns pending reader too, so leaving the view cancels authentication before it finishes.
#[derive(uniffi::Object)]
pub struct SlackPairing {
    pairing: Arc<rv_core::slack::handoff::Pairing>,
    reader: std::sync::Mutex<Option<Arc<rv_core::slack::Reader>>>,
    closed: std::sync::atomic::AtomicBool,
}
#[uniffi::export]
impl Client {
    pub fn slack_pairing(&self) -> Result<Arc<SlackPairing>, RvError> {
        Ok(Arc::new(SlackPairing {
            pairing: rv_core::slack::handoff::Pairing::new().map_err(error)?,
            reader: std::sync::Mutex::new(None),
            closed: std::sync::atomic::AtomicBool::new(false),
        }))
    }
}
#[uniffi::export]
impl SlackPairing {
    pub fn pairing_code(&self) -> Result<String, RvError> {
        self.pairing.code().map_err(error)
    }
    pub fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::Release);
        self.pairing.close();
        if let Some(r) = self.reader.lock().expect("reader").take() {
            r.close();
        }
    }
    pub async fn connect(self: Arc<Self>, code: String) -> Result<Arc<SlackPreview>, RvError> {
        on_tokio(async move {
            let session = self.pairing.open(&code).map_err(error)?;
            let reader = rv_core::slack::Reader::from_browser(session).map_err(error)?;
            {
                let mut slot = self.reader.lock().expect("reader");
                if self.closed.load(std::sync::atomic::Ordering::Acquire) {
                    reader.close();
                    return Err(RvError::local("Slack: cancelled"));
                }
                *slot = Some(reader.clone());
            }
            let who = reader.authenticate().await.map_err(error)?;
            if self.closed.load(std::sync::atomic::Ordering::Acquire) {
                reader.close();
                return Err(RvError::local("Slack: cancelled"));
            }
            Ok(Arc::new(SlackPreview {
                reader,
                identity: SlackIdentity { key: who.key, team: who.team, user: who.user },
            }))
        })
        .await
    }
}
impl Drop for SlackPairing {
    fn drop(&mut self) {
        self.close();
    }
}

impl Client {
    async fn keep_slack(&self, info: SessionInfo) -> Result<Arc<Chat>, RvError> {
        let (dirs, saved) = (self.dirs.clone(), info.clone());
        blocking(move || accounts::save(&dirs, &saved, None)).await.map_err(RvError::local)?;
        self.start(info)
    }
}
