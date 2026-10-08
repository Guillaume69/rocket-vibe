//! Rooms and people: their details, my own profile, search, calls, and the
//! pinned and starred messages of a room.

use rv_core::media::{self, AvatarTarget};
use rv_core::session::two_factor_code;
use serde_json::json;

use crate::model::{MessageItem, Presence, RvError};
use crate::{Chat, on_tokio};

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RoomDetails {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub topic: Option<String>,
    pub announcement: Option<String>,
    pub description: Option<String>,
    pub members: Option<i64>,
    pub read_only: bool,
    pub encrypted: bool,
    pub archived: bool,
    pub default: bool,
}

impl From<rv_core::info::RoomInfo> for RoomDetails {
    fn from(r: rv_core::info::RoomInfo) -> Self {
        RoomDetails {
            id: r.id,
            name: r.name,
            kind: r.kind,
            topic: r.topic,
            announcement: r.announcement,
            description: r.description,
            members: r.members,
            read_only: r.read_only,
            encrypted: r.encrypted,
            archived: r.archived,
            default: r.default,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Person {
    pub id: String,
    pub username: String,
    pub name: Option<String>,
    pub presence: Option<Presence>,
    pub status_text: Option<String>,
    pub roles: Vec<String>,
    /// Their time now and their zone: `14:05 (UTC+2)`.
    pub local_time: Option<String>,
    pub bio: Option<String>,
    pub avatar: String,
    /// A RocketVibe bot account; false on Rocket.Chat.
    pub bot: bool,
    /// The username of the person who owns this bot.
    pub bot_owner: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Me {
    pub username: String,
    pub name: String,
    pub email: String,
    /// `online`, `away`, `busy` or `offline`: the status I chose.
    pub status: String,
    pub status_text: String,
    pub bio: String,
    pub avatar: String,
    /// `default`, `all`, `mention` or `nothing`.
    pub desktop_notifications: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SearchHit {
    pub id: String,
    pub author: String,
    pub ts: i64,
    pub body: Vec<crate::markup::BodyBlock>,
}

fn me_record(m: rv_core::account::Me) -> Me {
    Me {
        avatar: media::avatar_path(AvatarTarget::User(&m.username), m.avatar_etag.as_deref()),
        username: m.username,
        name: m.name,
        email: m.email,
        status: m.status,
        status_text: m.status_text,
        bio: m.bio,
        desktop_notifications: m.desktop_notifications,
    }
}

#[uniffi::export]
impl Chat {
    pub async fn room_details(&self, rid: String) -> Result<RoomDetails, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.room_info(&rid).await }).await?.into())
    }

    /// A channel by its name (a `#channel` link): its details, id included.
    pub async fn room_named(&self, name: String) -> Result<RoomDetails, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.room_by_name(&name).await }).await?.into())
    }

    /// Someone, by username, or by user id when `by_id`.
    pub async fn person(&self, key: String, by_id: bool) -> Result<Person, RvError> {
        let s = self.session.clone();
        let p = on_tokio(async move { s.profile(&key, by_id).await }).await?;
        Ok(Person {
            avatar: media::avatar_path(AvatarTarget::User(&p.username), p.avatar_etag.as_deref()),
            local_time: p.utc_offset.map(|o| rv_core::info::local_time(o, chrono::Utc::now())),
            presence: self.session.presence(&p.id).or(p.presence).map(Presence::from),
            id: p.id,
            username: p.username,
            name: p.name,
            status_text: p.status_text,
            roles: p.roles,
            bio: p.bio,
            bot: p.bot,
            bot_owner: p.bot_owner,
        })
    }

    /// Someone's live presence, by user id: None until the server told.
    pub fn presence_of(&self, uid: String) -> Option<Presence> {
        self.session.presence(&uid).map(Presence::from)
    }

    pub async fn me(&self) -> Result<Me, RvError> {
        let s = self.session.clone();
        Ok(me_record(on_tokio(async move { s.me().await }).await?))
    }

    /// Saves what changed between `before` and `after` (name, username, email,
    /// bio). Username and email also need my password, and the server may ask
    /// a 2FA code (an `RvError::Server` with `two_factor`), then given back
    /// with its `method`.
    pub async fn update_profile(
        &self,
        before: Me,
        after: Me,
        password: Option<String>,
        method: Option<String>,
        code: Option<String>,
    ) -> Result<(), RvError> {
        let core = |m: &Me| rv_core::account::Me {
            username: m.username.clone(),
            name: m.name.clone(),
            email: m.email.clone(),
            status: m.status.clone(),
            status_text: m.status_text.clone(),
            bio: m.bio.clone(),
            avatar_etag: None,
            desktop_notifications: m.desktop_notifications.clone(),
        };
        let changes = rv_core::account::basic_info_changes(&core(&before), &core(&after));
        if changes.is_empty() {
            return Ok(());
        }
        if rv_core::account::needs_password(&changes) && password.as_deref().unwrap_or_default().is_empty() {
            return Err(RvError::local("password-needed"));
        }
        let two_factor = method.zip(code).map(|(m, c)| two_factor_code(&m, &c));
        let s = self.session.clone();
        Ok(on_tokio(async move { s.update_basic_info(changes, password.as_deref(), two_factor).await }).await?)
    }

    pub async fn set_avatar(&self, path: String, mime: String) -> Result<(), RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.set_avatar(std::path::Path::new(&path), &mime).await }).await?)
    }

    pub async fn reset_avatar(&self) -> Result<(), RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.reset_avatar().await }).await?)
    }

    /// `default`, `all`, `mention` or `nothing`: which messages notify.
    pub async fn set_desktop_notifications(&self, value: String) -> Result<(), RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.set_preference("desktopNotifications", json!(value)).await }).await?)
    }

    /// `chat.search` in a room, newest first.
    pub async fn search(&self, rid: String, text: String) -> Result<Vec<SearchHit>, RvError> {
        let s = self.session.clone();
        let found = on_tokio(async move { s.search(&rid, &text).await }).await?;
        let me = self.session.info.username.clone();
        let ctx = rv_core::markdown::Context { me: &me };
        Ok(found
            .into_iter()
            .map(|m| SearchHit {
                body: crate::markup::blocks(rv_core::markdown::render(m.md.as_deref(), m.text.as_deref(), &ctx)),
                author: m.author_name.unwrap_or_default(),
                id: m.id,
                ts: m.ts,
            })
            .collect())
    }

    /// Whether the server offers video calls (and I may start one).
    pub async fn call_available(&self) -> bool {
        let s = self.session.clone();
        on_tokio(async move { s.call_available().await }).await
    }

    /// Starts a call in the room: its link, to open in the browser.
    pub async fn start_call(&self, rid: String) -> Result<String, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.start_call(&rid).await }).await?)
    }

    /// The room's pinned messages, or the ones I starred there.
    pub async fn marked(&self, rid: String, starred: bool) -> Result<Vec<MessageItem>, RvError> {
        let s = self.session.clone();
        let rows = on_tokio(async move { s.marked(&rid, starred).await }).await?;
        let info = &self.session.info;
        Ok(rows
            .into_iter()
            .map(|r| {
                let d = rv_core::timeline::Display {
                    row: self.session.open_row(r),
                    show_header: true,
                    show_day: false,
                    gutter_time: false,
                    new_marker: false,
                };
                crate::model::message(d, &info.user_id, &info.username)
            })
            .collect())
    }
}
