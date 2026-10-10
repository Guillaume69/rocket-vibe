//! Rocket.Chat rooms for SwiftUI: search across rooms on the device, thread
//! replies also sent to the room, invite links and discussions. Mattermost
//! and kChat offer none but the search.

use crate::model::{MessageItem, RvError};
use crate::{Chat, on_tokio};

/// A message found across rooms, under its room's name.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LocalHit {
    pub room_name: String,
    pub message: MessageItem,
}

/// How a discussion's card reaches its room.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum DiscussionAccess {
    /// In my list already, or a public one joined just now: open it.
    Open,
    /// A private one I am not in: for its members only.
    MembersOnly,
}

#[uniffi::export]
impl Chat {
    /// The stored messages of every room whose words contain `text`
    /// (ignoring ASCII case), newest first, 60 at most; encrypted ones once
    /// unlocked. A message with a `thread_id` opens its thread.
    pub async fn search_local(&self, text: String) -> Vec<LocalHit> {
        let s = self.session.clone();
        let rows = crate::blocking(move || s.search_local(&text)).await;
        rows.into_iter()
            .map(|row| LocalHit {
                room_name: self.session.store.room_name(&row.rid).map(|(name, _)| name).unwrap_or_default(),
                message: self.listed(row),
            })
            .collect()
    }

    /// Whether a thread reply can also be sent to the room (Rocket.Chat).
    pub fn also_in_room_available(&self) -> bool {
        self.session.also_in_room_available()
    }

    /// `send`, a thread reply also shown in the room when `also_in_room`.
    pub async fn send_reply(&self, rid: String, text: String, thread_id: Option<String>, also_in_room: bool) {
        let s = self.session.clone();
        on_tokio(async move { s.send_reply(&rid, &text, thread_id.as_deref(), also_in_room).await }).await
    }

    /// Whether rooms have invite links and discussions here (Rocket.Chat).
    pub fn discussions_available(&self) -> bool {
        self.session.discussions_available()
    }

    /// Whether I may share the room's invite link: a channel or group where
    /// my roles grant `create-invite-links`.
    pub async fn can_invite(&self, rid: String) -> bool {
        let s = self.session.clone();
        on_tokio(async move { s.can_invite(&rid).await }).await
    }

    /// The room's direct invite link (7 days, any number of uses), the same
    /// one each time.
    pub async fn invite_link(&self, rid: String) -> Result<String, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.invite_link(&rid).await }).await?)
    }

    /// Creates a discussion of `prid` named `name` (required), from the
    /// message `message_id` when given, with a first message `reply`; it is
    /// listed when this returns its rid.
    pub async fn create_discussion(
        &self,
        prid: String,
        name: String,
        message_id: Option<String>,
        reply: Option<String>,
    ) -> Result<String, RvError> {
        if name.trim().is_empty() {
            return Err(RvError::local("discussion-name-needed"));
        }
        let s = self.session.clone();
        Ok(on_tokio(async move { s.create_discussion(&prid, &name, message_id.as_deref(), reply.as_deref()).await })
            .await?)
    }

    /// A discussion card's Open: listed, joined (a public one), or for its members.
    pub async fn open_discussion(&self, drid: String) -> Result<DiscussionAccess, RvError> {
        let s = self.session.clone();
        Ok(match on_tokio(async move { s.open_discussion(&drid).await }).await? {
            rv_core::session::DiscussionAccess::Listed | rv_core::session::DiscussionAccess::Joined => {
                DiscussionAccess::Open
            }
            rv_core::session::DiscussionAccess::MembersOnly => DiscussionAccess::MembersOnly,
        })
    }
}

/// The name suggested for a discussion started from a message: its first
/// non-empty line, 60 characters at most.
#[uniffi::export]
pub fn suggested_discussion_name(text: Option<String>) -> String {
    rv_core::actions::suggested_discussion_name(text.as_deref())
}
