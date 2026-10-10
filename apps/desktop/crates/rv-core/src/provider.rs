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

use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::native::{self, NativeSession};
use crate::rest::RestError;
use crate::rooms::Found;
use crate::session::{Session, SessionEvent, SessionInfo};
use crate::store::{Change, MessageRow};

/// What a UI hears from an account, whichever server it speaks to.
#[derive(Debug)]
pub enum ChatEvent {
    /// These rooms or messages changed: Rocket.Chat, Mattermost and kChat say which.
    Changed(Change),
    /// Something changed without saying what (the RocketVibe server always
    /// says it so), or changes were missed: read everything again. Arrives in
    /// bursts; a UI may fold a burst into one reload.
    Reload,
    /// A message to notify, already checked against the account's state.
    Incoming(crate::notify::Incoming),
    /// The rest of a Rocket.Chat, Mattermost or kChat session's events
    /// (connection, typing, presence, uploads, photos, E2EE, expiry...).
    Session(SessionEvent),
}

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

    /// The account's events, in order, until its session ends or the
    /// receiver is dropped; the task forwarding them is returned to be
    /// aborted when the account is closed. Must run inside a tokio runtime.
    pub fn events(&self) -> (mpsc::Receiver<ChatEvent>, JoinHandle<()>) {
        let (tx, rx) = mpsc::channel(64);
        let task = match self {
            Chat::Legacy(session) => {
                let (mut changes, mut events) = (session.store.changes(), session.events());
                tokio::spawn(async move {
                    loop {
                        let event = tokio::select! {
                            c = changes.recv() => match c {
                                Ok(change) => ChatEvent::Changed(change),
                                Err(RecvError::Lagged(_)) => ChatEvent::Reload,
                                Err(RecvError::Closed) => return,
                            },
                            e = events.recv() => match e {
                                Ok(SessionEvent::Incoming(incoming)) => ChatEvent::Incoming(*incoming),
                                Ok(event) => ChatEvent::Session(event),
                                Err(RecvError::Lagged(_)) => continue,
                                Err(RecvError::Closed) => return,
                            },
                        };
                        if tx.send(event).await.is_err() {
                            return;
                        }
                    }
                })
            }
            Chat::Native(session) => {
                let (mut incoming, mut changes, mut events) =
                    (session.incoming(), session.store.changes(), session.events());
                // Weak: the forwarder must not keep a closed account alive.
                let session = Arc::downgrade(session);
                tokio::spawn(async move {
                    loop {
                        let event = tokio::select! {
                            n = incoming.recv() => match n {
                                Ok(incoming) => {
                                    let Some(session) = session.upgrade() else { return };
                                    if !session.notification_current(&incoming) {
                                        continue;
                                    }
                                    ChatEvent::Incoming(incoming)
                                }
                                Err(RecvError::Lagged(_)) => continue,
                                Err(RecvError::Closed) => return,
                            },
                            c = changes.recv() => match c {
                                Err(RecvError::Closed) => return,
                                _ => ChatEvent::Reload,
                            },
                            e = events.recv() => match e {
                                Err(RecvError::Closed) => return,
                                _ => ChatEvent::Reload,
                            },
                        };
                        if tx.send(event).await.is_err() {
                            return;
                        }
                    }
                })
            }
        };
        (rx, task)
    }
}
