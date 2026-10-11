use crate::{Chat, model::RvError, native::NativeChat, on_tokio};
use rv_core::native::social::*;
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct SocialOption {
    pub label: String,
    pub voters: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum SocialKind {
    Poll,
    GameNight,
    Image,
}
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct SocialItem {
    pub kind: SocialKind,
    pub title: String,
    pub description: String,
    pub at: Option<String>,
    pub closed: bool,
    pub multiple: bool,
    pub options: Vec<SocialOption>,
    pub going: Vec<String>,
    pub maybe: Vec<String>,
    pub declined: Vec<String>,
    pub url: Option<String>,
    pub powered_by: Option<String>,
}
pub(crate) fn social_item(s: SocialCard) -> SocialItem {
    let mut out = SocialItem {
        kind: SocialKind::Image,
        title: String::new(),
        description: String::new(),
        at: None,
        closed: false,
        multiple: false,
        options: vec![],
        going: vec![],
        maybe: vec![],
        declined: vec![],
        url: None,
        powered_by: None,
    };
    match s {
        SocialCard::Poll { question, options, multiple, closes_at, closed } => {
            out.kind = SocialKind::Poll;
            out.title = question;
            out.options = options.into_iter().map(|o| SocialOption { label: o.label, voters: o.voters }).collect();
            out.multiple = multiple;
            out.at = closes_at;
            out.closed = closed;
        }
        SocialCard::GameNight { title, starts_at, description, going, maybe, declined } => {
            out.kind = SocialKind::GameNight;
            out.title = title;
            out.at = Some(starts_at);
            out.description = description;
            out.going = going;
            out.maybe = maybe;
            out.declined = declined;
        }
        SocialCard::Image { title, url, powered_by, .. } => {
            out.title = title;
            out.url = Some(url);
            out.powered_by = powered_by;
        }
    }
    out
}
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct SocialMediaItem {
    pub id: String,
    pub title: String,
    pub url: String,
}
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct VoiceBurst {
    pub id: String,
    pub user_id: String,
    pub emoji: String,
}
fn error(e: impl std::fmt::Display) -> RvError {
    RvError::local(e.to_string())
}
fn timestamp(value: i64) -> Result<String, RvError> {
    chrono::DateTime::<chrono::Utc>::from_timestamp(value, 0)
        .map(|d| d.to_rfc3339())
        .ok_or_else(|| RvError::local("Invalid date"))
}
#[uniffi::export]
impl NativeChat {
    pub fn social_available(&self, room: String) -> bool {
        self.session.can_social(&room)
    }
    // Flat, labelled arguments keep the native Swift API straightforward.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_poll(
        &self,
        room: String,
        root: Option<String>,
        operation: String,
        question: String,
        options: Vec<String>,
        multiple: bool,
        closes_at: Option<i64>,
    ) -> Result<(), RvError> {
        let s = self.session.clone();
        let input = CreateSocial::Poll {
            operation_id: operation,
            question,
            options,
            multiple,
            closes_at: closes_at.map(timestamp).transpose()?,
            reply_to: root,
        };
        on_tokio(async move { s.create_social(&room, &input).await }).await.map_err(error)
    }
    pub async fn create_game_night(
        &self,
        room: String,
        root: Option<String>,
        operation: String,
        title: String,
        description: String,
        starts_at: i64,
    ) -> Result<(), RvError> {
        let s = self.session.clone();
        let input = CreateSocial::GameNight {
            operation_id: operation,
            title,
            description,
            starts_at: timestamp(starts_at)?,
            reply_to: root,
        };
        on_tokio(async move { s.create_social(&room, &input).await }).await.map_err(error)
    }
    pub async fn answer_social(&self, id: String, operation: String, choices: Vec<u32>) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.answer_social(&id, &AnswerSocial { operation_id: operation, choices }).await })
            .await
            .map_err(error)
    }
    pub async fn close_poll(&self, id: String, operation: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.close_poll(&id, &ClosePoll { operation_id: operation }).await }).await.map_err(error)
    }
    pub async fn social_gifs(&self, query: String) -> Result<Vec<SocialMediaItem>, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.gifs(&query).await })
            .await
            .map_err(error)?
            .into_iter()
            .map(|i| SocialMediaItem { id: i.id, title: i.title, url: i.url })
            .collect())
    }
    pub async fn social_stickers(&self) -> Result<Vec<SocialMediaItem>, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.stickers().await })
            .await
            .map_err(error)?
            .into_iter()
            .map(|i| SocialMediaItem { id: i.id, title: i.name, url: i.url })
            .collect())
    }
    pub async fn save_sticker(&self, operation: String, title: String, url: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.save_sticker(&SaveSticker { operation_id: operation, name: title, url }).await })
            .await
            .map_err(error)
    }
    pub async fn remove_sticker(&self, id: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.remove_sticker(&id).await }).await.map_err(error)
    }
    pub async fn send_social_image(
        &self,
        room: String,
        root: Option<String>,
        operation: String,
        title: String,
        url: String,
    ) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move {
            s.send_image(&room, &SendImage { operation_id: operation, title, url, reply_to: root }).await
        })
        .await
        .map_err(error)
    }
    pub async fn react_voice(&self, room: String, emoji: String, operation: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.react_voice(&room, &emoji, &operation).await }).await.map_err(error)
    }
    pub fn voice_reactions(&self, room: String) -> Vec<VoiceBurst> {
        self.session
            .voice_reactions(&room)
            .into_iter()
            .map(|r| VoiceBurst { id: r.id, user_id: r.user_id, emoji: r.emoji })
            .collect()
    }
}
#[uniffi::export]
impl Chat {
    pub async fn social_gifs(&self, room: String, query: String) -> Result<Vec<SocialMediaItem>, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.gif_previews(&room, &query).await })
            .await
            .map_err(error)?
            .into_iter()
            .map(|i| SocialMediaItem { id: i.id, title: "GIF".into(), url: i.value })
            .collect())
    }
    pub fn social_stickers(&self) -> Result<Vec<SocialMediaItem>, RvError> {
        Ok(self
            .session
            .stickers()
            .map_err(error)?
            .into_iter()
            .map(|i| SocialMediaItem { id: i.id, title: i.name, url: i.url })
            .collect())
    }
    pub fn save_sticker(&self, operation: String, title: String, url: String) -> Result<(), RvError> {
        self.session.save_sticker(&operation, &title, &url).map_err(error)
    }
    pub fn remove_sticker(&self, id: String) -> Result<(), RvError> {
        self.session.remove_sticker(&id).map_err(error)
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn send_social_image(
        &self,
        room: String,
        root: Option<String>,
        operation: String,
        title: String,
        url: String,
        giphy_id: Option<String>,
        query: String,
    ) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move {
            if let Some(id) = giphy_id {
                s.send_gif(
                    &room,
                    &query,
                    &rv_core::social::GifPreview { id, kind: "image".into(), value: url },
                    &operation,
                    root.as_deref(),
                )
                .await
            } else {
                s.send_sticker(&room, &title, &url, &operation, root.as_deref()).await
            }
        })
        .await
        .map_err(error)
    }
}
