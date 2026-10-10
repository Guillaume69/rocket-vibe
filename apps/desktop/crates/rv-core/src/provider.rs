//! One signed-in account, whichever kind of server it speaks to: the
//! operations both sessions offer, behind one type the UIs hold instead of
//! choosing between `Session` and `NativeSession` at every call. `Legacy` is
//! Rocket.Chat, Mattermost or kChat (`Session`, which picks among them through
//! its own `Backend`); `Native` is the RocketVibe server (`NativeSession`).
//!
//! Errors come back as `RestError`, the native ones through
//! `native::rest_error`, which is what the UIs already display. What only one
//! kind of server has (MLS on the RocketVibe server, Rocket.Chat's E2EE,
//! bots, workflows, voice) stays on its session: reach it with `legacy()` or
//! `native()`.

use std::sync::Arc;

use crate::native::{self, NativeSession};
use crate::rest::RestError;
use crate::rooms::Found;
use crate::session::{Session, SessionInfo};
use crate::store::MessageRow;

#[derive(Clone)]
pub enum Chat {
    Legacy(Arc<Session>),
    Native(Arc<NativeSession>),
}

impl From<Arc<Session>> for Chat {
    fn from(session: Arc<Session>) -> Self {
        Chat::Legacy(session)
    }
}

impl From<Arc<NativeSession>> for Chat {
    fn from(session: Arc<NativeSession>) -> Self {
        Chat::Native(session)
    }
}

impl Chat {
    pub fn info(&self) -> &SessionInfo {
        match self {
            Chat::Legacy(session) => &session.info,
            Chat::Native(session) => &session.info,
        }
    }

    pub fn legacy(&self) -> Option<&Arc<Session>> {
        match self {
            Chat::Legacy(session) => Some(session),
            Chat::Native(_) => None,
        }
    }

    pub fn native(&self) -> Option<&Arc<NativeSession>> {
        match self {
            Chat::Legacy(_) => None,
            Chat::Native(session) => Some(session),
        }
    }

    /// The very same session: a late answer checks it still speaks for the
    /// account on screen before acting.
    pub fn same(&self, other: &Chat) -> bool {
        match (self, other) {
            (Chat::Legacy(a), Chat::Legacy(b)) => Arc::ptr_eq(a, b),
            (Chat::Native(a), Chat::Native(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }

    /// People and channels matching `query`, for "New conversation".
    pub async fn spotlight(&self, query: &str) -> Result<Vec<Found>, RestError> {
        match self {
            Chat::Legacy(session) => session.spotlight(query).await,
            Chat::Native(session) => session.spotlight(query).await.map_err(native::rest_error),
        }
    }

    /// A room's pinned messages, or the ones I starred there, as the
    /// timeline shows them.
    pub async fn marked(&self, rid: &str, starred: bool) -> Result<Vec<MessageRow>, RestError> {
        match self {
            Chat::Legacy(session) => session.marked(rid, starred).await,
            Chat::Native(session) => {
                let ids: Vec<String> =
                    session.marked(rid, starred).await.map_err(native::rest_error)?.into_iter().map(|m| m.id).collect();
                let rows = session
                    .store
                    .selected_messages(&ids)
                    .map_err(|e| RestError::incomplete(&format!("marked messages: {e}")))?;
                Ok(rows.into_iter().map(|r| r.presentation(rid, &session.info.user_id)).collect())
            }
        }
    }

    /// A person, by username or by id when `by_id`, as the profile dialog shows them.
    pub async fn profile(&self, key: &str, by_id: bool) -> Result<crate::info::Profile, RestError> {
        match self {
            Chat::Legacy(session) => session.profile(key, by_id).await,
            Chat::Native(session) => {
                session.profile(key, by_id).await.map(|p| session.profile_presentation(&p)).map_err(native::rest_error)
            }
        }
    }

    /// Messages of a room matching `text`, on the server.
    pub async fn search(&self, rid: &str, text: &str) -> Result<Vec<crate::normalize::Message>, RestError> {
        match self {
            Chat::Legacy(session) => session.search(rid, text).await,
            Chat::Native(session) => session.search(rid, text).await.map_err(native::rest_error),
        }
    }
}
