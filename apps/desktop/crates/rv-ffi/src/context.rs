//! The history around a message older than the room's local window, for the
//! SwiftUI room: rv-core's `context::Window` behind a UniFFI object.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rv_core::context::Window;
use rv_core::session::Session;
use rv_core::store::MessageRow;

use crate::model::{MessageItem, RvError};
use crate::{Chat, lay_out, on_tokio};

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(uniffi::Object)]
pub struct ContextView {
    session: Arc<Session>,
    window: Mutex<Window>,
}

#[uniffi::export]
impl Chat {
    /// The history around a message, read from the server and never stored;
    /// None when the server does not give the message back. `local_oldest`:
    /// the oldest message of the local history (`Chat::local_oldest`).
    pub async fn context_around(
        &self,
        rid: String,
        kind: String,
        id: String,
        local_oldest: Option<i64>,
    ) -> Result<Option<Arc<ContextView>>, RvError> {
        let s = self.session.clone();
        let window =
            on_tokio(async move { Window::around(&s.sync, &rid, &kind, &id, local_oldest, now()).await }).await?;
        Ok(window.map(|window| Arc::new(ContextView { session: self.session.clone(), window: Mutex::new(window) })))
    }

    /// The oldest of the latest `limit` messages kept for the room.
    pub fn local_oldest(&self, rid: String, limit: i64) -> Option<i64> {
        self.session.store.messages(&rid, limit).first().map(|r| r.ts)
    }
}

#[uniffi::export]
impl ContextView {
    pub fn has_older(&self) -> bool {
        self.window.lock().unwrap().has_older
    }

    /// False once the window reached the local history: then `merge`.
    pub fn has_newer(&self) -> bool {
        self.window.lock().unwrap().has_newer
    }

    pub async fn older(&self) -> Result<(), RvError> {
        let (s, mut window) = (self.session.clone(), self.window.lock().unwrap().clone());
        let window = on_tokio(async move { window.older(&s.sync).await.map(|()| window) }).await?;
        *self.window.lock().unwrap() = window;
        Ok(())
    }

    pub async fn newer(&self, local_oldest: Option<i64>) -> Result<(), RvError> {
        let (s, mut window) = (self.session.clone(), self.window.lock().unwrap().clone());
        let window = on_tokio(async move { window.newer(&s.sync, local_oldest, now()).await.map(|()| window) }).await?;
        *self.window.lock().unwrap() = window;
        Ok(())
    }

    /// The window, oldest first, laid out; a message also stored shows its
    /// stored version, which live events keep current.
    pub fn messages(&self, unread_after: Option<i64>) -> Vec<MessageItem> {
        let rows = self.window.lock().unwrap().rows();
        let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
        let stored: HashMap<String, MessageRow> =
            self.session.store.messages_by_id(&ids).into_iter().map(|r| (r.id.clone(), r)).collect();
        let rows = rows.into_iter().map(|r| stored.get(&r.id).cloned().unwrap_or(r)).collect();
        lay_out(&self.session, rows, unread_after)
    }

    /// Writes the window into the store once it reached the local history;
    /// returns how many messages the room then shows, from its oldest on.
    pub fn merge(&self) -> i64 {
        let window = self.window.lock().unwrap().clone();
        self.session.store.write(|w| {
            for m in window.messages() {
                w.upsert_message(m);
            }
        });
        window.oldest_ts().map_or(0, |oldest| self.session.store.count_since(window.rid(), oldest))
    }
}
