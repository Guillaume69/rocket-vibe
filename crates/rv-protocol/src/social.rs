//! Polls, game nights, saved image stickers and transient voice reactions.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct PollOption {
    pub label: String,
    pub voters: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SocialCard {
    Poll {
        question: String,
        options: Vec<PollOption>,
        multiple: bool,
        closes_at: Option<String>,
        closed: bool,
    },
    GameNight {
        title: String,
        starts_at: String,
        description: String,
        going: Vec<String>,
        maybe: Vec<String>,
        declined: Vec<String>,
    },
    Image {
        title: String,
        url: String,
        width: u32,
        height: u32,
        source: Option<String>,
        powered_by: Option<String>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum CreateSocial {
    Poll {
        operation_id: String,
        question: String,
        options: Vec<String>,
        multiple: bool,
        closes_at: Option<String>,
        #[serde(default)]
        reply_to: Option<String>,
    },
    GameNight {
        operation_id: String,
        title: String,
        starts_at: String,
        description: String,
        #[serde(default)]
        reply_to: Option<String>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AnswerSocial {
    pub operation_id: String,
    pub choices: Vec<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClosePoll {
    pub operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct Sticker {
    pub id: String,
    pub name: String,
    pub url: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SaveSticker {
    pub operation_id: String,
    pub name: String,
    pub url: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SendImage {
    pub operation_id: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub reply_to: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReactVoice {
    pub operation_id: String,
    pub emoji: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VoiceReaction {
    pub id: String,
    pub room_id: String,
    pub user_id: String,
    pub emoji: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GifItem {
    pub id: String,
    pub title: String,
    pub url: String,
    pub width: u32,
    pub height: u32,
    pub source: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SocialContract {
    pub gif_list: GifList,
    pub sticker_list: StickerList,
    pub create: CreateSocial,
    pub answer: AnswerSocial,
    pub close: ClosePoll,
    pub save_sticker: SaveSticker,
    pub send_image: SendImage,
    pub react_voice: ReactVoice,
    pub sticker: Sticker,
    pub gif: GifItem,
}

/// Public HTTPS resources only. Private authenticated file links use uploads instead.
pub fn public_image(value: &str) -> bool {
    value.len() <= 2048
        && url::Url::parse(value).is_ok_and(|u| {
            u.scheme() == "https"
                && u.username().is_empty()
                && u.password().is_none()
                && u.host_str().is_some_and(|h| {
                    h.contains('.')
                        && h != "localhost"
                        && !h.ends_with(".localhost")
                        && !h.ends_with(".local")
                        && h.parse::<std::net::IpAddr>().is_err()
                })
                && !u.query_pairs().any(|(key, _)| {
                    matches!(
                        key.as_ref(),
                        "rc_token" | "rc_uid" | "token" | "access_token"
                    )
                })
        })
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GifList {
    pub items: Vec<GifItem>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StickerList {
    pub stickers: Vec<Sticker>,
}
